-- Phase 2 / Máster: explicit commercial suspensions.
-- Reuses inventory_planned_flows.declared_unavailability, which has existed
-- since the inventory foundation. Physical stock and existing orders remain
-- untouched; the override only affects dated availability reads.

set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists inventory_planned_flows_active_unavailability_idx
  on public.inventory_planned_flows (inventory_item_id, effective_at)
  where flow_type = 'declared_unavailability' and status = 'active';

alter function app_private.inventory_item_capacity_v1(bigint, timestamptz, bigint)
  rename to inventory_item_capacity_base_v1;

create function app_private.inventory_item_capacity_v1(
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
  v_capacity jsonb;
  v_target_at timestamptz := greatest(p_target_at, now());
  v_unavailability public.inventory_planned_flows%rowtype;
begin
  v_capacity := app_private.inventory_item_capacity_base_v1(
    p_inventory_item_id,
    p_target_at,
    p_exclude_order_id
  );

  select flow.*
  into v_unavailability
  from public.inventory_planned_flows flow
  where flow.inventory_item_id = p_inventory_item_id
    and flow.flow_type = 'declared_unavailability'
    and flow.status = 'active'
    and (flow.effective_at is null or v_target_at < flow.effective_at)
  order by flow.effective_at nulls first, flow.id desc
  limit 1;

  if not found then
    return v_capacity;
  end if;

  return v_capacity || jsonb_build_object(
    'status', 'evaluated',
    'target_at', v_target_at,
    'available_without_affecting_commitments', 0,
    'available_without_incoming', 0,
    'declared_unavailable', true,
    'unavailability_flow_id', v_unavailability.id,
    'unavailable_until', v_unavailability.effective_at,
    'unavailability_notes', v_unavailability.notes
  );
end;
$$;

revoke all on function app_private.inventory_item_capacity_base_v1(bigint, timestamptz, bigint)
  from public, anon, authenticated, service_role;
revoke all on function app_private.inventory_item_capacity_v1(bigint, timestamptz, bigint)
  from public, anon, authenticated, service_role;

create function public.inventory_save_declared_unavailability_v1(
  p_operation_id uuid,
  p_inventory_item_id bigint,
  p_available_from timestamptz default null,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.inventory_items%rowtype;
  v_existing public.inventory_planned_flows%rowtype;
  v_previous public.inventory_planned_flows%rowtype;
  v_flow_id bigint;
  v_now timestamptz := now();
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
    raise exception 'Solo Máster o administración pueden suspender ventas por inventario.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_inventory_item_id is null then
    raise exception 'operation_id e inventory_item_id son obligatorios.' using errcode = '22023';
  end if;
  if p_available_from is not null and p_available_from <= v_now then
    raise exception 'La reanudación debe quedar en el futuro; para reanudar ahora cancela la suspensión.'
      using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  select flow.*
  into v_existing
  from public.inventory_planned_flows flow
  where flow.operation_id = p_operation_id;

  if found then
    if v_existing.flow_type <> 'declared_unavailability'
      or v_existing.inventory_item_id <> p_inventory_item_id
    then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'unavailability_flow_id', v_existing.id,
      'inventory_item_id', v_existing.inventory_item_id,
      'available_from', v_existing.effective_at
    );
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id
  for update;

  if not found then
    raise exception 'Ítem de inventario no encontrado.' using errcode = 'P0002';
  end if;
  if not v_item.is_active
    or v_item.merged_into_item_id is not null
    or v_item.tracking_mode not in ('transactional', 'periodic_count')
  then
    raise exception 'El ítem no admite una suspensión comercial.' using errcode = '22023';
  end if;

  select flow.*
  into v_previous
  from public.inventory_planned_flows flow
  where flow.inventory_item_id = v_item.id
    and flow.flow_type = 'declared_unavailability'
    and flow.status = 'active'
  order by flow.id desc
  limit 1
  for update;

  if found then
    update public.inventory_planned_flows
    set status = 'cancelled',
        resolved_by_user_id = v_actor,
        resolved_at = v_now,
        updated_at = v_now,
        notes = case
          when notes is null then 'Reemplazada por una nueva suspensión de Máster.'
          else notes || E'\nReemplazada por una nueva suspensión de Máster.'
        end
    where id = v_previous.id;
  end if;

  insert into public.inventory_planned_flows (
    inventory_item_id,
    flow_type,
    quantity_units,
    effective_at,
    status,
    notes,
    created_by_user_id,
    operation_id,
    capture_details
  )
  values (
    v_item.id,
    'declared_unavailability',
    null,
    p_available_from,
    'active',
    nullif(btrim(p_notes), ''),
    v_actor,
    p_operation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'declared_from', 'master_inventory',
      'available_from', p_available_from
    ))
  )
  returning id into v_flow_id;

  return jsonb_build_object(
    'status', 'applied',
    'unavailability_flow_id', v_flow_id,
    'inventory_item_id', v_item.id,
    'available_from', p_available_from,
    'replaced_flow_id', v_previous.id
  );
