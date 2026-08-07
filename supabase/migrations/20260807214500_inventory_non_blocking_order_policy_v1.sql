-- Block 8: inventory is advisory for order flow and never blocks an order.
-- Reuses the existing order timeline as the incident channel. No tables or
-- columns are added by this migration.

create or replace function app_private.inventory_record_order_issue_v1(
  p_order_id bigint,
  p_event_type text,
  p_stage text,
  p_title text,
  p_message text,
  p_severity text,
  p_actor_user_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id bigint;
  v_order_number text;
begin
  select order_row.order_number
  into v_order_number
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    return null;
  end if;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  )
  values (
    p_order_id,
    v_order_number,
    coalesce(nullif(btrim(p_event_type), ''), 'inventory_sync_issue'),
    'inventory',
    coalesce(nullif(btrim(p_title), ''), 'Incidencia de inventario'),
    nullif(btrim(p_message), ''),
    case
      when p_severity in ('info', 'warning', 'critical') then p_severity
      else 'warning'
    end,
    p_actor_user_id,
    coalesce(p_payload, '{}'::jsonb)
      || jsonb_build_object(
        'source', 'inventory_engine',
        'stage', coalesce(nullif(btrim(p_stage), ''), 'unknown'),
        'non_blocking', true
      )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  values
    (v_event_id, 'master', null, true),
    (v_event_id, 'admin', null, true);

  return v_event_id;
exception when others then
  raise warning 'No se pudo registrar la incidencia de inventario para la orden %: [%] %',
    p_order_id, sqlstate, sqlerrm;
  return null;
end;
$$;

revoke all on function app_private.inventory_record_order_issue_v1(
  bigint, text, text, text, text, text, uuid, jsonb
) from public, anon, authenticated, service_role;

-- Internal engine shared by the strict RPC and the tolerant trigger. Stock is
-- never driven negative automatically; the trigger catches shortages and
-- records them as incidents without rolling the order back.
create or replace function app_private.inventory_commit_order_sale_core_v1(
  p_operation_id uuid,
  p_order_id bigint,
  p_notes text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_resolution jsonb;
  v_item_ids bigint[];
  v_line record;
  v_existing_operation uuid;
  v_shortages jsonb := '[]'::jsonb;
  v_first_shortage_name text;
begin
  if p_operation_id is null or p_order_id is null then
    raise exception 'operation_id y order_id son obligatorios.' using errcode = '22023';
  end if;

  if p_actor_user_id is null then
    raise exception 'No se pudo identificar al responsable del consumo.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_order_sale:' || p_order_id::text, 0)
  );

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.operation_id = p_operation_id
  ) then
    if exists (
      select 1
      from public.inventory_movements movement
      where movement.operation_id = p_operation_id
        and (
          movement.movement_type <> 'sale_out'
          or movement.order_id is distinct from p_order_id
        )
    ) then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;

    return app_private.inventory_operation_result_v1(p_operation_id)
      || jsonb_build_object(
        'status', 'replayed',
        'order_id', p_order_id,
        'shortages', '[]'::jsonb
      );
  end if;

  select order_row.status::text
  into v_status
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if v_status <> 'delivered' then
    raise exception 'La venta solo puede consumirse cuando la orden está entregada; estado actual: %.', v_status
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.order_id = p_order_id
      and movement.movement_type = 'sale_out'
      and movement.operation_id is null
  ) then
    raise exception 'La orden ya tiene un descuento legado; se evitó un descuento canónico duplicado.';
  end if;

  select movement.operation_id
  into v_existing_operation
  from public.inventory_movements movement
  where movement.order_id = p_order_id
    and movement.movement_type = 'sale_out'
    and movement.operation_id is not null
    and exists (
      select 1
      from public.inventory_movements original
      where original.operation_id = movement.operation_id
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversal_of_movement_id = original.id
        )
    )
  order by movement.created_at desc, movement.id desc
  limit 1;

  if v_existing_operation is not null then
    raise exception 'La orden ya fue descontada por la operación canónica %.', v_existing_operation;
  end if;

  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);

  select array_agg(resolved.inventory_item_id order by resolved.inventory_item_id)
  into v_item_ids
  from (
    select distinct (line.value ->> 'inventory_item_id')::bigint as inventory_item_id
    from jsonb_array_elements(v_resolution -> 'lines') line(value)
  ) resolved;

  if coalesce(cardinality(v_item_ids), 0) = 0 then
    return jsonb_build_object(
      'status', 'no_inventory_effect',
      'order_id', p_order_id,
      'operation_id', p_operation_id,
      'resolution', v_resolution,
      'shortages', '[]'::jsonb
    );
  end if;

  perform 1
  from public.inventory_items inventory_item
  where inventory_item.id = any(v_item_ids)
  order by inventory_item.id
  for update;

  if (
    select count(*)
    from public.inventory_items inventory_item
    where inventory_item.id = any(v_item_ids)
  ) <> cardinality(v_item_ids) then
    raise exception 'La resolución contiene ítems de inventario inexistentes.';
  end if;

  if exists (
    select 1
    from public.inventory_items inventory_item
    where inventory_item.id = any(v_item_ids)
      and (
        not inventory_item.is_active
        or inventory_item.tracking_mode = 'not_tracked'
        or inventory_item.merged_into_item_id is not null
      )
  ) then
    raise exception 'La resolución contiene un ítem de inventario no operativo.';
  end if;

  if exists (
    select 1
    from unnest(v_item_ids) item_id
    where not app_private.inventory_item_is_initialized_v1(item_id)
  ) then
    raise exception 'Todos los ítems consumidos requieren un conteo de apertura.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'inventory_item_id', inventory_item.id,
        'inventory_item_name', inventory_item.name,
        'stock_units', inventory_item.current_stock_units,
        'required_units', (line.value ->> 'quantity_units')::numeric,
        'deficit_units', (line.value ->> 'quantity_units')::numeric - inventory_item.current_stock_units
      )
      order by inventory_item.id
    ),
    '[]'::jsonb
  )
  into v_shortages
  from jsonb_array_elements(v_resolution -> 'lines') line(value)
  join public.inventory_items inventory_item
    on inventory_item.id = (line.value ->> 'inventory_item_id')::bigint
  where inventory_item.current_stock_units < (line.value ->> 'quantity_units')::numeric;

  if jsonb_array_length(v_shortages) > 0 then
    v_first_shortage_name := v_shortages -> 0 ->> 'inventory_item_name';
    raise exception 'Existencia insuficiente para completar la venta: %.', v_first_shortage_name;
  end if;

  for v_line in
    select
      (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
      (line.value ->> 'quantity_units')::numeric as quantity_units
    from jsonb_array_elements(v_resolution -> 'lines') line(value)
    order by (line.value ->> 'inventory_item_id')::bigint
  loop
    perform app_private.inventory_apply_delta_v1(
      p_operation_id,
      v_line.inventory_item_id,
      'sale_out',
      -v_line.quantity_units,
      'order_delivery',
      coalesce(nullif(btrim(p_notes), ''), format('Consumo canónico de la orden %s.', p_order_id)),
      p_order_id,
      null,
      p_actor_user_id,
      null
    );
  end loop;

  return app_private.inventory_operation_result_v1(p_operation_id)
    || jsonb_build_object(
      'status', 'applied',
      'order_id', p_order_id,
      'resolution', v_resolution,
      'shortages', v_shortages
    );
end;
$$;

revoke all on function app_private.inventory_commit_order_sale_core_v1(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role;

-- The explicit command preserves the current authorization boundary and stays
-- strict. Only the trusted order trigger uses the non-blocking variant.
create or replace function public.inventory_commit_order_sale_v1(
  p_operation_id uuid,
  p_order_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_master_or_admin boolean;
  v_is_counter boolean;
  v_source text;
  v_fulfillment text;
  v_last_modified_by uuid;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select
    exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
    ),
    exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'counter'::public.user_role
    )
  into v_is_master_or_admin, v_is_counter;

  if not v_is_master_or_admin and not v_is_counter then
    raise exception 'Solo administración, Master o el mostrador autorizado pueden confirmar una venta.'
      using errcode = '42501';
  end if;

  select
    order_row.source::text,
    order_row.fulfillment::text,
    order_row.last_modified_by
  into v_source, v_fulfillment, v_last_modified_by
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if not v_is_master_or_admin and (
    v_source <> 'walk_in'
    or v_fulfillment <> 'pickup'
    or v_last_modified_by is distinct from v_actor
  ) then
    raise exception 'Mostrador solo puede cerrar el consumo de su retiro walk-in.' using errcode = '42501';
  end if;

  return app_private.inventory_commit_order_sale_core_v1(
    p_operation_id,
    p_order_id,
    p_notes,
    v_actor
  );
end;
$$;

revoke all on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  from public, anon;
grant execute on function public.inventory_commit_order_sale_v1(uuid, bigint, text)
  to authenticated;

-- Snapshot errors become traceable issues instead of rejecting an order item.
create or replace function app_private.inventory_order_item_snapshot_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  begin
    perform app_private.inventory_sync_order_item_components_v1(new.id);
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      new.order_id,
      'inventory_snapshot_sync_failed',
      'order_item_snapshot',
      'Composición de inventario pendiente',
      'La partida se guardó sin bloqueo, pero su composición inventariable requiere revisión.',
      'warning',
      auth.uid(),
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_item_id', new.id,
        'product_id', new.product_id,
        'trigger_operation', tg_op
      )
    );
  end;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_snapshot_trigger_v1()
  from public, anon, authenticated, service_role;

