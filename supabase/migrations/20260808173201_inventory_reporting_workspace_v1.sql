-- Block 14: canonical inventory reports and keyset-paginated kardex.
-- No new table or duplicated stock field is required. Uninitialized items hide
-- the legacy balance so historical negatives are never presented as physical stock.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.inventory_reporting_workspace_v1(
  p_horizon_days integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_horizon_end timestamptz;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not (public.has_role('admin') or public.has_role('master')) then
    raise exception 'Solo Master o administración pueden consultar reportes de inventario.'
      using errcode = '42501';
  end if;
  if p_horizon_days is null or p_horizon_days < 1 or p_horizon_days > 31 then
    raise exception 'El horizonte debe estar entre 1 y 31 días.' using errcode = '22023';
  end if;

  v_horizon_end := now() + make_interval(days => p_horizon_days);

  with recursive
  eligible_items as (
    select
      item.id,
      item.name,
      coalesce(item.inventory_group, 'other') as inventory_group,
      coalesce(item.unit_name, 'unidad') as unit_name,
      item.inventory_kind,
      item.tracking_mode,
      item.availability_mode,
      item.current_stock_units,
      item.low_stock_threshold,
      item.low_stock_inclusive,
      item.target_stock_units,
      item.primary_count_frequency,
      item.primary_count_role
    from public.inventory_items item
    where item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ),
  initialized_items as (
    select distinct opening.inventory_item_id
    from public.inventory_movements opening
    where opening.operation_id is not null
      and opening.reason_code = 'opening_balance'
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = opening.id
      )
  ),
  flow_rollup as (
    select
      flow.inventory_item_id,
      coalesce(sum(flow.quantity_units) filter (
        where flow.flow_type = 'order_commitment'
          and flow.status = 'active'
          and flow.effective_at <= v_horizon_end
      ), 0) as commitment_units,
      count(*) filter (
        where flow.flow_type = 'order_commitment'
          and flow.status = 'active'
          and flow.effective_at <= v_horizon_end
      )::integer as commitment_count,
      min(flow.effective_at) filter (
        where flow.flow_type = 'order_commitment'
          and flow.status = 'active'
      ) as next_commitment_at,
      coalesce(sum(flow.quantity_units) filter (
        where flow.flow_type in ('expected_receipt', 'planned_production')
          and flow.status = 'active'
          and flow.effective_at <= v_horizon_end
      ), 0) as incoming_units,
      count(*) filter (
        where flow.flow_type in ('expected_receipt', 'planned_production')
          and flow.status = 'active'
          and flow.effective_at <= v_horizon_end
      )::integer as incoming_count,
      min(flow.effective_at) filter (
        where flow.flow_type in ('expected_receipt', 'planned_production')
          and flow.status = 'active'
      ) as next_incoming_at,
      coalesce(sum(flow.quantity_units) filter (
        where flow.flow_type = 'order_commitment'
          and flow.status = 'draft'
          and flow.effective_at > v_horizon_end
      ), 0) as outside_horizon_commitment_units,
      count(*) filter (
        where flow.flow_type = 'order_commitment'
          and flow.status = 'draft'
          and flow.effective_at > v_horizon_end
      )::integer as outside_horizon_commitment_count
    from public.inventory_planned_flows flow
    where flow.status in ('draft', 'active')
    group by flow.inventory_item_id
  ),
  latest_count_candidates as (
    select
      line.inventory_item_id,
      count_header.id as inventory_count_id,
      count_header.count_kind,
      count_header.status as count_status,
      line.line_status,
      line.expected_quantity_units,
      line.counted_quantity_units,
      line.difference_quantity_units,
      coalesce(line.counted_at, count_header.submitted_at, count_header.created_at) as counted_at,
      coalesce(counter.full_name, creator.full_name) as counted_by_name,
      row_number() over (
        partition by line.inventory_item_id
        order by
          coalesce(line.counted_at, count_header.submitted_at, count_header.created_at) desc,
          count_header.id desc,
          line.id desc
      ) as position
    from public.inventory_count_lines line
    join public.inventory_counts count_header
      on count_header.id = line.inventory_count_id
    left join public.profiles counter on counter.id = line.counted_by_user_id
    left join public.profiles creator on creator.id = count_header.created_by_user_id
    where line.counted_quantity_units is not null
  ),
  latest_counts as (
    select *
    from latest_count_candidates
    where position = 1
  ),
  alert_rollup as (
    select
      alert.inventory_item_id,
      count(*)::integer as active_alert_count,
      count(*) filter (where alert.severity = 'critical')::integer as critical_alert_count,
      count(*) filter (where alert.requires_action)::integer as action_alert_count
    from public.inventory_alerts alert
    where alert.status in ('open', 'managed')
      and alert.inventory_item_id is not null
    group by alert.inventory_item_id
  ),
  product_dependencies(inventory_item_id, product_id) as (
    select link.inventory_item_id, link.product_id
    from public.product_inventory_links link
    where link.configuration_version = 1

    union

    select dependency.inventory_item_id, component.parent_product_id
    from product_dependencies dependency
    join public.product_components component
      on component.component_product_id = dependency.product_id
  ),
  dependency_rows as (
    select distinct
      dependency.inventory_item_id,
      product.id as product_id,
      product.name as product_name
    from product_dependencies dependency
    join public.products product on product.id = dependency.product_id
    where product.is_active
  ),
  dependency_rollup as (
    select
      dependency.inventory_item_id,
      count(*)::integer as product_count,
      jsonb_agg(
        jsonb_build_object(
          'id', dependency.product_id,
          'name', dependency.product_name
        )
        order by dependency.product_name, dependency.product_id
      ) as products
    from dependency_rows dependency
    group by dependency.inventory_item_id
  ),
  item_rows as (
    select
      item.*,
      (initialized.inventory_item_id is not null) as initialized,
      capacity.value as capacity,
      case
        when initialized.inventory_item_id is null then null
        else app_private.inventory_effective_capacity_v1(item.id, now(), array[]::bigint[])
      end as effective_capacity_units,
      coalesce(flow.commitment_units, 0) as commitment_units,
      coalesce(flow.commitment_count, 0) as commitment_count,
      flow.next_commitment_at,
      coalesce(flow.incoming_units, 0) as incoming_units,
      coalesce(flow.incoming_count, 0) as incoming_count,
      flow.next_incoming_at,
      coalesce(flow.outside_horizon_commitment_units, 0) as outside_horizon_commitment_units,
      coalesce(flow.outside_horizon_commitment_count, 0) as outside_horizon_commitment_count,
      latest.inventory_count_id,
      latest.count_kind as last_count_kind,
      latest.count_status as last_count_status,
      latest.line_status as last_count_line_status,
      latest.expected_quantity_units as last_expected_units,
      latest.counted_quantity_units as last_counted_units,
      latest.difference_quantity_units as last_difference_units,
      latest.counted_at as last_counted_at,
      latest.counted_by_name,
      coalesce(alerts.active_alert_count, 0) as active_alert_count,
      coalesce(alerts.critical_alert_count, 0) as critical_alert_count,
      coalesce(alerts.action_alert_count, 0) as action_alert_count,
      coalesce(dependencies.product_count, 0) as product_count,
      coalesce(dependencies.products, '[]'::jsonb) as products
    from eligible_items item
    left join initialized_items initialized on initialized.inventory_item_id = item.id
    left join flow_rollup flow on flow.inventory_item_id = item.id
    left join latest_counts latest on latest.inventory_item_id = item.id
    left join alert_rollup alerts on alerts.inventory_item_id = item.id
    left join dependency_rollup dependencies on dependencies.inventory_item_id = item.id
    left join lateral (
      select case
        when initialized.inventory_item_id is null then null::jsonb
        else app_private.inventory_item_capacity_v1(item.id, now(), null)
      end as value
    ) capacity on true
  ),
  recent_counts as (
    select
      count_header.id,
      count_header.count_kind,
      count_header.status,
      count_header.responsible_role,
      count_header.due_at,
      count_header.submitted_at,
      count_header.reviewed_at,
      count_header.created_at,
      creator.full_name as created_by_name,
      reviewer.full_name as reviewed_by_name,
      count(line.id)::integer as line_count,
      count(line.id) filter (
        where coalesce(line.difference_quantity_units, 0) <> 0
      )::integer as variance_count,
      coalesce(sum(abs(line.difference_quantity_units)), 0) as total_absolute_difference
    from public.inventory_counts count_header
    left join public.inventory_count_lines line
      on line.inventory_count_id = count_header.id
    left join public.profiles creator on creator.id = count_header.created_by_user_id
    left join public.profiles reviewer on reviewer.id = count_header.reviewed_by_user_id
    group by
      count_header.id,
      creator.full_name,
      reviewer.full_name
    order by count_header.created_at desc, count_header.id desc
    limit 50
  ),
  projection_rows as (
    select
      flow.id,
      flow.inventory_item_id,
      item.name as inventory_item_name,
      item.unit_name,
      flow.flow_type,
      flow.quantity_units,
      flow.effective_at,
      flow.status,
      flow.order_id,
      order_row.order_number,
      flow.inventory_recipe_id,
      flow.depends_on_flow_id,
      flow.notes,
      flow.capture_details
    from public.inventory_planned_flows flow
    join eligible_items item on item.id = flow.inventory_item_id
    left join public.orders order_row on order_row.id = flow.order_id
    where flow.status = 'active'
      and flow.effective_at <= v_horizon_end
      and flow.flow_type in ('order_commitment', 'expected_receipt', 'planned_production')
    order by flow.effective_at, flow.id
    limit 500
  )
  select jsonb_build_object(
    'generated_at', now(),
    'horizon_days', p_horizon_days,
    'horizon_ends_at', v_horizon_end,
    'cutover_mode', public.inventory_cutover_mode_v1(),
    'summary', jsonb_build_object(
      'tracked_items', (select count(*) from item_rows),
      'initialized_items', (select count(*) from item_rows where initialized),
      'pending_opening_items', (select count(*) from item_rows where not initialized),
      'active_commitment_flows', (
        select count(*) from projection_rows where flow_type = 'order_commitment'
      ),
      'committed_units', (
        select coalesce(sum(commitment_units), 0) from item_rows
      ),
      'incoming_flows', (
        select count(*) from projection_rows
        where flow_type in ('expected_receipt', 'planned_production')
      ),
      'incoming_units', (
        select coalesce(sum(incoming_units), 0) from item_rows
      ),
      'active_alerts', (
        select count(*) from public.inventory_alerts where status in ('open', 'managed')
      ),
      'canonical_movements', (
        select count(*) from public.inventory_movements where operation_id is not null
      ),
      'count_sessions', (select count(*) from public.inventory_counts)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'name', item.name,
        'inventory_group', item.inventory_group,
        'unit_name', item.unit_name,
        'inventory_kind', item.inventory_kind,
        'tracking_mode', item.tracking_mode,
        'availability_mode', item.availability_mode,
        'initialized', item.initialized,
        'opening_status', case when item.initialized then 'ready' else 'pending' end,
        'stock_units', case when item.initialized then item.current_stock_units else null end,
        'commitment_units', item.commitment_units,
        'commitment_count', item.commitment_count,
        'next_commitment_at', item.next_commitment_at,
        'incoming_units', item.incoming_units,
        'incoming_count', item.incoming_count,
        'next_incoming_at', item.next_incoming_at,
        'outside_horizon_commitment_units', item.outside_horizon_commitment_units,
        'outside_horizon_commitment_count', item.outside_horizon_commitment_count,
        'available_without_incoming_units', case
          when item.initialized then (item.capacity ->> 'available_without_incoming')::numeric
          else null
        end,
        'projected_available_units', case
          when item.initialized then (item.capacity ->> 'available_without_affecting_commitments')::numeric
          else null
        end,
        'minimum_projected_at', case
          when item.initialized then item.capacity ->> 'minimum_projected_at'
          else null
        end,
        'effective_capacity_units', item.effective_capacity_units,
        'depends_on_incoming', case
          when not item.initialized then false
          else coalesce((item.capacity ->> 'available_without_affecting_commitments')::numeric, 0)
            > coalesce((item.capacity ->> 'available_without_incoming')::numeric, 0)
        end,
        'low_stock_threshold', item.low_stock_threshold,
        'low_stock_inclusive', item.low_stock_inclusive,
        'target_stock_units', item.target_stock_units,
        'threshold_status', case
          when not item.initialized then 'pending_opening'
          when item.low_stock_threshold is null then 'not_configured'
          when item.current_stock_units <= 0 then 'out'
          when item.low_stock_inclusive and item.current_stock_units <= item.low_stock_threshold then 'low'
          when not item.low_stock_inclusive and item.current_stock_units < item.low_stock_threshold then 'low'
          else 'ok'
        end,
        'primary_count_frequency', item.primary_count_frequency,
        'primary_count_role', item.primary_count_role,
        'last_count', case
          when item.inventory_count_id is null then null
          else jsonb_build_object(
            'inventory_count_id', item.inventory_count_id,
            'count_kind', item.last_count_kind,
            'count_status', item.last_count_status,
            'line_status', item.last_count_line_status,
            'expected_units', item.last_expected_units,
            'counted_units', item.last_counted_units,
            'difference_units', item.last_difference_units,
            'counted_at', item.last_counted_at,
            'counted_by_name', item.counted_by_name
          )
        end,
        'active_alert_count', item.active_alert_count,
        'critical_alert_count', item.critical_alert_count,
        'action_alert_count', item.action_alert_count,
        'product_count', item.product_count,
        'products', item.products
      ) order by item.inventory_group, item.name, item.id)
      from item_rows item
    ), '[]'::jsonb),
    'projection_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', projection.id,
        'inventory_item_id', projection.inventory_item_id,
        'inventory_item_name', projection.inventory_item_name,
        'unit_name', projection.unit_name,
        'flow_type', projection.flow_type,
        'quantity_units', projection.quantity_units,
        'effective_at', projection.effective_at,
        'status', projection.status,
        'order_id', projection.order_id,
        'order_number', projection.order_number,
        'inventory_recipe_id', projection.inventory_recipe_id,
        'depends_on_flow_id', projection.depends_on_flow_id,
        'notes', projection.notes,
        'capture_details', projection.capture_details
      ) order by projection.effective_at, projection.id)
      from projection_rows projection
    ), '[]'::jsonb),
    'recent_counts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', count_row.id,
        'count_kind', count_row.count_kind,
        'status', count_row.status,
        'responsible_role', count_row.responsible_role,
        'due_at', count_row.due_at,
        'submitted_at', count_row.submitted_at,
        'reviewed_at', count_row.reviewed_at,
        'created_at', count_row.created_at,
        'created_by_name', count_row.created_by_name,
        'reviewed_by_name', count_row.reviewed_by_name,
        'line_count', count_row.line_count,
        'variance_count', count_row.variance_count,
        'total_absolute_difference', count_row.total_absolute_difference
      ) order by count_row.created_at desc, count_row.id desc)
      from recent_counts count_row
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_reporting_workspace_v1(integer)
  from public, anon;