end;
$$;

revoke all on function public.inventory_save_declared_unavailability_v1(uuid, bigint, timestamptz, text)
  from public, anon;
grant execute on function public.inventory_save_declared_unavailability_v1(uuid, bigint, timestamptz, text)
  to authenticated;

create function public.inventory_cancel_declared_unavailability_v1(
  p_unavailability_flow_id bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_flow public.inventory_planned_flows%rowtype;
  v_now timestamptz := now();
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
    raise exception 'Solo Máster o administración pueden reanudar ventas.' using errcode = '42501';
  end if;
  if p_unavailability_flow_id is null then
    raise exception 'unavailability_flow_id es obligatorio.' using errcode = '22023';
  end if;
  if p_notes is not null and char_length(btrim(p_notes)) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  select flow.*
  into v_flow
  from public.inventory_planned_flows flow
  where flow.id = p_unavailability_flow_id
  for update;

  if not found or v_flow.flow_type <> 'declared_unavailability' then
    raise exception 'Suspensión comercial no encontrada.' using errcode = 'P0002';
  end if;
  if v_flow.status = 'cancelled' then
    return jsonb_build_object(
      'status', 'replayed',
      'unavailability_flow_id', v_flow.id,
      'inventory_item_id', v_flow.inventory_item_id
    );
  end if;
  if v_flow.status <> 'active' then
    raise exception 'La suspensión ya no está activa.' using errcode = '22023';
  end if;

  update public.inventory_planned_flows
  set status = 'cancelled',
      resolved_by_user_id = v_actor,
      resolved_at = v_now,
      updated_at = v_now,
      notes = case
        when nullif(btrim(p_notes), '') is null then notes
        when notes is null then btrim(p_notes)
        else notes || E'\n' || btrim(p_notes)
      end
  where id = v_flow.id;

  return jsonb_build_object(
    'status', 'applied',
    'unavailability_flow_id', v_flow.id,
    'inventory_item_id', v_flow.inventory_item_id
  );
end;
$$;

revoke all on function public.inventory_cancel_declared_unavailability_v1(bigint, text)
  from public, anon;
grant execute on function public.inventory_cancel_declared_unavailability_v1(bigint, text)
  to authenticated;

alter function public.inventory_catalog_availability_v1(timestamptz, bigint[], text)
  rename to inventory_catalog_availability_base_v1;

create function public.inventory_catalog_availability_v1(
  p_target_at timestamptz,
  p_product_ids bigint[] default null,
  p_surface text default 'advisor_availability'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_products jsonb;
  v_summary jsonb;
  v_target_at timestamptz;
  v_suspended_count integer := 0;
begin
  v_result := public.inventory_catalog_availability_base_v1(
    p_target_at,
    p_product_ids,
    p_surface
  );
  v_target_at := (v_result ->> 'target_at')::timestamptz;

  with recursive
  result_products as (
    select
      (entry.value ->> 'product_id')::bigint as product_id,
      entry.value as payload,
      entry.ordinality
    from jsonb_array_elements(coalesce(v_result -> 'products', '[]'::jsonb))
      with ordinality entry(value, ordinality)
  ),
  product_nodes(root_product_id, product_id, depth, product_path) as (
    select product.product_id, product.product_id, 0, array[product.product_id]::bigint[]
    from result_products product

    union all

    select
      node.root_product_id,
      component.component_product_id,
      node.depth + 1,
      node.product_path || component.component_product_id
    from product_nodes node
    join public.product_components component
      on component.parent_product_id = node.product_id
     and component.component_mode = 'fixed'
     and component.is_required
    where node.depth < 16
      and not component.component_product_id = any(node.product_path)
  ),
  suspensions as (
    select
      node.root_product_id as product_id,
      bool_or(flow.effective_at is null) as indefinite,
      max(flow.effective_at) filter (where flow.effective_at is not null) as resume_at,
      jsonb_agg(distinct item.name) as item_names
    from product_nodes node
    join public.products product on product.id = node.product_id
    join public.product_inventory_links link
      on link.product_id = product.id
     and link.configuration_version = 1
    join public.inventory_items item on item.id = link.inventory_item_id
    join public.inventory_planned_flows flow
      on flow.inventory_item_id = item.id
     and flow.flow_type = 'declared_unavailability'
     and flow.status = 'active'
     and (flow.effective_at is null or v_target_at < flow.effective_at)
    where product.inventory_policy in ('self', 'direct')
    group by node.root_product_id
  ),
  patched as (
    select
      product.ordinality,
      case
        when suspension.product_id is null then product.payload
        else product.payload || jsonb_strip_nulls(jsonb_build_object(
          'availability_state', 'declared_unavailable',
          'severity', 'critical',
          'message', case
            when suspension.indefinite then 'Ventas suspendidas por Máster sin fecha de reanudación.'
            else format(
              'Ventas suspendidas por Máster hasta %s.',
              to_char(suspension.resume_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
            )
          end,
          'available_without_affecting_confirmed', 0,
          'available_without_planned_incoming', 0,
          'depends_on_incoming', false,
          'next_available_at', case when suspension.indefinite then null else suspension.resume_at end,
          'requires_master_review', true,
          'review_reason_codes', jsonb_build_array('declared_unavailable'),
          'inventory_blocks_submission', true,
          'is_commercially_suspended', true,
          'suspended_until', case when suspension.indefinite then null else suspension.resume_at end,
          'suspended_inventory_items', suspension.item_names
        ))
      end as payload,
      suspension.product_id is not null as is_suspended
    from result_products product
    left join suspensions suspension on suspension.product_id = product.product_id
  )
  select
    coalesce(jsonb_agg(patched.payload order by patched.ordinality), '[]'::jsonb),
    count(*) filter (where patched.is_suspended)::integer
  into v_products, v_suspended_count
  from patched;

  v_summary := coalesce(v_result -> 'summary', '{}'::jsonb) || jsonb_build_object(
    'commercially_suspended_count', v_suspended_count
  );

  return jsonb_set(
    jsonb_set(v_result, '{products}', v_products, true),
    '{summary}',
    v_summary,
    true
  );
end;
$$;

revoke all on function public.inventory_catalog_availability_base_v1(timestamptz, bigint[], text)
  from public, anon, authenticated, service_role;
revoke all on function public.inventory_catalog_availability_v1(timestamptz, bigint[], text)
  from public, anon;
grant execute on function public.inventory_catalog_availability_v1(timestamptz, bigint[], text)
  to authenticated;

comment on function public.inventory_save_declared_unavailability_v1(uuid, bigint, timestamptz, text) is
  'Master/Admin command that declares an item commercially unavailable until a future time or indefinitely without changing physical stock.';
comment on function public.inventory_cancel_declared_unavailability_v1(bigint, text) is
  'Master/Admin command that resumes commercial availability by cancelling one active declared unavailability.';
comment on function public.inventory_catalog_availability_v1(timestamptz, bigint[], text) is
  'Date-first availability with explicit Master commercial suspensions propagated through required fixed components; ordinary shortages remain non-blocking.';