-- Refreshing commitments after an item edit is also advisory.
create or replace function app_private.inventory_order_item_commitment_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id bigint;
  v_order record;
  v_actor uuid;
  v_caller uuid := auth.uid();
  v_caller_can_refresh boolean := false;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;

  begin
    select
      order_row.source::text as source,
      order_row.status::text as status,
      order_row.needs_reapproval,
      order_row.queued_needs_reapproval,
      order_row.last_modified_by,
      order_row.sent_to_kitchen_by,
      order_row.created_by_user_id
    into v_order
    from public.orders order_row
    where order_row.id = v_order_id;

    if found then
      v_caller_can_refresh := v_order.source = 'walk_in'
        or exists (
          select 1
          from public.user_roles role_row
          where role_row.user_id = v_caller
            and role_row.role in (
              'admin'::public.user_role,
              'master'::public.user_role
            )
        );

      if v_caller_can_refresh
        and v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
        and not coalesce(v_order.needs_reapproval, false)
        and not coalesce(v_order.queued_needs_reapproval, false)
      then
        v_actor := app_private.inventory_resolve_commitment_actor_v1(
          v_order_id,
          coalesce(v_caller, v_order.last_modified_by, v_order.sent_to_kitchen_by, v_order.created_by_user_id)
        );
        perform app_private.inventory_materialize_order_commitment_v1(v_order_id, v_actor);
      end if;
    end if;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      v_order_id,
      'inventory_commitment_sync_failed',
      'order_item_change',
      'Compromiso de inventario pendiente',
      'La partida cambió sin bloqueo, pero la proyección de inventario requiere revisión.',
      'warning',
      v_caller,
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_item_id', case when tg_op = 'DELETE' then old.id else new.id end,
        'trigger_operation', tg_op
      )
    );
  end;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_commitment_trigger_v1()
  from public, anon, authenticated, service_role;

