-- Block 15: date-first, non-blocking catalog availability contract.
-- Reuses products, component rules, canonical links, physical openings,
-- recipes and planned flows. No table, column or trigger is introduced.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.inventory_effective_capacity_detail_v1(
  p_inventory_item_id bigint,
  p_target_at timestamptz,
  p_exclude_order_id bigint default null,
  p_visited bigint[] default array[]::bigint[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_item public.inventory_items%rowtype;
  v_recipe public.inventory_recipes%rowtype;
  v_capacity jsonb;
  v_target_at timestamptz := greatest(p_target_at, now());
  v_horizon_end timestamptz := now() + interval '10 days';
  v_base_with_incoming numeric;
  v_base_without_incoming numeric;
  v_effective_with_incoming numeric;
  v_effective_without_incoming numeric;
  v_batches_with_incoming numeric;
  v_batches_without_incoming numeric;
  v_component record;
  v_component_detail jsonb;
  v_component_with_incoming numeric;
  v_component_without_incoming numeric;
  v_component_batches_with_incoming numeric;
  v_component_batches_without_incoming numeric;
  v_next_known_supply_at timestamptz;
  v_component_next_supply_at timestamptz;
  v_recipe_inputs_ready boolean := true;
begin
  if p_inventory_item_id is null or p_target_at is null then
    raise exception 'El ítem y la fecha objetivo son obligatorios.' using errcode = '22023';
  end if;

  if p_inventory_item_id = any(coalesce(p_visited, array[]::bigint[]))
    or cardinality(coalesce(p_visited, array[]::bigint[])) >= 12
  then
    return jsonb_build_object(
      'status', 'dependency_cycle',
      'inventory_item_id', p_inventory_item_id,
      'target_at', v_target_at,
      'effective_capacity_units', null,
      'effective_capacity_without_incoming_units', null
    );
  end if;

  select item.*
  into v_item
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if not found
    or not v_item.is_active
    or v_item.merged_into_item_id is not null
    or v_item.tracking_mode not in ('transactional', 'periodic_count')
  then
    return jsonb_build_object(
      'status', 'item_not_operational',
      'inventory_item_id', p_inventory_item_id,
      'target_at', v_target_at,
      'effective_capacity_units', null,
      'effective_capacity_without_incoming_units', null
    );
  end if;

  select min(flow.effective_at)
  into v_next_known_supply_at
  from public.inventory_planned_flows flow
  where flow.inventory_item_id = v_item.id
    and flow.status = 'active'
    and flow.flow_type in ('expected_receipt', 'planned_production')
    and flow.effective_at > v_target_at
    and flow.effective_at <= v_horizon_end;

  v_capacity := app_private.inventory_item_capacity_v1(
    v_item.id,
    v_target_at,
    p_exclude_order_id
  );

  if v_capacity ->> 'status' <> 'evaluated' then
    return v_capacity || jsonb_build_object(
      'availability_mode', v_item.availability_mode,
      'effective_capacity_units', null,
      'effective_capacity_without_incoming_units', null,
      'depends_on_incoming', false,
      'next_known_supply_at', v_next_known_supply_at
    );
  end if;

  v_base_with_incoming := greatest(
    coalesce((v_capacity ->> 'available_without_affecting_commitments')::numeric, 0),
    0
  );
  v_base_without_incoming := greatest(
    coalesce((v_capacity ->> 'available_without_incoming')::numeric, 0),
    0
  );
  v_effective_with_incoming := v_base_with_incoming;
  v_effective_without_incoming := v_base_without_incoming;

  if v_item.availability_mode = 'immediate_recipe' then
    select recipe.*
    into v_recipe
    from public.inventory_recipes recipe
    where recipe.output_inventory_item_id = v_item.id
      and recipe.is_active
      and recipe.lead_time_minutes = 0
    order by recipe.version desc, recipe.id desc
    limit 1;

    if found then
      v_batches_with_incoming := null;
      v_batches_without_incoming := null;

      for v_component in
        select
          component.input_inventory_item_id,
          component.quantity_units
        from public.inventory_recipe_components component
        where component.recipe_id = v_recipe.id
        order by component.id
      loop
        v_component_detail := app_private.inventory_effective_capacity_detail_v1(
          v_component.input_inventory_item_id,
          v_target_at,
          p_exclude_order_id,
          coalesce(p_visited, array[]::bigint[]) || v_item.id
        );

        v_recipe_inputs_ready := v_recipe_inputs_ready
          and v_component_detail ->> 'status' = 'evaluated';
        v_component_with_incoming := case
          when v_component_detail ->> 'status' = 'evaluated' then greatest(
            coalesce((v_component_detail ->> 'effective_capacity_units')::numeric, 0),
            0
          )
          else 0
        end;
        v_component_without_incoming := case
          when v_component_detail ->> 'status' = 'evaluated' then greatest(
            coalesce((v_component_detail ->> 'effective_capacity_without_incoming_units')::numeric, 0),
            0
          )
          else 0
        end;
        v_component_batches_with_incoming :=
          v_component_with_incoming / v_component.quantity_units;
        v_component_batches_without_incoming :=
          v_component_without_incoming / v_component.quantity_units;

        v_batches_with_incoming := case
          when v_batches_with_incoming is null then v_component_batches_with_incoming
          else least(v_batches_with_incoming, v_component_batches_with_incoming)
        end;
        v_batches_without_incoming := case
          when v_batches_without_incoming is null then v_component_batches_without_incoming
          else least(v_batches_without_incoming, v_component_batches_without_incoming)
        end;

        v_component_next_supply_at := nullif(
          v_component_detail ->> 'next_known_supply_at',
          ''
        )::timestamptz;
        if v_component_next_supply_at is not null then
          v_next_known_supply_at := case
            when v_next_known_supply_at is null then v_component_next_supply_at
            else least(v_next_known_supply_at, v_component_next_supply_at)
          end;
        end if;
      end loop;

      if v_batches_with_incoming is not null and v_batches_with_incoming > 0 then
        v_batches_with_incoming := floor(
          v_batches_with_incoming / v_recipe.production_multiple
        ) * v_recipe.production_multiple;
        v_effective_with_incoming := v_effective_with_incoming
          + (v_batches_with_incoming * v_recipe.output_quantity_units);
      end if;

      if v_batches_without_incoming is not null and v_batches_without_incoming > 0 then
        v_batches_without_incoming := floor(
          v_batches_without_incoming / v_recipe.production_multiple
        ) * v_recipe.production_multiple;
        v_effective_without_incoming := v_effective_without_incoming
          + (v_batches_without_incoming * v_recipe.output_quantity_units);
      end if;
    end if;
  end if;

  return v_capacity || jsonb_build_object(
    'status', 'evaluated',
    'availability_mode', v_item.availability_mode,
    'recipe_id', v_recipe.id,
    'recipe_inputs_ready', v_recipe_inputs_ready,
    'stored_capacity_units', v_base_with_incoming,
    'stored_capacity_without_incoming_units', v_base_without_incoming,
    'effective_capacity_units', greatest(v_effective_with_incoming, 0),
    'effective_capacity_without_incoming_units', greatest(v_effective_without_incoming, 0),
    'depends_on_incoming', v_effective_with_incoming > v_effective_without_incoming,
    'next_known_supply_at', v_next_known_supply_at
  );
end;
$$;

revoke all on function app_private.inventory_effective_capacity_detail_v1(
  bigint, timestamptz, bigint, bigint[]
) from public, anon, authenticated, service_role;

create or replace function public.inventory_catalog_availability_v1(
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
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_target_at timestamptz;
  v_horizon_end timestamptz := now() + interval '10 days';
  v_cutover_mode text;
  v_is_admin boolean;
  v_is_master boolean;
  v_is_advisor boolean;
  v_is_counter boolean;
  v_include_internal_details boolean;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if p_target_at is null then
    raise exception 'La fecha y hora objetivo son obligatorias.' using errcode = '22023';
  end if;
  if p_product_ids is not null and cardinality(p_product_ids) > 200 then
    raise exception 'La consulta admite hasta 200 productos.' using errcode = '22023';
  end if;
  if p_product_ids is not null and exists (
    select 1 from unnest(p_product_ids) product_id
    where product_id is null or product_id <= 0
  ) then
    raise exception 'La lista contiene un producto inválido.' using errcode = '22023';
  end if;
  if p_surface not in (
    'inventory_center',
    'advisor_availability',
    'master_inventory',
    'counter_inventory',
    'admin_inventory'
  ) then
    raise exception 'La superficie de disponibilidad no es válida.' using errcode = '22023';
  end if;

  select
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'admin'
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'master'
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'advisor'
    ),
    exists (
      select 1 from public.user_roles role_row
      where role_row.user_id = v_actor and role_row.role = 'counter'
    )
  into v_is_admin, v_is_master, v_is_advisor, v_is_counter;

  if (p_surface = 'advisor_availability' and not (v_is_advisor or v_is_master or v_is_admin))
    or (p_surface = 'counter_inventory' and not (v_is_counter or v_is_master or v_is_admin))
    or (p_surface in ('inventory_center', 'master_inventory') and not (v_is_master or v_is_admin))
    or (p_surface = 'admin_inventory' and not v_is_admin)
  then
    raise exception 'No tienes permiso para consultar esta superficie de disponibilidad.'
      using errcode = '42501';
  end if;

  v_include_internal_details := v_is_admin or v_is_master;
  v_target_at := greatest(p_target_at, v_now);

  if app_private.inventory_catalog_is_ready_v1() then
    v_cutover_mode := 'canonical';
  elsif exists (
    select 1
    from public.inventory_counts count_header
    join public.inventory_count_lines count_line
      on count_line.inventory_count_id = count_header.id
    join public.inventory_items item
      on item.id = count_line.inventory_item_id
    where count_header.count_kind = 'opening'
      and item.is_active
      and item.merged_into_item_id is null
      and item.tracking_mode in ('transactional', 'periodic_count')
  ) then
    v_cutover_mode := 'opening';
  else
    v_cutover_mode := 'legacy';
  end if;

  with recursive
  selected_products as (
    select product.*
    from public.products product
    where product.is_active
      and (
        p_product_ids is null
        or product.id = any(p_product_ids)
      )
  ),
  product_nodes (
    root_product_id,
    product_id,
    quantity,
    depth,
    product_path,
    has_cycle
  ) as (
    select
      product.id,
      product.id,
      1::numeric,
      0,
      array[product.id]::bigint[],
      false
    from selected_products product

    union all

    select
      node.root_product_id,
      component.component_product_id,
      node.quantity * component.quantity,
      node.depth + 1,
      node.product_path || component.component_product_id,
      component.component_product_id = any(node.product_path)
    from product_nodes node
    join public.products parent_product on parent_product.id = node.product_id
    join public.product_components component
      on component.parent_product_id = node.product_id
     and component.component_mode = 'fixed'
     and component.is_required
    where parent_product.inventory_policy = 'components'
      and not node.has_cycle
      and node.depth < 16
  ),
  product_diagnostics as (
    select
      root.id as product_id,
      exists (
        select 1
        from product_nodes node
        join public.product_components component
          on component.parent_product_id = node.product_id
        where node.root_product_id = root.id
          and component.component_mode = 'selectable'
      ) as selection_required,
      exists (
        select 1
        from product_nodes node
        join public.product_components component
          on component.parent_product_id = node.product_id
        where node.root_product_id = root.id
          and not component.is_required
      ) as has_optional_components,
      exists (
        select 1 from product_nodes node
        where node.root_product_id = root.id and node.has_cycle
      ) as has_cycle,
      exists (
        select 1
        from product_nodes node
        join public.products nested_product on nested_product.id = node.product_id
        where node.root_product_id = root.id
          and (
            nested_product.inventory_configuration_status <> 'ready'
            or nested_product.inventory_policy is null
          )
      ) as has_configuration_issue,
      exists (
        select 1
        from product_nodes node
        join public.products leaf_product on leaf_product.id = node.product_id
        where node.root_product_id = root.id
          and leaf_product.inventory_policy in ('self', 'direct')
          and not node.has_cycle
          and not exists (
            select 1
            from public.product_inventory_links link
            where link.product_id = leaf_product.id
              and link.configuration_version = 1
          )
      ) as has_missing_link
    from selected_products root
  ),
  leaf_contributions as (
    select
      node.root_product_id as product_id,
      link.inventory_item_id,
      case
        when node.depth = 0 then node.quantity * link.quantity_units
        else node.quantity * case
          when leaf_product.units_per_service > 0
            then link.quantity_units / leaf_product.units_per_service
          else link.quantity_units
        end
      end as required_units,
      case
        when node.depth = 0 then floor(link.quantity_units / 2)
        else 0::numeric
      end as half_required_units
    from product_nodes node
    join public.products leaf_product on leaf_product.id = node.product_id
    join public.product_inventory_links link
      on link.product_id = node.product_id
     and link.configuration_version = 1
    where leaf_product.inventory_policy in ('self', 'direct')
      and not node.has_cycle
  ),
  leaf_requirements as (
    select
      contribution.product_id,
      contribution.inventory_item_id,
      sum(contribution.required_units) as required_units,
      sum(contribution.half_required_units) as half_required_units
    from leaf_contributions contribution
    where contribution.required_units > 0
    group by contribution.product_id, contribution.inventory_item_id
  ),
  diagnostic_totals as (
    select
      diagnostic.*,
      (
        select count(*)::integer
        from leaf_requirements requirement
        where requirement.product_id = diagnostic.product_id
      ) as leaf_count
    from product_diagnostics diagnostic
  ),
  capacity_item_ids as (
    select distinct requirement.inventory_item_id
    from leaf_requirements requirement
    join diagnostic_totals diagnostic on diagnostic.product_id = requirement.product_id
    join selected_products product on product.id = requirement.product_id
    where v_target_at <= v_horizon_end
      and v_cutover_mode <> 'legacy'
      and product.inventory_policy <> 'none'
      and not diagnostic.selection_required
      and not diagnostic.has_cycle
      and not diagnostic.has_configuration_issue
      and not diagnostic.has_missing_link
      and diagnostic.leaf_count > 0
  ),
  item_capacities as materialized (
    select
      selected_item.inventory_item_id,
      item.name as inventory_item_name,
      item.unit_name,
      item.low_stock_threshold,
      item.low_stock_inclusive,
      detail.value as capacity_detail
    from capacity_item_ids selected_item
    join public.inventory_items item on item.id = selected_item.inventory_item_id
    cross join lateral (
      select app_private.inventory_effective_capacity_detail_v1(
        selected_item.inventory_item_id,
        v_target_at,
        null,
        array[]::bigint[]
      ) as value
    ) detail
  ),
  leaf_capacities as (
    select
      requirement.product_id,
      requirement.inventory_item_id,
      capacity.inventory_item_name,
      capacity.unit_name,
      capacity.low_stock_threshold,
      capacity.low_stock_inclusive,
      requirement.required_units,
      requirement.half_required_units,
      capacity.capacity_detail
    from leaf_requirements requirement
    join item_capacities capacity
      on capacity.inventory_item_id = requirement.inventory_item_id
  ),
  product_full_capacities as (
    select
      capacity.product_id,
      bool_or(capacity.capacity_detail ->> 'status' = 'requires_opening')
        as requires_opening,
      bool_or(capacity.capacity_detail ->> 'status' not in ('evaluated', 'requires_opening'))
        as has_capacity_error,
      min(floor(
        (capacity.capacity_detail ->> 'effective_capacity_units')::numeric
        / capacity.required_units
      )) filter (where capacity.capacity_detail ->> 'status' = 'evaluated')
        as full_units_with_incoming,
      min(floor(
        (capacity.capacity_detail ->> 'effective_capacity_without_incoming_units')::numeric
        / capacity.required_units
      )) filter (where capacity.capacity_detail ->> 'status' = 'evaluated')
        as full_units_without_incoming,
      bool_or(
        capacity.capacity_detail ->> 'status' = 'evaluated'
        and capacity.low_stock_threshold is not null
        and (
          (
            capacity.low_stock_inclusive
            and (capacity.capacity_detail ->> 'effective_capacity_without_incoming_units')::numeric
              <= capacity.low_stock_threshold
          )
          or (
            not capacity.low_stock_inclusive
            and (capacity.capacity_detail ->> 'effective_capacity_without_incoming_units')::numeric
              < capacity.low_stock_threshold
          )
        )
      ) as has_low_item,
      min(nullif(capacity.capacity_detail ->> 'next_known_supply_at', '')::timestamptz)
        as next_known_supply_at,
      jsonb_agg(jsonb_build_object(
        'inventory_item_id', capacity.inventory_item_id,
        'inventory_item_name', capacity.inventory_item_name,
        'unit_name', capacity.unit_name,
        'required_units_per_product', capacity.required_units,
        'required_units_per_half_product', capacity.half_required_units,
        'status', capacity.capacity_detail ->> 'status',
        'recipe_inputs_ready', coalesce(
          (capacity.capacity_detail ->> 'recipe_inputs_ready')::boolean,
          true
        ),
        'effective_capacity_units', nullif(
          capacity.capacity_detail ->> 'effective_capacity_units',
          ''
        )::numeric,
        'effective_capacity_without_incoming_units', nullif(
          capacity.capacity_detail ->> 'effective_capacity_without_incoming_units',
          ''
        )::numeric,
        'low_stock_threshold', capacity.low_stock_threshold,
        'next_known_supply_at', nullif(
          capacity.capacity_detail ->> 'next_known_supply_at',
          ''
        )::timestamptz
      ) order by capacity.inventory_item_name, capacity.inventory_item_id)
        as inventory_items
    from leaf_capacities capacity
    group by capacity.product_id
  ),
  product_capacities as (
    select
      capacity.product_id,
      capacity.requires_opening,
      capacity.has_capacity_error,
      capacity.full_units_with_incoming + case
        when product.allows_half_service
          and capacity.full_units_with_incoming is not null
          and exists (
            select 1 from leaf_capacities leaf
            where leaf.product_id = capacity.product_id
              and leaf.half_required_units > 0
          )
          and not exists (
            select 1
            from leaf_capacities leaf
            where leaf.product_id = capacity.product_id
              and (
                leaf.capacity_detail ->> 'status' <> 'evaluated'
                or (
                  (leaf.capacity_detail ->> 'effective_capacity_units')::numeric
                  - (capacity.full_units_with_incoming * leaf.required_units)
                ) < leaf.half_required_units
              )
          )
        then 0.5
        else 0
      end as available_with_incoming,
      capacity.full_units_without_incoming + case
        when product.allows_half_service
          and capacity.full_units_without_incoming is not null
          and exists (
            select 1 from leaf_capacities leaf
            where leaf.product_id = capacity.product_id
              and leaf.half_required_units > 0
          )
          and not exists (
            select 1
            from leaf_capacities leaf
            where leaf.product_id = capacity.product_id
              and (
                leaf.capacity_detail ->> 'status' <> 'evaluated'
                or (
                  (leaf.capacity_detail ->> 'effective_capacity_without_incoming_units')::numeric
                  - (capacity.full_units_without_incoming * leaf.required_units)
                ) < leaf.half_required_units
              )
          )
        then 0.5
        else 0
      end as available_without_incoming,
      capacity.has_low_item,
      capacity.next_known_supply_at,
      capacity.inventory_items
    from product_full_capacities capacity
    join selected_products product on product.id = capacity.product_id
  ),
  dependency_items (
    product_id,
    inventory_item_id,
    depth,
    item_path
  ) as (
    select
      requirement.product_id,
      requirement.inventory_item_id,
      0,
      array[requirement.inventory_item_id]::bigint[]
    from leaf_requirements requirement
    join product_capacities capacity on capacity.product_id = requirement.product_id
    join selected_products product on product.id = requirement.product_id
    where coalesce(capacity.available_with_incoming, 0) < case
        when product.allows_half_service then 0.5
        else 1
      end
      and not capacity.requires_opening
      and not capacity.has_capacity_error

    union all

    select
      dependency.product_id,
      component.input_inventory_item_id,
      dependency.depth + 1,
      dependency.item_path || component.input_inventory_item_id
    from dependency_items dependency
    join lateral (
      select recipe.id
      from public.inventory_recipes recipe
      where recipe.output_inventory_item_id = dependency.inventory_item_id
        and recipe.is_active
        and recipe.lead_time_minutes = 0
      order by recipe.version desc, recipe.id desc
      limit 1
    ) recipe on true
    join public.inventory_recipe_components component
      on component.recipe_id = recipe.id
    where dependency.depth < 12
      and not component.input_inventory_item_id = any(dependency.item_path)
  ),
  candidate_times as (
    select distinct
      dependency.product_id,
      flow.effective_at as candidate_at
    from dependency_items dependency
    join public.inventory_planned_flows flow
      on flow.inventory_item_id = dependency.inventory_item_id
     and flow.status = 'active'
     and flow.flow_type in ('expected_receipt', 'planned_production')
     and flow.effective_at > v_target_at
     and flow.effective_at <= v_horizon_end
  ),
  candidate_leaf_capacities as materialized (
    select
      candidate.product_id,
      candidate.candidate_at,
      requirement.inventory_item_id,
      requirement.required_units,
      requirement.half_required_units,
      detail.value as capacity_detail
    from candidate_times candidate
    join leaf_requirements requirement on requirement.product_id = candidate.product_id
    cross join lateral (
      select app_private.inventory_effective_capacity_detail_v1(
        requirement.inventory_item_id,
        candidate.candidate_at,
        null,
        array[]::bigint[]
      ) as value
    ) detail
  ),
  candidate_product_full_capacities as (
    select
      candidate.product_id,
      candidate.candidate_at,
      bool_and(candidate.capacity_detail ->> 'status' = 'evaluated') as fully_evaluated,
      min(floor(
        (candidate.capacity_detail ->> 'effective_capacity_units')::numeric
        / candidate.required_units
      )) filter (where candidate.capacity_detail ->> 'status' = 'evaluated')
        as full_product_units
    from candidate_leaf_capacities candidate
    group by candidate.product_id, candidate.candidate_at
  ),
  candidate_product_capacities as (
    select
      candidate.product_id,
      candidate.candidate_at,
      candidate.fully_evaluated,
      candidate.full_product_units + case
        when product.allows_half_service
          and candidate.full_product_units is not null
          and exists (
            select 1
            from candidate_leaf_capacities leaf
            where leaf.product_id = candidate.product_id
              and leaf.candidate_at = candidate.candidate_at
              and leaf.half_required_units > 0
          )
          and not exists (
            select 1
            from candidate_leaf_capacities leaf
            where leaf.product_id = candidate.product_id
              and leaf.candidate_at = candidate.candidate_at
              and (
                leaf.capacity_detail ->> 'status' <> 'evaluated'
                or (
                  (leaf.capacity_detail ->> 'effective_capacity_units')::numeric
                  - (candidate.full_product_units * leaf.required_units)
                ) < leaf.half_required_units
              )
          )
        then 0.5
        else 0
      end as available_product_units
    from candidate_product_full_capacities candidate
    join selected_products product on product.id = candidate.product_id
  ),
  next_availability as (
    select
      candidate.product_id,
      min(candidate.candidate_at) as next_available_at
    from candidate_product_capacities candidate
    where candidate.fully_evaluated
      and candidate.available_product_units >= case
        when (
          select product.allows_half_service
          from selected_products product
          where product.id = candidate.product_id
        ) then 0.5
        else 1
      end
    group by candidate.product_id
  ),
  product_rows as (
    select
      product.id,
      product.sku,
      product.name,
      product.type,
      product.sort_order,
      product.inventory_policy,
      product.inventory_configuration_status,
      product.units_per_service,
      product.allows_half_service,
      diagnostic.selection_required,
      diagnostic.has_optional_components,
      diagnostic.has_cycle,
      diagnostic.has_configuration_issue,
      diagnostic.has_missing_link,
      diagnostic.leaf_count,
      capacity.requires_opening,
      capacity.has_capacity_error,
      greatest(capacity.available_with_incoming, 0) as available_with_incoming,
      greatest(capacity.available_without_incoming, 0) as available_without_incoming,
      capacity.has_low_item,
      capacity.next_known_supply_at,
      capacity.inventory_items,
      next_availability.next_available_at,
      case
        when product.inventory_policy = 'none' then 'not_tracked'
        when v_target_at > v_horizon_end then 'outside_horizon'
        when v_cutover_mode = 'legacy' then 'inventory_not_active'
        when diagnostic.has_cycle
          or diagnostic.has_configuration_issue
          or diagnostic.has_missing_link
          then 'configuration_pending'
        when diagnostic.selection_required then 'selection_required'
        when diagnostic.leaf_count = 0 then 'configuration_pending'
        when coalesce(capacity.requires_opening, false) then 'requires_opening'
        when coalesce(capacity.has_capacity_error, false)
          or capacity.available_with_incoming is null
          then 'availability_unknown'
        when capacity.available_with_incoming < case
          when product.allows_half_service then 0.5
          else 1
        end then 'unavailable'
        when capacity.available_without_incoming < case
          when product.allows_half_service then 0.5
          else 1
        end then 'relies_on_incoming'
        when capacity.has_low_item then 'low'
        else 'available'
      end as availability_state
    from selected_products product
    join diagnostic_totals diagnostic on diagnostic.product_id = product.id
    left join product_capacities capacity on capacity.product_id = product.id
    left join next_availability on next_availability.product_id = product.id
  ),
  product_payload as (
    select
      product.*,
      product.availability_state not in (
        'not_tracked',
        'available',
        'selection_required'
      ) as requires_master_review,
      case product.availability_state
        when 'not_tracked' then 'No requiere validación transaccional de inventario.'
        when 'outside_horizon' then 'La fecha está fuera del horizonte operativo de 10 días. Master la revisará más cerca de la entrega.'
        when 'inventory_not_active' then 'El inventario canónico está en preparación. La disponibilidad queda por confirmar con Master.'
        when 'configuration_pending' then 'La configuración de inventario de este producto requiere revisión administrativa.'
        when 'selection_required' then 'Selecciona el contenido para calcular la disponibilidad de este producto.'
        when 'requires_opening' then 'La disponibilidad está pendiente del conteo físico de apertura.'
        when 'availability_unknown' then 'No fue posible completar la evaluación automática. Master debe revisarla.'
        when 'unavailable' then case
          when product.next_available_at is null
            then 'No hay disponibilidad protegida conocida para esta fecha.'
          else format(
            'No hay disponibilidad protegida para esta fecha. Próxima disponibilidad calculada: %s.',
            to_char(product.next_available_at at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI')
          )
        end
        when 'relies_on_incoming' then 'La disponibilidad para esta fecha depende de una reposición o producción esperada.'
        when 'low' then format(
          'Quedan %s unidades del producto sin afectar pedidos confirmados.',
          trim(to_char(product.available_without_incoming, 'FM999999990.##'))
        )
        else format(
          'Disponible sin afectar pedidos confirmados: %s.',
          trim(to_char(product.available_without_incoming, 'FM999999990.##'))
        )
      end as message,
      case product.availability_state
        when 'configuration_pending' then 'warning'
        when 'availability_unknown' then 'warning'
        when 'unavailable' then 'warning'
        when 'relies_on_incoming' then 'warning'
        when 'low' then 'warning'
        else 'info'
      end as severity
    from product_rows product
  )
  select jsonb_build_object(
    'generated_at', v_now,
    'requested_target_at', p_target_at,
    'target_at', v_target_at,
    'horizon_days', 10,
    'horizon_ends_at', v_horizon_end,
    'surface', p_surface,
    'inventory_mode', v_cutover_mode,
    'inventory_blocks_submission', false,
    'unknown_product_ids', coalesce((
      select jsonb_agg(unknown.id order by unknown.id)
      from (
        select distinct requested.id
        from unnest(coalesce(p_product_ids, array[]::bigint[])) requested(id)
        where not exists (
          select 1 from selected_products product where product.id = requested.id
        )
      ) unknown
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'product_count', (select count(*) from product_payload),
      'requires_master_review_count', (
        select count(*) from product_payload where requires_master_review
      ),
      'selection_required_count', (
        select count(*) from product_payload where availability_state = 'selection_required'
      ),
      'available_count', (
        select count(*) from product_payload
        where availability_state in ('available', 'low', 'not_tracked')
      )
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'product_id', product.id,
        'sku', product.sku,
        'product_name', product.name,
        'product_type', product.type,
        'inventory_policy', product.inventory_policy,
        'availability_state', product.availability_state,
        'severity', product.severity,
        'message', product.message,
        'target_at', v_target_at,
        'unit_label', case
          when coalesce(product.units_per_service, 1) > 1 then 'servicio'
          else 'unidad'
        end,
        'units_per_service', product.units_per_service,
        'allows_half_service', product.allows_half_service,
        'available_without_affecting_confirmed', case
          when product.availability_state in (
            'available', 'low', 'relies_on_incoming', 'unavailable'
          ) then product.available_with_incoming
          else null
        end,
        'available_without_planned_incoming', case
          when product.availability_state in (
            'available', 'low', 'relies_on_incoming', 'unavailable'
          ) then product.available_without_incoming
          else null
        end,
        'depends_on_incoming', product.availability_state = 'relies_on_incoming',
        'next_available_at', case
          when product.available_with_incoming >= case
            when product.allows_half_service then 0.5
            else 1
          end then v_target_at
          else product.next_available_at
        end,
        'next_known_supply_at', product.next_known_supply_at,
        'selection_required', product.selection_required,
        'has_optional_components', product.has_optional_components,
        'requires_master_review', product.requires_master_review,
        'review_reason_codes', case
          when product.requires_master_review
            then jsonb_build_array(product.availability_state)
          else '[]'::jsonb
        end,
        'inventory_blocks_submission', false,
        'internal_details', case
          when v_include_internal_details then jsonb_build_object(
            'inventory_item_count', product.leaf_count,
            'configuration_status', product.inventory_configuration_status,
            'has_cycle', product.has_cycle,
            'has_missing_link', product.has_missing_link,
            'has_capacity_error', product.has_capacity_error,
            'inventory_items', coalesce(product.inventory_items, '[]'::jsonb)
          )
          else null
        end
      )) order by product.sort_order, product.name, product.id)
      from product_payload product
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.inventory_catalog_availability_v1(
  timestamptz, bigint[], text
) from public, anon;
grant execute on function public.inventory_catalog_availability_v1(
  timestamptz, bigint[], text
) to authenticated;

comment on function app_private.inventory_effective_capacity_detail_v1(
  bigint, timestamptz, bigint, bigint[]
) is
  'Effective dated capacity for one physical item, including immediate recipes and a separate no-incoming capacity.';

comment on function public.inventory_catalog_availability_v1(
  timestamptz, bigint[], text
) is
  'Non-blocking date-first catalog availability contract for Advisor, Counter, Master and Admin surfaces.';