grant execute on function public.inventory_reporting_workspace_v1(integer)
  to authenticated, service_role;

create or replace function public.inventory_kardex_page_v1(
  p_inventory_item_id bigint default null,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
  v_row_count integer := 0;
  v_next_created_at timestamptz;
  v_next_id bigint;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not (public.has_role('admin') or public.has_role('master')) then
    raise exception 'Solo Master o administración pueden consultar el kardex.'
      using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'El límite debe estar entre 1 y 200.' using errcode = '22023';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'El cursor del kardex está incompleto.' using errcode = '22023';
  end if;
  if p_inventory_item_id is not null and not exists (
    select 1 from public.inventory_items item where item.id = p_inventory_item_id
  ) then
    raise exception 'Ítem de inventario % no encontrado.', p_inventory_item_id
      using errcode = '22023';
  end if;

  with canonical_movements as (
    select
      movement.*,
      item.name as inventory_item_name,
      item.unit_name,
      item.current_stock_units,
      actor.full_name as actor_name,
      order_row.order_number,
      exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = movement.id
      ) as is_reversed
    from public.inventory_movements movement
    join public.inventory_items item on item.id = movement.inventory_item_id
    left join public.profiles actor on actor.id = movement.created_by_user_id
    left join public.orders order_row on order_row.id = movement.order_id
    where movement.operation_id is not null
      and (p_inventory_item_id is null or movement.inventory_item_id = p_inventory_item_id)
  ),
  balanced_movements as (
    select
      movement.*,
      movement.current_stock_units - coalesce(sum(movement.quantity_units) over (
        partition by movement.inventory_item_id
        order by movement.created_at desc, movement.id desc
        rows between unbounded preceding and 1 preceding
      ), 0) as balance_after_units
    from canonical_movements movement
  ),
  page_rows as (
    select *
    from balanced_movements movement
    where p_before_created_at is null
      or (movement.created_at, movement.id) < (p_before_created_at, p_before_id)
    order by movement.created_at desc, movement.id desc
    limit p_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', movement.id,
      'inventory_item_id', movement.inventory_item_id,
      'inventory_item_name', movement.inventory_item_name,
      'unit_name', movement.unit_name,
      'movement_type', movement.movement_type,
      'quantity_units', movement.quantity_units,
      'balance_before_units', movement.balance_after_units - movement.quantity_units,
      'balance_after_units', movement.balance_after_units,
      'reason_code', movement.reason_code,
      'notes', movement.notes,
      'order_id', movement.order_id,
      'order_number', movement.order_number,
      'operation_id', movement.operation_id,
      'reversal_of_movement_id', movement.reversal_of_movement_id,
      'is_reversed', movement.is_reversed,
      'actor_name', movement.actor_name,
      'created_at', movement.created_at
    ) order by movement.created_at desc, movement.id desc), '[]'::jsonb),
    count(*)::integer,
    (array_agg(movement.created_at order by movement.created_at, movement.id))[1],
    (array_agg(movement.id order by movement.created_at, movement.id))[1]
  into v_rows, v_row_count, v_next_created_at, v_next_id
  from page_rows movement;

  return jsonb_build_object(
    'items', v_rows,
    'next_cursor', case
      when v_row_count = p_limit then jsonb_build_object(
        'before_created_at', v_next_created_at,
        'before_id', v_next_id
      )
      else null
    end
  );
end;
$$;

revoke all on function public.inventory_kardex_page_v1(
  bigint, timestamptz, bigint, integer
) from public, anon;
grant execute on function public.inventory_kardex_page_v1(
  bigint, timestamptz, bigint, integer
) to authenticated, service_role;

comment on function public.inventory_reporting_workspace_v1(integer) is
  'Lazy-loaded canonical stock, commitment, projection, count and alert report for the Inventory Center.';
comment on function public.inventory_kardex_page_v1(bigint, timestamptz, bigint, integer) is
  'Keyset-paginated canonical kardex. Legacy movements without operation_id are intentionally excluded.';
