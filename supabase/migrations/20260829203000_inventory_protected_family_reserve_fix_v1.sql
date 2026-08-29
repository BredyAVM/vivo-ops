-- A safety reserve protects the combined raw-equivalent family capacity. It
-- must not be tied only to raw stock because prefried services are part of the
-- same sellable pool once Máster activates protected-balance mode.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.inventory_product_flexible_capacity_v1(
  p_product_id bigint,
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
  v_product public.products%rowtype;
  v_leaf record;
  v_route jsonb;
  v_link jsonb;
  v_capacity jsonb;
  v_protection jsonb;
  v_required numeric;
  v_link_with numeric;
  v_link_without numeric;
  v_route_with numeric;
  v_route_without numeric;
  v_leaf_primary_with numeric;
  v_leaf_primary_without numeric;
  v_leaf_flexible_with numeric;
  v_leaf_flexible_without numeric;
  v_leaf_reserve_product_units numeric;
  v_product_primary_with numeric := null;
  v_product_primary_without numeric := null;
  v_product_flexible_with numeric := null;
  v_product_flexible_without numeric := null;
  v_has_fallback boolean := false;
  v_protection_active boolean := false;
  v_reserve_total numeric := 0;
  v_quantum numeric := 1;
begin
  select product.* into v_product from public.products product where product.id = p_product_id;
  if not found then return jsonb_build_object('eligible', false); end if;

  for v_leaf in
    with recursive nodes(product_id, quantity, depth, path) as (
      select v_product.id, 1::numeric, 0, array[v_product.id]::bigint[]
      union all
      select component.component_product_id,
             node.quantity * component.quantity,
             node.depth + 1,
             node.path || component.component_product_id
      from nodes node
      join public.products parent on parent.id = node.product_id
      join public.product_components component
        on component.parent_product_id = node.product_id
       and component.component_mode = 'fixed'
       and component.is_required
      where parent.inventory_policy = 'components'
        and node.depth < 16
        and not component.component_product_id = any(node.path)
    )
    select
      leaf.id as product_id,
      leaf.name as product_name,
      sum(case
        when node.depth = 0 then node.quantity
        when leaf.units_per_service > 0 then node.quantity / leaf.units_per_service
        else node.quantity
      end) as multiplier
    from nodes node
    join public.products leaf on leaf.id = node.product_id
    where leaf.inventory_policy in ('self', 'direct')
    group by leaf.id, leaf.name
    order by leaf.id
  loop
    v_leaf_primary_with := 0;
    v_leaf_primary_without := 0;
    v_leaf_flexible_with := 0;
    v_leaf_flexible_without := 0;
    v_leaf_reserve_product_units := 0;

    for v_route in
      select route.value from jsonb_array_elements(
        app_private.inventory_product_routes_v1(v_leaf.product_id)
      ) route(value)
    loop
      v_route_with := null;
      v_route_without := null;
      if v_route ->> 'mode' = 'master_fallback' then v_has_fallback := true; end if;

      for v_link in select link.value from jsonb_array_elements(v_route -> 'links') link(value)
      loop
        v_required := v_leaf.multiplier * (v_link ->> 'quantity_units')::numeric;
        if v_required <= 0 then continue; end if;
        v_capacity := app_private.inventory_item_capacity_v1(
          (v_link ->> 'inventory_item_id')::bigint,
          p_target_at,
          p_exclude_order_id
        );
        if v_capacity ->> 'status' <> 'evaluated' then
          v_link_with := 0;
          v_link_without := 0;
        else
          v_link_with := greatest(coalesce(
            nullif(v_capacity ->> 'available_without_affecting_commitments', '')::numeric, 0
          ), 0);
          v_link_without := greatest(coalesce(
            nullif(v_capacity ->> 'available_without_incoming', '')::numeric, 0
          ), 0);
        end if;

        if v_route ->> 'mode' = 'primary' then
          v_protection := app_private.inventory_active_family_protection_v1(
            (v_link ->> 'inventory_item_id')::bigint,
            p_target_at
          );
          if v_protection is not null then
            v_protection_active := true;
            v_reserve_total := v_reserve_total + coalesce(
              nullif(v_protection ->> 'safety_reserve_units', '')::numeric, 0
            );
            v_leaf_reserve_product_units := greatest(
              v_leaf_reserve_product_units,
              coalesce(nullif(v_protection ->> 'safety_reserve_units', '')::numeric, 0)
                / v_required
            );
          end if;
        end if;

        v_route_with := case when v_route_with is null then v_link_with / v_required
          else least(v_route_with, v_link_with / v_required) end;
        v_route_without := case when v_route_without is null then v_link_without / v_required
          else least(v_route_without, v_link_without / v_required) end;
      end loop;

      v_route_with := coalesce(v_route_with, 0);
      v_route_without := coalesce(v_route_without, 0);
      if v_route ->> 'mode' = 'primary' then
        v_leaf_primary_with := v_leaf_primary_with + v_route_with;
        v_leaf_primary_without := v_leaf_primary_without + v_route_without;
      end if;
      if v_route ->> 'mode' in ('primary', 'master_fallback') then
        v_leaf_flexible_with := v_leaf_flexible_with + v_route_with;
        v_leaf_flexible_without := v_leaf_flexible_without + v_route_without;
      end if;
    end loop;

    v_leaf_flexible_with := greatest(v_leaf_flexible_with - v_leaf_reserve_product_units, 0);
    v_leaf_flexible_without := greatest(v_leaf_flexible_without - v_leaf_reserve_product_units, 0);
    v_leaf_primary_with := least(v_leaf_primary_with, v_leaf_flexible_with);
    v_leaf_primary_without := least(v_leaf_primary_without, v_leaf_flexible_without);

    v_product_primary_with := case when v_product_primary_with is null
      then v_leaf_primary_with else least(v_product_primary_with, v_leaf_primary_with) end;
    v_product_primary_without := case when v_product_primary_without is null
      then v_leaf_primary_without else least(v_product_primary_without, v_leaf_primary_without) end;
    v_product_flexible_with := case when v_product_flexible_with is null
      then v_leaf_flexible_with else least(v_product_flexible_with, v_leaf_flexible_with) end;
    v_product_flexible_without := case when v_product_flexible_without is null
      then v_leaf_flexible_without else least(v_product_flexible_without, v_leaf_flexible_without) end;
  end loop;

  if not v_has_fallback or v_product_flexible_with is null then
    return jsonb_build_object('eligible', false);
  end if;

  v_quantum := case when coalesce(v_product.allows_half_service, false) then 0.5 else 1 end;
  v_product_primary_with := floor(greatest(v_product_primary_with, 0) / v_quantum) * v_quantum;
  v_product_primary_without := floor(greatest(v_product_primary_without, 0) / v_quantum) * v_quantum;
  v_product_flexible_with := floor(greatest(v_product_flexible_with, 0) / v_quantum) * v_quantum;
  v_product_flexible_without := floor(greatest(v_product_flexible_without, 0) / v_quantum) * v_quantum;

  return jsonb_build_object(
    'eligible', true,
    'primary_capacity', v_product_primary_with,
    'primary_capacity_without_incoming', v_product_primary_without,
    'flexible_capacity', v_product_flexible_with,
    'flexible_capacity_without_incoming', v_product_flexible_without,
    'prefried_fallback_available', v_product_flexible_with > v_product_primary_with,
    'protection_active', v_protection_active,
    'safety_reserve_units', v_reserve_total,
    'unit_quantum', v_quantum
  );
end;
$$;

revoke all on function app_private.inventory_product_flexible_capacity_v1(bigint,timestamptz,bigint)
  from public, anon, authenticated, service_role;

create or replace function app_private.inventory_prepare_order_protected_allocations_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_effective_at timestamptz;
  v_resolution jsonb;
  v_line jsonb;
  v_protection jsonb;
  v_raw_capacity jsonb;
  v_prefried_capacity jsonb;
  v_raw_item_id bigint;
  v_fallback_item_id bigint;
  v_requested_raw numeric;
  v_raw_free numeric;
  v_raw_allocated numeric;
  v_prefried_needed numeric;
  v_prefried_free numeric;
  v_family_free_raw_equivalent numeric;
  v_ratio numeric;
  v_reserve numeric;
  v_allocations jsonb := '{}'::jsonb;
  v_extra jsonb;
begin
  select order_row.* into v_order
  from public.orders order_row where order_row.id = p_order_id for update;
  if not found then
    raise exception 'La orden % no existe.', p_order_id using errcode = '22023';
  end if;

  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);
  v_resolution := app_private.inventory_resolve_order_sale_routes_base_v1(p_order_id);

  for v_line in select line.value from jsonb_array_elements(v_resolution -> 'lines') line(value)
  loop
    v_raw_item_id := (v_line ->> 'inventory_item_id')::bigint;
    v_protection := app_private.inventory_active_family_protection_v1(v_raw_item_id, v_effective_at);
    if v_protection is null then continue; end if;

    v_fallback_item_id := (v_protection ->> 'fallback_inventory_item_id')::bigint;
    v_ratio := (v_protection ->> 'raw_units_per_prefried_unit')::numeric;
    v_reserve := coalesce((v_protection ->> 'safety_reserve_units')::numeric, 0);
    v_requested_raw := (v_line ->> 'quantity_units')::numeric;

    v_raw_capacity := app_private.inventory_item_capacity_base_v1(
      v_raw_item_id, v_effective_at, p_order_id
    );
    v_prefried_capacity := app_private.inventory_item_capacity_base_v1(
      v_fallback_item_id, v_effective_at, p_order_id
    );
    v_raw_free := greatest(coalesce(
      nullif(v_raw_capacity ->> 'available_without_affecting_commitments', '')::numeric, 0
    ), 0);
    v_prefried_free := greatest(coalesce(
      nullif(v_prefried_capacity ->> 'available_without_affecting_commitments', '')::numeric, 0
    ), 0);
    v_family_free_raw_equivalent := greatest(
      v_raw_free + (v_prefried_free * v_ratio) - v_reserve,
      0
    );
    if v_requested_raw > v_family_free_raw_equivalent + 0.000001 then
      raise exception 'El saldo protegido no alcanza para esta orden. Faltan % unidades de %.',
        trim(to_char(v_requested_raw - v_family_free_raw_equivalent, 'FM999999990.##')),
        coalesce(v_line ->> 'inventory_item_name', format('ítem #%s', v_raw_item_id))
        using errcode = 'P0001';
    end if;

    v_raw_allocated := least(v_requested_raw, v_raw_free);
    v_prefried_needed := greatest(v_requested_raw - v_raw_allocated, 0) / v_ratio;
    if v_prefried_needed > v_prefried_free + 0.000001 then
      raise exception 'El saldo protegido no alcanza para esta orden. Faltan % unidades de %.',
        trim(to_char((v_prefried_needed - v_prefried_free) * v_ratio, 'FM999999990.##')),
        coalesce(v_line ->> 'inventory_item_name', format('ítem #%s', v_raw_item_id))
        using errcode = 'P0001';
    end if;

    v_allocations := jsonb_set(v_allocations, array[v_raw_item_id::text], jsonb_build_object(
      'protection_flow_id', (v_protection ->> 'flow_id')::bigint,
      'raw_inventory_item_id', v_raw_item_id,
      'raw_quantity_units', v_raw_allocated,
      'fallback_inventory_item_id', v_fallback_item_id,
      'fallback_quantity_units', v_prefried_needed,
      'raw_units_per_prefried_unit', v_ratio,
      'safety_reserve_units', v_reserve,
      'calculated_at', now(),
      'effective_at', v_effective_at
    ), true);
  end loop;

  v_extra := jsonb_set(
    coalesce(v_order.extra_fields, '{}'::jsonb),
    '{inventory_protected_allocations_v1}',
    v_allocations,
    true
  );
  update public.orders order_row set extra_fields = v_extra where order_row.id = p_order_id;
  return jsonb_build_object(
    'status', 'prepared',
    'order_id', p_order_id,
    'effective_at', v_effective_at,
    'allocations', v_allocations
  );
end;
$$;

revoke all on function app_private.inventory_prepare_order_protected_allocations_v1(bigint)
  from public, anon, authenticated, service_role;