-- Approval, rescheduling, cancellation, and delivery must survive any
-- commitment-resolution issue.
create or replace function app_private.inventory_order_commitment_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_has_items boolean;
  v_has_open_commitment boolean;
  v_should_refresh boolean := false;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  begin
    v_actor := app_private.inventory_resolve_commitment_actor_v1(
      new.id,
      coalesce(auth.uid(), new.last_modified_by, new.sent_to_kitchen_by, new.created_by_user_id)
    );

    if new.status = 'delivered'::public.order_status then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'fulfilled', v_actor);
    elsif new.status in ('created'::public.order_status, 'cancelled'::public.order_status) then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    elsif coalesce(new.needs_reapproval, false)
      or coalesce(new.queued_needs_reapproval, false)
    then
      perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    elsif new.status in (
      'queued'::public.order_status,
      'confirmed'::public.order_status,
      'in_kitchen'::public.order_status,
      'ready'::public.order_status,
      'out_for_delivery'::public.order_status
    ) then
      select exists (
        select 1
        from public.order_items order_item
        where order_item.order_id = new.id
      ) into v_has_items;

      if v_has_items then
        select exists (
          select 1
          from public.inventory_planned_flows flow
          where flow.order_id = new.id
            and flow.flow_type = 'order_commitment'
            and flow.status in ('draft', 'active')
        ) into v_has_open_commitment;

        if tg_op = 'INSERT' then
          v_should_refresh := not v_has_open_commitment;
        else
          v_should_refresh := (
            old.status is distinct from new.status
            and new.status = 'queued'::public.order_status
          ) or (
            coalesce(old.needs_reapproval, false)
            and not coalesce(new.needs_reapproval, false)
          ) or (
            coalesce(old.queued_needs_reapproval, false)
            and not coalesce(new.queued_needs_reapproval, false)
          ) or (
            old.extra_fields #> '{schedule}' is distinct from new.extra_fields #> '{schedule}'
          ) or not v_has_open_commitment;
        end if;

        if v_should_refresh then
          perform app_private.inventory_materialize_order_commitment_v1(new.id, v_actor);
        end if;
      end if;
    end if;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    perform app_private.inventory_record_order_issue_v1(
      new.id,
      'inventory_commitment_sync_failed',
      'order_lifecycle',
      'Proyección de inventario pendiente',
      'La orden continuó sin bloqueo, pero su compromiso de inventario requiere revisión.',
      'warning',
      coalesce(auth.uid(), new.last_modified_by, new.sent_to_kitchen_by, new.created_by_user_id),
      jsonb_build_object(
        'sqlstate', v_sqlstate,
        'error', v_message,
        'detail', nullif(v_detail, ''),
        'order_status', new.status::text,
        'trigger_operation', tg_op
      )
    );
  end;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_commitment_trigger_v1()
  from public, anon, authenticated, service_role;

