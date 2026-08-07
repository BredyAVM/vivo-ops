-- Block 6: freeze the commercial composition of order items and materialize
-- approved orders as dated inventory commitments. No physical stock is moved.

set lock_timeout = '5s';
set statement_timeout = '90s';

alter table public.inventory_planned_flows
  add constraint inventory_planned_flows_order_commitment_shape_check
  check (
    flow_type <> 'order_commitment'
    or (
      order_id is not null
      and inventory_recipe_id is null
      and quantity_units is not null
      and quantity_units > 0
      and effective_at is not null
    )
  ) not valid;

alter table public.inventory_planned_flows
  validate constraint inventory_planned_flows_order_commitment_shape_check;

create unique index inventory_planned_flows_open_order_item_uidx
  on public.inventory_planned_flows (order_id, inventory_item_id)
  where flow_type = 'order_commitment'
    and status in ('draft', 'active')
    and order_id is not null;

create index inventory_planned_flows_projection_v1_idx
  on public.inventory_planned_flows (inventory_item_id, effective_at, order_id)
  where (
    flow_type = 'order_commitment'
    and status in ('draft', 'active')
  ) or (
    flow_type in ('expected_receipt', 'planned_production')
    and status = 'active'
  );

-- Parse the current structured selection markers once and freeze both fixed and
-- selected commercial components in the existing snapshot table.
create or replace function app_private.inventory_sync_order_item_components_v1(
  p_order_item_id bigint
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_item record;
  v_markers jsonb := '{}'::jsonb;
  v_counted_quantity numeric := 0;
  v_inserted integer := 0;
begin
  select
    order_item.id,
    order_item.order_id,
    order_item.product_id,
    order_item.qty,
    order_item.notes,
    product.name as product_name,
    product.detail_units_limit,
    product.is_detail_editable
  into v_order_item
  from public.order_items order_item
  join public.products product on product.id = order_item.product_id
  where order_item.id = p_order_item_id;

  if not found then
    raise exception 'order_item % no existe.', p_order_item_id using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.regexp_split_to_table(
      coalesce(v_order_item.notes, ''),
      E'\\r?\\n'
    ) split_line(line)
    where btrim(split_line.line) like '@sel|%'
      and btrim(split_line.line) !~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'
  ) then
    raise exception 'El pedido contiene una selección estructurada inválida.'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_object_agg(marker.component_product_id::text, marker.quantity),
    '{}'::jsonb
  )
  into v_markers
  from (
    select
      pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint as component_product_id,
      sum(pg_catalog.split_part(btrim(split_line.line), '|', 3)::numeric) as quantity
    from pg_catalog.regexp_split_to_table(
      coalesce(v_order_item.notes, ''),
      E'\\r?\\n'
    ) split_line(line)
    where btrim(split_line.line) ~ E'^@sel\\|[1-9][0-9]*\\|[0-9]+(\\.[0-9]+)?$'
    group by pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint
  ) marker;

  if exists (
    select 1
    from jsonb_each_text(v_markers) marker(component_product_id, quantity)
    where marker.quantity::numeric <= 0
       or not exists (
         select 1
         from public.product_components component
         where component.parent_product_id = v_order_item.product_id
           and component.component_product_id = marker.component_product_id::bigint
       )
  ) then
    raise exception 'La selección contiene un componente no permitido o una cantidad inválida.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.product_components component
    join jsonb_each_text(v_markers) marker(component_product_id, quantity)
      on marker.component_product_id::bigint = component.component_product_id
    where component.parent_product_id = v_order_item.product_id
      and component.component_mode = 'fixed'::public.product_component_mode
      and component.is_required
      and marker.quantity::numeric <> v_order_item.qty * component.quantity
  ) then
    raise exception 'La selección no coincide con uno o más componentes fijos.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.product_components component
    join jsonb_each_text(v_markers) marker(component_product_id, quantity)
      on marker.component_product_id::bigint = component.component_product_id
    where component.parent_product_id = v_order_item.product_id
      and component.component_mode = 'fixed'::public.product_component_mode
      and not component.is_required
      and marker.quantity::numeric > v_order_item.qty * component.quantity
  ) then
    raise exception 'La selección supera la cantidad permitida de un componente opcional.'
      using errcode = '22023';
  end if;

  select coalesce(sum(
    case
      when component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      then v_order_item.qty * component.quantity
      when v_markers ? component.component_product_id::text
      then (v_markers ->> component.component_product_id::text)::numeric
      else 0
    end
  ) filter (where component.counts_toward_detail_limit), 0)
  into v_counted_quantity
  from public.product_components component
  where component.parent_product_id = v_order_item.product_id;

  if v_order_item.is_detail_editable
    and v_order_item.detail_units_limit > 0
    and v_counted_quantity <> v_order_item.qty * v_order_item.detail_units_limit
  then
    raise exception '% exige % piezas seleccionadas y recibió %.',
      v_order_item.product_name,
      v_order_item.qty * v_order_item.detail_units_limit,
      v_counted_quantity
      using errcode = '22023';
  end if;

  if v_order_item.is_detail_editable
    and v_order_item.detail_units_limit = 0
    and exists (
      select 1
      from public.product_components component
      where component.parent_product_id = v_order_item.product_id
        and component.component_mode = 'selectable'::public.product_component_mode
    )
    and v_counted_quantity <= 0
  then
    raise exception '% necesita al menos una pieza seleccionada.', v_order_item.product_name
      using errcode = '22023';
  end if;

  delete from public.order_item_components snapshot
  where snapshot.order_item_id = p_order_item_id;

  insert into public.order_item_components (
    order_item_id,
    component_product_id,
    qty,
    component_name_snapshot
  )
  select
    v_order_item.id,
    component.component_product_id,
    case
      when component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      then v_order_item.qty * component.quantity
      else (v_markers ->> component.component_product_id::text)::numeric
    end,
    component_product.name
  from public.product_components component
  join public.products component_product on component_product.id = component.component_product_id
  where component.parent_product_id = v_order_item.product_id
    and (
      (
        component.component_mode = 'fixed'::public.product_component_mode
        and component.is_required
      )
      or v_markers ? component.component_product_id::text
    )
  order by component.sort_order, component.id;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function app_private.inventory_sync_order_item_components_v1(bigint)
  from public, anon, authenticated;

