-- Block 28: event dispatches are temporary reservations, not a second stock ledger.

alter table public.inventory_planned_flows
  drop constraint inventory_planned_flows_type_check;

alter table public.inventory_planned_flows
  add constraint inventory_planned_flows_type_check
  check (flow_type = any (array[
    'order_commitment'::text,
    'expected_receipt'::text,
    'planned_production'::text,
    'declared_unavailability'::text,
    'event_dispatch'::text
  ]));

create or replace function public.inventory_dispatch_event_stock_v1(
  p_operation_id uuid,
  p_order_id bigint,
  p_lines jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order record;
  v_existing_event_id bigint;
  v_event_id bigint;
  v_line jsonb;
  v_item record;
  v_inventory_item_id bigint;
  v_dispatched numeric;
  v_committed numeric;
  v_reserved_excess numeric;
  v_lines_payload jsonb := '[]'::jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id=v_actor and role_row.role in ('admin'::public.user_role,'master'::public.user_role)
  ) then
    raise exception 'Solo Master o administracion pueden registrar un despacho de evento.' using errcode='42501';
  end if;
  if p_operation_id is null or p_order_id is null then
    raise exception 'operation_id y order_id son obligatorios.' using errcode='22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array'
    or jsonb_array_length(p_lines) not between 1 and 100 then
    raise exception 'El despacho requiere entre 1 y 100 lineas.' using errcode='22023';
  end if;
  if exists (
    select 1 from (
      select (line.value->>'inventory_item_id')::bigint as item_id,count(*)
      from jsonb_array_elements(p_lines) line(value)
      group by 1 having count(*)>1
    ) duplicate
  ) then
    raise exception 'Un item no puede repetirse en el despacho.' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory_event_order:'||p_order_id::text,0));

  select event.id into v_existing_event_id
  from public.order_timeline_events event
  where event.event_type='inventory_event_dispatched'
    and event.payload->>'dispatch_operation_id'=p_operation_id::text
  order by event.id desc limit 1;
  if v_existing_event_id is not null then
    return jsonb_build_object('status','replayed','event_id',v_existing_event_id,'order_id',p_order_id);
  end if;

  if exists (
    select 1 from public.order_timeline_events dispatch
    where dispatch.order_id=p_order_id
      and dispatch.event_type='inventory_event_dispatched'
      and not exists (
        select 1 from public.order_timeline_events reconciliation
        where reconciliation.order_id=p_order_id
          and reconciliation.event_type='inventory_event_reconciled'
          and reconciliation.payload->>'dispatch_operation_id'=dispatch.payload->>'dispatch_operation_id'
      )
  ) then
    raise exception 'La orden ya tiene un despacho de evento pendiente de conciliar.' using errcode='22023';
  end if;

  select order_row.id,order_row.order_number,order_row.status::text as status
  into v_order from public.orders order_row where order_row.id=p_order_id for update;
  if not found then raise exception 'La orden no existe.' using errcode='P0002'; end if;
  if v_order.status in ('cancelled','delivered') then
    raise exception 'Una orden cancelada o entregada no admite un nuevo despacho.' using errcode='22023';
  end if;

  perform 1 from public.inventory_items item
  where item.id in (select (line.value->>'inventory_item_id')::bigint from jsonb_array_elements(p_lines) line(value))
  order by item.id for update;

  for v_line in select line.value from jsonb_array_elements(p_lines) line(value)
  loop
    v_inventory_item_id := (v_line->>'inventory_item_id')::bigint;
    v_dispatched := (v_line->>'quantity_units')::numeric;
    if v_dispatched<=0 then raise exception 'Cada cantidad despachada debe ser positiva.' using errcode='22023'; end if;
    select item.* into v_item from public.inventory_items item
    where item.id=v_inventory_item_id and item.is_active and item.merged_into_item_id is null
      and item.tracking_mode<>'not_tracked';
    if not found then raise exception 'Uno de los items no esta activo o no es controlable.' using errcode='22023'; end if;
    if not app_private.inventory_item_is_initialized_v1(v_inventory_item_id) then
      raise exception 'El item % requiere apertura antes del despacho.',v_item.name using errcode='22023';
    end if;

    select coalesce(sum(flow.quantity_units),0) into v_committed
    from public.inventory_planned_flows flow
    where flow.order_id=p_order_id and flow.inventory_item_id=v_inventory_item_id
      and flow.flow_type='order_commitment' and flow.status in ('draft','active');
    v_reserved_excess := greatest(v_dispatched-v_committed,0);
    if v_reserved_excess>0 then
      insert into public.inventory_planned_flows(
        inventory_item_id,flow_type,quantity_units,effective_at,status,order_id,notes,
        created_by_user_id,operation_id,capture_details
      ) values (
        v_inventory_item_id,'event_dispatch',v_reserved_excess,now(),'active',p_order_id,
        nullif(btrim(p_notes),''),v_actor,p_operation_id,
        jsonb_build_object('dispatched_quantity_units',v_dispatched,'committed_quantity_units',v_committed)
      );
    end if;
    v_lines_payload := v_lines_payload || jsonb_build_array(jsonb_build_object(
      'inventory_item_id',v_inventory_item_id,'inventory_item_name',v_item.name,'unit_name',v_item.unit_name,
      'dispatched_quantity_units',v_dispatched,'committed_quantity_units',v_committed,
      'reserved_excess_units',v_reserved_excess
    ));
  end loop;

  insert into public.order_timeline_events(
    order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload
  ) values (
    p_order_id,v_order.order_number,'inventory_event_dispatched','inventory',
    'Mercancia despachada para evento',
    'El despacho queda reservado hasta registrar lo vendido, lo devuelto y las perdidas.',
    'info',v_actor,jsonb_build_object(
      'dispatch_operation_id',p_operation_id,'lines',v_lines_payload,'notes',nullif(btrim(p_notes),''),
      'non_blocking',true
    )
  ) returning id into v_event_id;

  insert into public.order_timeline_event_recipients(event_id,target_role,target_user_id,requires_action)
  values (v_event_id,'master',null,false),(v_event_id,'admin',null,false);

  return jsonb_build_object('status','applied','event_id',v_event_id,'order_id',p_order_id,'lines',v_lines_payload);