-- Automatic delivery is tolerant. A shortage is deducted and alerted; any
-- other synchronization failure is alerted and never rolls the order back.
create or replace function app_private.inventory_order_sale_cutover_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_operation_id uuid;
  v_sqlstate text;
  v_message text;
  v_detail text;
begin
  if old.status is distinct from new.status
    and new.status = 'delivered'
    and app_private.inventory_catalog_is_ready_v1()
  then
    v_actor := coalesce(
      auth.uid(),
      new.last_modified_by,
      new.sent_to_kitchen_by,
      new.created_by_user_id
    );
    v_operation_id := pg_catalog.md5(
      'vivo.inventory.order.sale.v1:' || new.id::text
    )::uuid;

    begin
      perform app_private.inventory_commit_order_sale_core_v1(
        v_operation_id,
        new.id,
        format('Consumo automático al entregar la orden %s.', new.id),
        v_actor
      );
    exception when others then
      get stacked diagnostics
        v_sqlstate = returned_sqlstate,
        v_message = message_text,
        v_detail = pg_exception_detail;

      perform app_private.inventory_record_order_issue_v1(
        new.id,
        'inventory_sale_sync_failed',
        'order_delivery',
        'Entrega sin conciliación de inventario',
        'La orden se entregó sin bloqueo, pero el consumo de inventario no pudo registrarse automáticamente.',
        'critical',
        v_actor,
        jsonb_build_object(
          'operation_id', v_operation_id,
          'sqlstate', v_sqlstate,
          'error', v_message,
          'detail', nullif(v_detail, '')
        )
      );
    end;
  end if;

  return new;
end;
$$;

revoke all on function app_private.inventory_order_sale_cutover_trigger_v1()
  from public, anon, authenticated, service_role;

comment on function app_private.inventory_record_order_issue_v1(
  bigint, text, text, text, text, text, uuid, jsonb
) is 'Records a non-blocking inventory issue in the existing order timeline for Master and administration.';
comment on function app_private.inventory_commit_order_sale_core_v1(
  uuid, bigint, text, uuid
) is 'Internal strict sale engine shared by the explicit RPC and the non-blocking delivery trigger.';
comment on function public.inventory_commit_order_sale_v1(uuid, bigint, text) is
  'Strict explicit sale command; automatic delivery uses the private non-blocking policy.';
comment on function app_private.inventory_order_sale_cutover_trigger_v1() is
  'Never blocks delivery: commits real consumption when possible and records an inventory issue otherwise.';