create or replace function app_private.inventory_order_effective_at_v1(
  p_order_id bigint
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_order record;
  v_date_text text;
  v_time_text text;
  v_asap boolean;
begin
  select order_row.id, order_row.created_at, order_row.extra_fields
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  v_date_text := nullif(btrim(v_order.extra_fields #>> '{schedule,date}'), '');
  v_time_text := nullif(btrim(v_order.extra_fields #>> '{schedule,time_24}'), '');
  v_asap := lower(coalesce(v_order.extra_fields #>> '{schedule,asap}', 'false')) = 'true';

  if v_asap then
    return now();
  end if;

  if v_date_text is null
    or v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or v_time_text is null
    or v_time_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
  then
    raise exception 'La orden % no tiene una fecha y hora de entrega válidas.', p_order_id
      using errcode = '22023';
  end if;

  return pg_catalog.timezone(
    'America/Caracas',
    (v_date_text || ' ' || v_time_text)::timestamp
  );
exception
  when datetime_field_overflow or invalid_datetime_format then
    raise exception 'La orden % no tiene una fecha y hora de entrega válidas.', p_order_id
      using errcode = '22023';
end;
$$;

revoke all on function app_private.inventory_order_effective_at_v1(bigint)
  from public, anon, authenticated;

create or replace function app_private.inventory_resolve_commitment_actor_v1(
  p_order_id bigint,
  p_preferred_actor uuid default null
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  with candidate as (
    select p_preferred_actor as user_id, 1 as priority
    union all
    select order_row.last_modified_by, 2
    from public.orders order_row where order_row.id = p_order_id
    union all
    select order_row.sent_to_kitchen_by, 3
    from public.orders order_row where order_row.id = p_order_id
    union all
    select (
      select event_row.performed_by
      from public.order_events event_row
      where event_row.order_id = p_order_id
        and event_row.event in ('approved', 'reapproved', 'queued_reapproved')
      order by event_row.id desc
      limit 1
    ), 4
    union all
    select order_row.created_by_user_id, 5
    from public.orders order_row where order_row.id = p_order_id
    union all
    select order_row.attributed_advisor_id, 6
    from public.orders order_row where order_row.id = p_order_id
    union all
    select (
      select role_row.user_id
      from public.user_roles role_row
      where role_row.role = 'admin'::public.user_role
      order by role_row.user_id
      limit 1
    ), 7
  )
  select candidate.user_id
  from candidate
  join public.profiles profile on profile.id = candidate.user_id
  where candidate.user_id is not null
  order by candidate.priority
  limit 1;
$$;

revoke all on function app_private.inventory_resolve_commitment_actor_v1(bigint, uuid)
  from public, anon, authenticated;

create or replace function app_private.inventory_close_order_commitments_v1(
  p_order_id bigint,
  p_status text,
  p_actor uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor uuid;
  v_updated integer;
begin
  if p_status not in ('cancelled', 'fulfilled') then
    raise exception 'Estado final de compromiso inválido.' using errcode = '22023';
  end if;

  v_actor := app_private.inventory_resolve_commitment_actor_v1(p_order_id, p_actor);
  if v_actor is null then
    raise exception 'No se pudo identificar al responsable del compromiso.';
  end if;

  update public.inventory_planned_flows flow
  set
    status = p_status,
    resolved_by_user_id = v_actor,
    resolved_at = now(),
    updated_at = now()
  where flow.order_id = p_order_id
    and flow.flow_type = 'order_commitment'
    and flow.status in ('draft', 'active');

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function app_private.inventory_close_order_commitments_v1(bigint, text, uuid)
  from public, anon, authenticated;

create or replace function app_private.inventory_materialize_order_commitment_v1(
  p_order_id bigint,
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order record;
  v_actor uuid;
  v_effective_at timestamptz;
  v_flow_status text;
  v_resolution jsonb;
  v_inserted integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_order_commitment:' || p_order_id::text, 0)
  );

  select
    order_row.id,
    order_row.status::text as status,
    order_row.needs_reapproval,
    order_row.queued_needs_reapproval
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if v_order.status not in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery') then
    raise exception 'La orden % no está aprobada para comprometer inventario.', p_order_id
      using errcode = '22023';
  end if;

  if coalesce(v_order.needs_reapproval, false)
    or coalesce(v_order.queued_needs_reapproval, false)
  then
    raise exception 'La orden % requiere aprobación antes de renovar su compromiso.', p_order_id
      using errcode = '22023';
  end if;

  v_actor := app_private.inventory_resolve_commitment_actor_v1(p_order_id, p_actor);
  if v_actor is null then
    raise exception 'No se pudo identificar al responsable del compromiso.';
  end if;

  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);
  v_flow_status := case
    when v_effective_at <= now() + interval '10 days' then 'active'
    else 'draft'
  end;
  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);

  perform app_private.inventory_close_order_commitments_v1(
    p_order_id,
    'cancelled',
    v_actor
  );

  insert into public.inventory_planned_flows (
    inventory_item_id,
    flow_type,
    quantity_units,
    effective_at,
    status,
    order_id,
    inventory_recipe_id,
    depends_on_flow_id,
    notes,
    created_by_user_id
  )
  select
    (line.value ->> 'inventory_item_id')::bigint,
    'order_commitment',
    (line.value ->> 'quantity_units')::numeric,
    v_effective_at,
    v_flow_status,
    p_order_id,
    null,
    null,
    'canonical_order_commitment_v1',
    v_actor
  from jsonb_array_elements(v_resolution -> 'lines') line(value)
  where (line.value ->> 'quantity_units')::numeric > 0
  order by (line.value ->> 'inventory_item_id')::bigint;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'status', 'materialized',
    'order_id', p_order_id,
    'effective_at', v_effective_at,
    'flow_status', v_flow_status,
    'line_count', v_inserted,
    'configuration_version', 1
  );
end;
$$;

revoke all on function app_private.inventory_materialize_order_commitment_v1(bigint, uuid)
  from public, anon, authenticated;

-- Capacity at a target time protects every already-approved commitment from the
-- target through the end of the ten-day horizon. Incoming plans are considered
-- only when active and can therefore be reported as an explicit dependency.
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
        when flow.flow_type = 'order_commitment' then -flow.quantity_units
        else flow.quantity_units
      end as delta_with_incoming,
      case
        when flow.flow_type = 'order_commitment' then -flow.quantity_units
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
          flow.flow_type in ('expected_receipt', 'planned_production')
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

create or replace function public.inventory_preview_order_commitment_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order record;
  v_resolution jsonb;
  v_effective_at timestamptz;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_capacity jsonb;
  v_requested numeric;
  v_available numeric;
  v_without_incoming numeric;
  v_decision text := 'available';
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  select order_row.id, order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) and not (
    v_order.attributed_advisor_id = v_actor
    and exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = v_actor
        and role_row.role = 'advisor'::public.user_role
    )
  ) then
    raise exception 'No tienes permiso para evaluar el compromiso de esta orden.'
      using errcode = '42501';
  end if;

  v_resolution := app_private.inventory_resolve_order_sale_v1(p_order_id);
  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);

  for v_line in
    select line.value
    from jsonb_array_elements(v_resolution -> 'lines') line(value)
    order by (line.value ->> 'inventory_item_id')::bigint
  loop
    v_requested := (v_line ->> 'quantity_units')::numeric;
    v_capacity := app_private.inventory_item_capacity_v1(
      (v_line ->> 'inventory_item_id')::bigint,
      v_effective_at,
      p_order_id
    );
    v_available := nullif(v_capacity ->> 'available_without_affecting_commitments', '')::numeric;
    v_without_incoming := nullif(v_capacity ->> 'available_without_incoming', '')::numeric;

    if v_capacity ->> 'status' = 'outside_horizon' then
      v_decision := case when v_decision = 'available' then 'outside_horizon' else v_decision end;
    elsif v_capacity ->> 'status' = 'requires_opening' then
      v_decision := 'requires_opening';
    elsif v_available < v_requested then
      v_decision := 'insufficient';
    elsif v_decision not in ('insufficient', 'requires_opening')
      and v_without_incoming < v_requested
    then
      v_decision := 'relies_on_incoming';
    end if;

    v_lines := v_lines || jsonb_build_array(
      v_line || v_capacity || jsonb_build_object(
        'requested_quantity_units', v_requested,
        'shortage_quantity_units', case
          when v_available is null then null
          else greatest(v_requested - v_available, 0)
        end,
        'relies_on_incoming', case
          when v_available is null or v_without_incoming is null then false
          else v_without_incoming < v_requested and v_available >= v_requested
        end
      )
    );
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    v_decision := 'no_inventory_effect';
  end if;

  return jsonb_build_object(
    'status', 'previewed',
    'decision', v_decision,
    'order_id', p_order_id,
    'effective_at', v_effective_at,
    'horizon_days', 10,
    'lines', v_lines
  );
end;
$$;

revoke all on function public.inventory_preview_order_commitment_v1(bigint)
  from public, anon;
grant execute on function public.inventory_preview_order_commitment_v1(bigint)
  to authenticated;

create or replace function public.inventory_rebuild_order_commitment_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo administración o máster pueden reconstruir compromisos.'
      using errcode = '42501';
  end if;

  return app_private.inventory_materialize_order_commitment_v1(p_order_id, v_actor);
end;
$$;

revoke all on function public.inventory_rebuild_order_commitment_v1(bigint)
  from public, anon;
grant execute on function public.inventory_rebuild_order_commitment_v1(bigint)
  to authenticated;

create or replace function app_private.inventory_order_item_snapshot_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.inventory_sync_order_item_components_v1(new.id);
  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_snapshot_trigger_v1()
  from public, anon, authenticated;

create trigger inventory_10_order_item_snapshot_v1
after insert or update of product_id, qty, notes
on public.order_items
for each row
execute function app_private.inventory_order_item_snapshot_trigger_v1();

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
begin
  v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;

  select
    order_row.status::text as status,
    order_row.needs_reapproval,
    order_row.queued_needs_reapproval,
    order_row.last_modified_by,
    order_row.sent_to_kitchen_by,
    order_row.created_by_user_id
  into v_order
  from public.orders order_row
  where order_row.id = v_order_id;

  if not found then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
    and not coalesce(v_order.needs_reapproval, false)
    and not coalesce(v_order.queued_needs_reapproval, false)
  then
    v_actor := app_private.inventory_resolve_commitment_actor_v1(
      v_order_id,
      coalesce(auth.uid(), v_order.last_modified_by, v_order.sent_to_kitchen_by, v_order.created_by_user_id)
    );
    perform app_private.inventory_materialize_order_commitment_v1(v_order_id, v_actor);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.inventory_order_item_commitment_trigger_v1()
  from public, anon, authenticated;

create trigger inventory_20_order_item_commitment_v1
after insert or update or delete
on public.order_items
for each row
execute function app_private.inventory_order_item_commitment_trigger_v1();

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
begin
  v_actor := app_private.inventory_resolve_commitment_actor_v1(
    new.id,
    coalesce(auth.uid(), new.last_modified_by, new.sent_to_kitchen_by, new.created_by_user_id)
  );

  if new.status = 'delivered'::public.order_status then
    perform app_private.inventory_close_order_commitments_v1(new.id, 'fulfilled', v_actor);
    return new;
  end if;

  if new.status in ('created'::public.order_status, 'cancelled'::public.order_status) then
    perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    return new;
  end if;

  if coalesce(new.needs_reapproval, false)
    or coalesce(new.queued_needs_reapproval, false)
  then
    perform app_private.inventory_close_order_commitments_v1(new.id, 'cancelled', v_actor);
    return new;
  end if;

  if new.status not in (
    'queued'::public.order_status,
    'confirmed'::public.order_status,
    'in_kitchen'::public.order_status,
    'ready'::public.order_status,
    'out_for_delivery'::public.order_status
  ) then
    return new;
  end if;

  select exists (
    select 1 from public.order_items order_item where order_item.order_id = new.id
  ) into v_has_items;
  if not v_has_items then
    return new;
  end if;

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

  return new;
end;
$$;

revoke all on function app_private.inventory_order_commitment_trigger_v1()
  from public, anon, authenticated;

create trigger inventory_order_commitment_lifecycle_v1
after insert or update of status, needs_reapproval, queued_needs_reapproval, extra_fields
on public.orders
for each row
execute function app_private.inventory_order_commitment_trigger_v1();

-- Snapshots may be read through existing order permissions, but their writes are
-- now owned by the canonical trigger instead of arbitrary authenticated DML.
drop policy if exists order_item_components_insert_authenticated
  on public.order_item_components;
drop policy if exists order_item_components_update_authenticated
  on public.order_item_components;

revoke insert, update, delete on table public.order_item_components
  from anon, authenticated;
revoke usage, select on sequence public.order_item_components_id_seq
  from anon, authenticated;

-- Backfill only approved, still-open orders. Delivered history keeps the Block 5
-- marker fallback and is not reinterpreted.
do $$
declare
  v_order_item record;
  v_order record;
  v_actor uuid;
begin
  for v_order_item in
    select order_item.id
    from public.order_items order_item
    join public.orders order_row on order_row.id = order_item.order_id
    where order_row.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
    order by order_item.id
  loop
    perform app_private.inventory_sync_order_item_components_v1(v_order_item.id);
  end loop;

  for v_order in
    select order_row.id
    from public.orders order_row
    where order_row.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
      and not coalesce(order_row.needs_reapproval, false)
      and not coalesce(order_row.queued_needs_reapproval, false)
    order by order_row.id
  loop
    v_actor := app_private.inventory_resolve_commitment_actor_v1(v_order.id, null);
    perform app_private.inventory_materialize_order_commitment_v1(v_order.id, v_actor);
  end loop;
end
$$;

comment on function public.inventory_preview_order_commitment_v1(bigint) is
  'Previews physical demand at the requested delivery time while preserving all approved commitments in the rolling ten-day horizon.';
comment on function public.inventory_rebuild_order_commitment_v1(bigint) is
  'Master/Admin repair command that rematerializes one approved order commitment without moving physical stock.';