end;
$$;

revoke all on function public.inventory_dispatch_event_stock_v1(uuid,bigint,jsonb,text) from public,anon;
grant execute on function public.inventory_dispatch_event_stock_v1(uuid,bigint,jsonb,text) to authenticated,service_role;

create or replace function public.inventory_reconcile_event_stock_v1(
  p_operation_id uuid,
  p_dispatch_operation_id uuid,
  p_lines jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_dispatch record;
  v_order record;
  v_existing_event_id bigint;
  v_event_id bigint;
  v_dispatch_line jsonb;
  v_result_line jsonb;
  v_item_id bigint;
  v_dispatched numeric;
  v_committed numeric;
  v_returned numeric;
  v_lost numeric;
  v_consumed numeric;
  v_loss_kind text;
  v_has_mismatch boolean := false;
  v_lines_payload jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'Autenticacion requerida.' using errcode='42501'; end if;
  if not exists (select 1 from public.user_roles role_row where role_row.user_id=v_actor
    and role_row.role in ('admin'::public.user_role,'master'::public.user_role)) then
    raise exception 'Solo Master o administracion pueden conciliar un evento.' using errcode='42501';
  end if;
  if p_operation_id is null or p_dispatch_operation_id is null then
    raise exception 'Las claves de operacion son obligatorias.' using errcode='22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'La conciliacion no es valida.' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_dispatch_operation_id::text,0));

  select event.id into v_existing_event_id from public.order_timeline_events event
  where event.event_type='inventory_event_reconciled' and event.payload->>'reconciliation_operation_id'=p_operation_id::text
  order by event.id desc limit 1;
  if v_existing_event_id is not null then return jsonb_build_object('status','replayed','event_id',v_existing_event_id); end if;

  select event.id,event.order_id,event.order_number,event.payload into v_dispatch
  from public.order_timeline_events event
  where event.event_type='inventory_event_dispatched'
    and event.payload->>'dispatch_operation_id'=p_dispatch_operation_id::text
  order by event.id desc limit 1 for update;
  if not found then raise exception 'El despacho indicado no existe.' using errcode='P0002'; end if;
  if exists (select 1 from public.order_timeline_events event where event.event_type='inventory_event_reconciled'
    and event.payload->>'dispatch_operation_id'=p_dispatch_operation_id::text) then
    raise exception 'El despacho ya fue conciliado.' using errcode='22023';
  end if;
  if jsonb_array_length(p_lines)<>jsonb_array_length(v_dispatch.payload->'lines') then
    raise exception 'Debes conciliar todos los items del despacho.' using errcode='22023';
  end if;
  if exists (select 1 from (select (line.value->>'inventory_item_id')::bigint,count(*) from jsonb_array_elements(p_lines) line(value) group by 1 having count(*)>1) duplicate) then
    raise exception 'Un item no puede repetirse en la conciliacion.' using errcode='22023';
  end if;

  select order_row.id,order_row.order_number into v_order from public.orders order_row where order_row.id=v_dispatch.order_id for update;
  for v_dispatch_line in select line.value from jsonb_array_elements(v_dispatch.payload->'lines') line(value)
  loop
    v_item_id := (v_dispatch_line->>'inventory_item_id')::bigint;
    v_dispatched := (v_dispatch_line->>'dispatched_quantity_units')::numeric;
    v_committed := (v_dispatch_line->>'committed_quantity_units')::numeric;
    select line.value into v_result_line from jsonb_array_elements(p_lines) line(value)
    where (line.value->>'inventory_item_id')::bigint=v_item_id limit 1;
    if v_result_line is null then raise exception 'Falta conciliar uno de los items.' using errcode='22023'; end if;
    v_returned := coalesce((v_result_line->>'returned_quantity_units')::numeric,0);
    v_lost := coalesce((v_result_line->>'loss_quantity_units')::numeric,0);
    v_loss_kind := lower(btrim(coalesce(v_result_line->>'loss_kind','damage')));
    if v_returned<0 or v_lost<0 or v_returned+v_lost>v_dispatched then
      raise exception 'Las devoluciones y perdidas deben estar entre cero y lo despachado.' using errcode='22023';
    end if;
    if v_loss_kind not in ('damage','waste') then raise exception 'La perdida debe ser averia o merma.' using errcode='22023'; end if;
    v_consumed := v_dispatched-v_returned-v_lost;
    v_has_mismatch := v_has_mismatch or v_consumed<>v_committed;
    if v_lost>0 then
      perform app_private.inventory_apply_delta_v1(
        p_operation_id,v_item_id,v_loss_kind,-v_lost,'event_loss',
        coalesce(nullif(btrim(p_notes),''),'Perdida conciliada al regresar de un evento.'),
        v_dispatch.order_id,null,v_actor,null
      );
    end if;
    v_lines_payload := v_lines_payload || jsonb_build_array(jsonb_build_object(
      'inventory_item_id',v_item_id,'inventory_item_name',v_dispatch_line->>'inventory_item_name',
      'dispatched_quantity_units',v_dispatched,'returned_quantity_units',v_returned,
      'loss_quantity_units',v_lost,'loss_kind',case when v_lost>0 then v_loss_kind else null end,
      'consumed_quantity_units',v_consumed,'committed_quantity_units',v_committed,
      'commitment_matches',v_consumed=v_committed
    ));
  end loop;

  update public.inventory_planned_flows flow set status='fulfilled',resolved_by_user_id=v_actor,
    resolved_at=now(),updated_at=now(),capture_details=flow.capture_details||jsonb_build_object(
      'reconciliation_operation_id',p_operation_id,'reconciled_at',now())
  where flow.operation_id=p_dispatch_operation_id and flow.flow_type='event_dispatch' and flow.status='active';

  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(v_dispatch.order_id,v_dispatch.order_number,'inventory_event_reconciled','inventory',
    case when v_has_mismatch then 'Evento conciliado con diferencia' else 'Evento conciliado' end,
    case when v_has_mismatch then 'La operacion continuo sin bloqueo; la cantidad consumida no coincide con el compromiso de la orden.'
      else 'Se registraron devoluciones y perdidas del evento.' end,
    case when v_has_mismatch then 'warning' else 'info' end,v_actor,jsonb_build_object(
      'reconciliation_operation_id',p_operation_id,'dispatch_operation_id',p_dispatch_operation_id,
      'lines',v_lines_payload,'commitment_mismatch',v_has_mismatch,'notes',nullif(btrim(p_notes),''),'non_blocking',true
    )) returning id into v_event_id;
  insert into public.order_timeline_event_recipients(event_id,target_role,target_user_id,requires_action)
  values(v_event_id,'master',null,v_has_mismatch),(v_event_id,'admin',null,v_has_mismatch);

  return app_private.inventory_operation_result_v1(p_operation_id)||jsonb_build_object(
    'status','applied','event_id',v_event_id,'order_id',v_dispatch.order_id,'lines',v_lines_payload,
    'commitment_mismatch',v_has_mismatch,'orders_blocked',false
  );
end;
$$;

revoke all on function public.inventory_reconcile_event_stock_v1(uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.inventory_reconcile_event_stock_v1(uuid,uuid,jsonb,text) to authenticated,service_role;

comment on function public.inventory_dispatch_event_stock_v1(uuid,bigint,jsonb,text) is
  'Master/Admin command that reserves only event excess beyond an existing order commitment and records the full dispatch in the order timeline.';
comment on function public.inventory_reconcile_event_stock_v1(uuid,uuid,jsonb,text) is
  'Master/Admin event reconciliation: returns release reservations, losses change stock, and commitment differences warn without blocking.';

-- Active event excess is unavailable until reconciliation.
create or replace function app_private.inventory_item_capacity_v1(
  p_inventory_item_id bigint,
  p_target_at timestamptz,
  p_exclude_order_id bigint default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_item record;
  v_target_at timestamptz;
  v_horizon_end timestamptz := now() + interval '10 days';
  v_available numeric;
  v_available_without_incoming numeric;
  v_minimum_at timestamptz;
  v_incoming_through_target numeric;
  v_committed_through_target numeric;
begin
  if p_target_at is null then
    raise exception 'La fecha objetivo es obligatoria.' using errcode = '22023';
  end if;

  select item.id, item.name, item.current_stock_units
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if not found then
    raise exception 'Ítem de inventario % no encontrado.', p_inventory_item_id
      using errcode = '22023';
  end if;

  v_target_at := greatest(p_target_at, now());

  if v_target_at > v_horizon_end then
    return jsonb_build_object(
      'status', 'outside_horizon',
      'inventory_item_id', v_item.id,
      'inventory_item_name', v_item.name,
      'target_at', v_target_at,
      'horizon_ends_at', v_horizon_end,
      'on_hand_units', v_item.current_stock_units,
      'available_without_affecting_commitments', null
    );
  end if;

  if not app_private.inventory_item_is_initialized_v1(v_item.id) then
    return jsonb_build_object(
      'status', 'requires_opening',
      'inventory_item_id', v_item.id,
      'inventory_item_name', v_item.name,
      'target_at', v_target_at,
      'horizon_ends_at', v_horizon_end,
      'on_hand_units', v_item.current_stock_units,
      'available_without_affecting_commitments', null
    );
  end if;

  with relevant_flows as (
    select
      flow.effective_at,
      case
        when flow.flow_type in ('order_commitment', 'event_dispatch') then -flow.quantity_units
        else flow.quantity_units
      end as delta_with_incoming,
      case
        when flow.flow_type in ('order_commitment', 'event_dispatch') then -flow.quantity_units
        else 0::numeric
      end as delta_without_incoming,
      case
        when flow.flow_type in ('expected_receipt', 'planned_production')
        then flow.quantity_units
        else 0::numeric
      end as incoming_units,
      case
        when flow.flow_type = 'order_commitment' then flow.quantity_units
        else 0::numeric
      end as commitment_units
    from public.inventory_planned_flows flow
    where flow.inventory_item_id = v_item.id
      and flow.effective_at is not null
      and flow.effective_at <= v_horizon_end
      and (p_exclude_order_id is null or flow.order_id is distinct from p_exclude_order_id)
      and (
        (
          flow.flow_type = 'order_commitment'
          and flow.status in ('draft', 'active')
        )
        or (
          flow.flow_type in ('expected_receipt', 'planned_production', 'event_dispatch')
          and flow.status = 'active'
        )
      )
  ),
  events as (
    select
      flow.effective_at,
      sum(flow.delta_with_incoming) as delta_with_incoming,
      sum(flow.delta_without_incoming) as delta_without_incoming
    from relevant_flows flow
    group by flow.effective_at
  ),
  checkpoints as (
    select v_target_at as checkpoint_at
    union
    select event.effective_at
    from events event
    where event.effective_at > v_target_at
  ),
  balances as (
    select
      checkpoint.checkpoint_at,
      v_item.current_stock_units + coalesce((
        select sum(event.delta_with_incoming)
        from events event
        where event.effective_at <= checkpoint.checkpoint_at
      ), 0) as balance_with_incoming,
      v_item.current_stock_units + coalesce((
        select sum(event.delta_without_incoming)
        from events event
        where event.effective_at <= checkpoint.checkpoint_at
      ), 0) as balance_without_incoming
    from checkpoints checkpoint
  )
  select
    greatest(min(balance.balance_with_incoming), 0),
    greatest(min(balance.balance_without_incoming), 0),
    (array_agg(balance.checkpoint_at order by balance.balance_with_incoming, balance.checkpoint_at))[1],
    coalesce((
      select sum(flow.incoming_units)
      from relevant_flows flow
      where flow.effective_at <= v_target_at
    ), 0),
    coalesce((
      select sum(flow.commitment_units)
      from relevant_flows flow
      where flow.effective_at <= v_target_at
    ), 0)
  into
    v_available,
    v_available_without_incoming,
    v_minimum_at,
    v_incoming_through_target,
    v_committed_through_target
  from balances balance;

  return jsonb_build_object(
    'status', 'evaluated',
    'inventory_item_id', v_item.id,
    'inventory_item_name', v_item.name,
    'target_at', v_target_at,
    'horizon_ends_at', v_horizon_end,
    'on_hand_units', v_item.current_stock_units,
    'available_without_affecting_commitments', v_available,
    'available_without_incoming', v_available_without_incoming,
    'minimum_projected_at', v_minimum_at,
    'incoming_through_target', v_incoming_through_target,
    'committed_through_target', v_committed_through_target
  );
end;
$$;

revoke all on function app_private.inventory_item_capacity_v1(bigint, timestamptz, bigint)
  from public, anon, authenticated;
-- Kitchen loss reporting follows the same non-blocking stock rule.
create or replace function public.inventory_record_loss_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_loss_kind text,
  p_quantity_units numeric,
  p_reason_code text default null,
  p_notes text default null,
  p_inventory_lot_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role in ('admin', 'kitchen')
  ) then
    raise exception 'Solo cocina o administración pueden reportar pérdidas.' using errcode = '42501';
  end if;

  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;

  if p_loss_kind not in ('damage', 'waste', 'quality_taste') then
    raise exception 'Tipo de pérdida inválido.' using errcode = '22023';
  end if;

  if p_quantity_units is null or p_quantity_units <= 0 then
    raise exception 'La cantidad debe ser mayor que cero.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  if exists (
    select 1 from public.inventory_movements m where m.operation_id = p_operation_id
  ) then
    if not exists (
      select 1 from public.inventory_movements m
      where m.operation_id = p_operation_id and m.movement_type = p_loss_kind
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object('status', 'replayed');
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.';
  end if;

  if not app_private.inventory_item_is_initialized_v1(p_inventory_item_id) then
    raise exception 'El ítem requiere un conteo de apertura antes de registrar pérdidas.';
  end if;

  -- Loss reporting is a physical fact. Insufficient recorded stock is exposed
  -- as a negative balance and alert; it never blocks the report.

  if p_inventory_lot_id is not null and not exists (
    select 1
    from public.inventory_lots lot
    where lot.id = p_inventory_lot_id
      and lot.inventory_item_id = p_inventory_item_id
      and lot.status = 'open'
  ) then
    raise exception 'El lote no pertenece al ítem o no está abierto.';
  end if;

  perform app_private.inventory_apply_delta_v1(
    p_operation_id,
    p_inventory_item_id,
    p_loss_kind,
    -p_quantity_units,
    coalesce(nullif(btrim(p_reason_code), ''), p_loss_kind),
    p_notes,
    null,
    p_inventory_lot_id,
    v_actor,
    null
  );

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object('status', 'applied');
end;
$$;

revoke all on function public.inventory_record_loss_v1(
  uuid, bigint, text, numeric, text, text, bigint
) from public, anon;
grant execute on function public.inventory_record_loss_v1(
  uuid, bigint, text, numeric, text, text, bigint
) to authenticated;
