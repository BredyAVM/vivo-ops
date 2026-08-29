-- Master-controlled protected-balance sales for inventory families that may
-- finish fried demand from prefried stock. The implementation deliberately
-- reuses inventory_planned_flows, product route JSON and order extra_fields.
-- No table or column is introduced.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- A protection row is stored as declared_unavailability so its lifecycle and
-- audit reuse the existing flow machinery. It advertises product scope without
-- a product_id on purpose: legacy hard-suspension readers ignore it, while the
-- protected-balance helpers below recognize the explicit mode.
create or replace function app_private.inventory_active_family_protection_v1(
  p_primary_inventory_item_id bigint,
  p_target_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_flow record;
  v_target_at timestamptz := greatest(coalesce(p_target_at, now()), now());
  v_linked_status text;
begin
  select
    flow.*,
    linked.status as linked_status,
    linked.effective_at as linked_effective_at
  into v_flow
  from public.inventory_planned_flows flow
  left join public.inventory_planned_flows linked on linked.id = flow.depends_on_flow_id
  where flow.inventory_item_id = p_primary_inventory_item_id
    and flow.flow_type = 'declared_unavailability'
    and flow.status = 'active'
    and flow.capture_details ->> 'unavailability_mode' = 'protected_balance'
  order by flow.id desc
  limit 1;

  if not found then
    return null;
  end if;

  v_linked_status := v_flow.linked_status;
  if v_flow.depends_on_flow_id is not null then
    if v_linked_status = 'fulfilled' then
      return null;
    end if;
    if v_linked_status in ('active', 'draft')
      and v_target_at >= coalesce(v_flow.linked_effective_at, v_flow.effective_at)
    then
      return null;
    end if;
    -- A cancelled or failed expectation must never reopen sales by itself.
  elsif v_flow.effective_at is not null and v_target_at >= v_flow.effective_at then
    return null;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'flow_id', v_flow.id,
    'primary_inventory_item_id', v_flow.inventory_item_id,
    'fallback_inventory_item_id',
      nullif(v_flow.capture_details ->> 'fallback_inventory_item_id', '')::bigint,
    'raw_units_per_prefried_unit',
      nullif(v_flow.capture_details ->> 'raw_units_per_prefried_unit', '')::numeric,
    'safety_reserve_units', coalesce(
      nullif(v_flow.capture_details ->> 'safety_reserve_units', '')::numeric,
      0
    ),
    'expected_flow_id', v_flow.depends_on_flow_id,
    'available_from', case
      when v_flow.depends_on_flow_id is not null and v_linked_status in ('cancelled', 'failed')
        then null
      else coalesce(v_flow.linked_effective_at, v_flow.effective_at)
    end,
    'linked_status', v_linked_status,
    'notes', v_flow.notes
  ));
end;
$$;

revoke all on function app_private.inventory_active_family_protection_v1(bigint,timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_save_protected_balance_v1(
  p_operation_id uuid,
  p_primary_inventory_item_id bigint,
  p_expected_flow_id bigint default null,
  p_safety_reserve_units numeric default 0,
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
  v_primary public.inventory_items%rowtype;
  v_fallback public.inventory_items%rowtype;
  v_recipe record;
  v_expected public.inventory_planned_flows%rowtype;
  v_previous public.inventory_planned_flows%rowtype;
  v_existing public.inventory_planned_flows%rowtype;
  v_flow_id bigint;
  v_now timestamptz := now();
  v_raw_capacity jsonb;
  v_fallback_capacity jsonb;
  v_raw_units_per_prefried_unit numeric;
  v_free_family_units numeric;
  v_reserve numeric := coalesce(p_safety_reserve_units, 0);
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo Administración o Máster pueden proteger un saldo de venta.'
      using errcode = '42501';
  end if;
  if p_operation_id is null or p_primary_inventory_item_id is null then
    raise exception 'La operación y la familia física son obligatorias.' using errcode = '22023';
  end if;
  if v_reserve < 0 then
    raise exception 'La reserva de seguridad no puede ser negativa.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'La nota admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory_protected_balance:' || p_primary_inventory_item_id::text, 0)
  );

  select flow.* into v_existing
  from public.inventory_planned_flows flow
  where flow.operation_id = p_operation_id
  limit 1;
  if found then
    if v_existing.flow_type <> 'declared_unavailability'
      or v_existing.inventory_item_id <> p_primary_inventory_item_id
      or v_existing.capture_details ->> 'unavailability_mode' <> 'protected_balance'
    then
      raise exception 'La clave idempotente ya pertenece a otra operación.' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'replayed',
      'protection_flow_id', v_existing.id,
      'primary_inventory_item_id', v_existing.inventory_item_id
    );
  end if;

  select item.* into v_primary
  from public.inventory_items item
  where item.id = p_primary_inventory_item_id
    and item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count');
  if not found then
    raise exception 'La familia física seleccionada no está activa.' using errcode = '22023';
  end if;

  select
    recipe.id,
    recipe.output_inventory_item_id,
    recipe.output_quantity_units,
    component.quantity_units as input_quantity_units
  into v_recipe
  from public.inventory_recipes recipe
  join public.inventory_recipe_components component on component.recipe_id = recipe.id
  where component.input_inventory_item_id = v_primary.id
    and recipe.recipe_kind = 'production'
    and recipe.is_active
    and recipe.lead_time_minutes > 0
    and recipe.output_quantity_units > 0
    and not exists (
      select 1 from public.inventory_recipe_components other
      where other.recipe_id = recipe.id and other.id <> component.id
    )
  order by recipe.version desc, recipe.id desc
  limit 1;
  if not found then
    raise exception '% no tiene un prefrito compatible configurado.', v_primary.name
      using errcode = '22023';
  end if;

  select item.* into v_fallback
  from public.inventory_items item
  where item.id = v_recipe.output_inventory_item_id
    and item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count');
  if not found then
    raise exception 'El prefrito compatible no está activo.' using errcode = '22023';
  end if;

  v_raw_units_per_prefried_unit := v_recipe.input_quantity_units / v_recipe.output_quantity_units;

  if p_expected_flow_id is not null then
    select flow.* into v_expected
    from public.inventory_planned_flows flow
    where flow.id = p_expected_flow_id
      and flow.inventory_item_id = v_primary.id
      and flow.flow_type = 'expected_receipt'
      and flow.status = 'active'
    for update;
    if not found then
      raise exception 'La entrada esperada ya no está activa o no pertenece a esta familia.'
        using errcode = '22023';
    end if;
    if v_expected.quantity_units is null or v_expected.quantity_units <= 0 then
      raise exception 'La entrada enlazada necesita una cantidad confirmada para reabrir ventas.'
        using errcode = '22023';
    end if;
    if v_expected.effective_at <= v_now then
      raise exception 'La fecha de la entrada esperada debe estar en el futuro.' using errcode = '22023';
    end if;
  end if;

  v_raw_capacity := app_private.inventory_item_capacity_base_v1(v_primary.id, v_now, null);
  v_fallback_capacity := app_private.inventory_item_capacity_base_v1(v_fallback.id, v_now, null);
  v_free_family_units := greatest(coalesce(
      nullif(v_raw_capacity ->> 'available_without_incoming', '')::numeric, 0
    ), 0)
    + greatest(coalesce(
      nullif(v_fallback_capacity ->> 'available_without_incoming', '')::numeric, 0
    ), 0) * v_raw_units_per_prefried_unit;

  if v_reserve > v_free_family_units then
    raise exception 'La reserva (%) supera las % unidades libres actuales de la familia.',
      trim(to_char(v_reserve, 'FM999999990.###')),
      trim(to_char(v_free_family_units, 'FM999999990.###'))
      using errcode = '22023';
  end if;

  select flow.* into v_previous
  from public.inventory_planned_flows flow
  where flow.inventory_item_id = v_primary.id
    and flow.flow_type = 'declared_unavailability'
    and flow.status = 'active'
    and flow.capture_details ->> 'unavailability_mode' = 'protected_balance'
  order by flow.id desc
  limit 1
  for update;
  if found then
    update public.inventory_planned_flows flow
    set status = 'cancelled',
        resolved_by_user_id = v_actor,
        resolved_at = v_now,
        updated_at = v_now,
        notes = concat_ws(E'\n', flow.notes, 'Reemplazada por una nueva protección de saldo.')
    where flow.id = v_previous.id;
  end if;

  insert into public.inventory_planned_flows (
    inventory_item_id, flow_type, quantity_units, effective_at, status,
    depends_on_flow_id, notes, created_by_user_id, operation_id, capture_details
  ) values (
    v_primary.id, 'declared_unavailability', null, v_expected.effective_at, 'active',
    v_expected.id, nullif(btrim(p_notes), ''), v_actor, p_operation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'declared_from', 'master_inventory',
      'unavailability_scope', 'product',
      'unavailability_mode', 'protected_balance',
      'protection_scope', 'inventory_family',
      'primary_inventory_item_id', v_primary.id,
      'primary_inventory_item_name', v_primary.name,
      'fallback_inventory_item_id', v_fallback.id,
      'fallback_inventory_item_name', v_fallback.name,
      'recipe_id', v_recipe.id,
      'raw_units_per_prefried_unit', v_raw_units_per_prefried_unit,
      'safety_reserve_units', v_reserve,
      'expected_flow_id', v_expected.id,
      'available_from', v_expected.effective_at
    ))
  ) returning id into v_flow_id;

  perform app_private.inventory_refresh_alerts_core_v1();

  return jsonb_build_object(
    'status', 'applied',
    'protection_flow_id', v_flow_id,
    'primary_inventory_item_id', v_primary.id,
    'fallback_inventory_item_id', v_fallback.id,
    'raw_units_per_prefried_unit', v_raw_units_per_prefried_unit,
    'safety_reserve_units', v_reserve,
    'free_family_units_before_reserve', v_free_family_units,
    'protected_sellable_units', greatest(v_free_family_units - v_reserve, 0),
    'available_from', v_expected.effective_at,
    'expected_flow_id', v_expected.id,
    'replaced_flow_id', v_previous.id
  );
end;
$$;

revoke all on function public.inventory_save_protected_balance_v1(uuid,bigint,bigint,numeric,text)
  from public, anon;
grant execute on function public.inventory_save_protected_balance_v1(uuid,bigint,bigint,numeric,text)
  to authenticated;

-- Calculates flexible product capacity without changing the selected physical
-- route. Fixed combos inherit the capacity of their leaf products; selectable
-- products continue to be evaluated through their selected components.
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

    for v_route in
      select route.value from jsonb_array_elements(
        app_private.inventory_product_routes_v1(v_leaf.product_id)
      ) route(value)
    loop
      v_route_with := null;
      v_route_without := null;
      if v_route ->> 'mode' = 'master_fallback' then
        v_has_fallback := true;
      end if;

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
            v_link_with := greatest(v_link_with - coalesce(
              nullif(v_protection ->> 'safety_reserve_units', '')::numeric, 0
            ), 0);
            v_link_without := greatest(v_link_without - coalesce(
              nullif(v_protection ->> 'safety_reserve_units', '')::numeric, 0
            ), 0);
          end if;
        end if;

        v_route_with := case
          when v_route_with is null then v_link_with / v_required
          else least(v_route_with, v_link_with / v_required)
        end;
        v_route_without := case
          when v_route_without is null then v_link_without / v_required
          else least(v_route_without, v_link_without / v_required)
        end;
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

-- Preserve the current commercial-suspension contract and add flexible family
-- capacity on top. This keeps ordinary shortages advisory; only an explicit
-- protected-balance flow can impose a quantity limit.
alter function public.inventory_catalog_availability_v1(timestamptz,bigint[],text)
  rename to inventory_catalog_availability_commercial_base_v1;

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
  v_result jsonb;
  v_products jsonb := '[]'::jsonb;
  v_entry record;
  v_payload jsonb;
  v_flexible jsonb;
  v_minimum numeric;
  v_primary numeric;
  v_primary_without numeric;
  v_available numeric;
  v_available_without numeric;
  v_protected boolean;
  v_fallback boolean;
  v_blocked boolean;
  v_blocked_count integer := 0;
  v_review_count integer := 0;
  v_available_count integer := 0;
begin
  v_result := public.inventory_catalog_availability_commercial_base_v1(
    p_target_at, p_product_ids, p_surface
  );

  for v_entry in
    select entry.value, entry.ordinality
    from jsonb_array_elements(coalesce(v_result -> 'products', '[]'::jsonb))
      with ordinality entry(value, ordinality)
    order by entry.ordinality
  loop
    v_payload := v_entry.value;
    v_flexible := app_private.inventory_product_flexible_capacity_v1(
      (v_payload ->> 'product_id')::bigint,
      (v_result ->> 'target_at')::timestamptz,
      null
    );

    if coalesce((v_flexible ->> 'eligible')::boolean, false)
      and coalesce((v_payload ->> 'is_commercially_suspended')::boolean, false) = false
      and v_payload ->> 'availability_state' <> 'selection_required'
    then
      v_minimum := case when coalesce((v_payload ->> 'allows_half_service')::boolean, false)
        then 0.5 else 1 end;
      v_primary := coalesce((v_flexible ->> 'primary_capacity')::numeric, 0);
      v_primary_without := coalesce((v_flexible ->> 'primary_capacity_without_incoming')::numeric, 0);
      v_available := coalesce((v_flexible ->> 'flexible_capacity')::numeric, 0);
      v_available_without := coalesce((v_flexible ->> 'flexible_capacity_without_incoming')::numeric, 0);
      v_protected := coalesce((v_flexible ->> 'protection_active')::boolean, false);
      v_fallback := coalesce((v_flexible ->> 'prefried_fallback_available')::boolean, false);
      v_blocked := v_protected and v_available < v_minimum;

      v_payload := v_payload || jsonb_build_object(
        'available_without_affecting_confirmed', v_available,
        'available_without_planned_incoming', v_available_without,
        'protected_balance_active', v_protected,
        'protected_maximum_quantity', case when v_protected then v_available else null end,
        'protected_primary_quantity', case when v_protected then v_primary else null end,
        'protected_available_component_units', case when v_protected then
          v_available * greatest(coalesce((v_payload ->> 'units_per_service')::numeric, 1), 1)
          else null end,
        'prefried_fallback_available', v_fallback,
        'prefried_fallback_required', v_primary < v_minimum and v_available >= v_minimum,
        'safety_reserve_units', coalesce((v_flexible ->> 'safety_reserve_units')::numeric, 0),
        'inventory_blocks_submission', v_blocked,
        'requires_master_review', case
          when v_blocked or (v_primary < v_minimum and v_available >= v_minimum) then true
          else coalesce((v_payload ->> 'requires_master_review')::boolean, false)
        end,
        'availability_state', case
          when v_blocked then 'unavailable'
          when v_available_without < v_minimum and v_available >= v_minimum then 'relies_on_incoming'
          when v_primary < v_minimum and v_available >= v_minimum then 'low'
          else v_payload ->> 'availability_state'
        end,
        'severity', case
          when v_blocked then 'critical'
          when v_primary < v_minimum and v_available >= v_minimum then 'warning'
          else v_payload ->> 'severity'
        end,
        'message', case
          when v_blocked then 'Se agotó el saldo protegido para esta fecha. Máster debe reponer o liberar la protección.'
          when v_protected and v_primary < v_minimum and v_available >= v_minimum then
            format('Disponible usando el respaldo prefrito autorizado por Máster. Máximo protegido: %s.',
              trim(to_char(v_available, 'FM999999990.##')))
          when v_protected then format(
            'Venta protegida hasta agotar el saldo. Máximo disponible para esta fecha: %s.',
            trim(to_char(v_available, 'FM999999990.##'))
          )
          when v_primary < v_minimum and v_available >= v_minimum then
            'La existencia cruda no alcanza, pero hay prefritos que Máster puede usar como respaldo.'
          else v_payload ->> 'message'
        end,
        'review_reason_codes', case
          when v_blocked then jsonb_build_array('protected_balance_exhausted')
          when v_primary < v_minimum and v_available >= v_minimum
            then jsonb_build_array('prefried_fallback')
          else coalesce(v_payload -> 'review_reason_codes', '[]'::jsonb)
        end
      );
    end if;

    if coalesce((v_payload ->> 'inventory_blocks_submission')::boolean, false) then
      v_blocked_count := v_blocked_count + 1;
    end if;
    if coalesce((v_payload ->> 'requires_master_review')::boolean, false) then
      v_review_count := v_review_count + 1;
    end if;
    if v_payload ->> 'availability_state' in ('available', 'low', 'not_tracked') then
      v_available_count := v_available_count + 1;
    end if;
    v_products := v_products || jsonb_build_array(jsonb_strip_nulls(v_payload));
  end loop;

  return v_result || jsonb_build_object(
    'products', v_products,
    'inventory_blocks_submission', v_blocked_count > 0,
    'summary', coalesce(v_result -> 'summary', '{}'::jsonb) || jsonb_build_object(
      'requires_master_review_count', v_review_count,
      'available_count', v_available_count,
      'protected_blocked_count', v_blocked_count
    )
  );
end;
$$;

revoke all on function public.inventory_catalog_availability_v1(timestamptz,bigint[],text)
  from public, anon;
grant execute on function public.inventory_catalog_availability_v1(timestamptz,bigint[],text)
  to authenticated;

-- Persisted split allocations keep approval, commitments and eventual sale
-- consumption on the same physical source. Raw is consumed first; only the
-- remainder uses prefried stock, and only while Máster protection is active.
alter function app_private.inventory_resolve_order_sale_v1(bigint)
  rename to inventory_resolve_order_sale_routes_base_v1;

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
    ) - v_reserve, 0);
    v_raw_allocated := least(v_requested_raw, v_raw_free);
    v_prefried_needed := greatest(v_requested_raw - v_raw_allocated, 0) / v_ratio;
    v_prefried_free := greatest(coalesce(
      nullif(v_prefried_capacity ->> 'available_without_affecting_commitments', '')::numeric, 0
    ), 0);

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

create or replace function public.inventory_refresh_order_protected_allocations_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_result jsonb;
  v_commitment jsonb;
  v_is_privileged boolean;
  v_is_counter boolean;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  select
    exists (select 1 from public.user_roles role_row where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)),
    exists (select 1 from public.user_roles role_row where role_row.user_id = v_actor
      and role_row.role = 'counter'::public.user_role)
  into v_is_privileged, v_is_counter;

  select order_row.* into v_order from public.orders order_row where order_row.id = p_order_id;
  if not found then raise exception 'La orden no existe.' using errcode = 'P0002'; end if;
  if not v_is_privileged and not (v_is_counter and v_order.source = 'walk_in') then
    raise exception 'No tienes permiso para recalcular la protección de esta orden.' using errcode = '42501';
  end if;

  v_result := app_private.inventory_prepare_order_protected_allocations_v1(p_order_id);
  if v_order.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
    and not coalesce(v_order.needs_reapproval, false)
    and not coalesce(v_order.queued_needs_reapproval, false)
  then
    v_commitment := app_private.inventory_materialize_order_commitment_v1(p_order_id, v_actor);
  end if;
  return v_result || jsonb_build_object('commitment', v_commitment);
end;
$$;

revoke all on function public.inventory_refresh_order_protected_allocations_v1(bigint)
  from public, anon;
grant execute on function public.inventory_refresh_order_protected_allocations_v1(bigint)
  to authenticated, service_role;

create or replace function app_private.inventory_resolve_order_sale_v1(p_order_id bigint)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_resolution jsonb;
  v_allocations jsonb;
  v_expanded jsonb;
  v_lines jsonb;
begin
  v_resolution := app_private.inventory_resolve_order_sale_routes_base_v1(p_order_id);
  select case
    when jsonb_typeof(order_row.extra_fields -> 'inventory_protected_allocations_v1') = 'object'
      then order_row.extra_fields -> 'inventory_protected_allocations_v1'
    else '{}'::jsonb
  end into v_allocations
  from public.orders order_row where order_row.id = p_order_id;

  if v_allocations = '{}'::jsonb then
    return v_resolution;
  end if;

  with expanded as (
    select
      (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
      case when v_allocations ? (line.value ->> 'inventory_item_id')
        then (v_allocations -> (line.value ->> 'inventory_item_id') ->> 'raw_quantity_units')::numeric
        else (line.value ->> 'quantity_units')::numeric end as quantity_units,
      line.value -> 'sources' as sources
    from jsonb_array_elements(v_resolution -> 'lines') line(value)

    union all

    select
      (allocation.value ->> 'fallback_inventory_item_id')::bigint,
      (allocation.value ->> 'fallback_quantity_units')::numeric,
      jsonb_build_array(jsonb_build_object(
        'source', 'protected_balance',
        'raw_inventory_item_id', allocation.key::bigint,
        'protection_flow_id', (allocation.value ->> 'protection_flow_id')::bigint,
        'quantity_units', (allocation.value ->> 'fallback_quantity_units')::numeric
      ))
    from jsonb_each(v_allocations) allocation(key, value)
    where (allocation.value ->> 'fallback_quantity_units')::numeric > 0
  ), grouped as (
    select
      expanded.inventory_item_id,
      sum(expanded.quantity_units) as quantity_units,
      coalesce(jsonb_agg(expanded.sources), '[]'::jsonb) as sources
    from expanded
    where expanded.quantity_units > 0
    group by expanded.inventory_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id', grouped.inventory_item_id,
    'inventory_item_name', item.name,
    'quantity_units', grouped.quantity_units,
    'sources', grouped.sources
  ) order by grouped.inventory_item_id), '[]'::jsonb)
  into v_lines
  from grouped
  join public.inventory_items item on item.id = grouped.inventory_item_id;

  return v_resolution || jsonb_build_object(
    'lines', v_lines,
    'protected_allocations', v_allocations
  );
end;
$$;

revoke all on function app_private.inventory_resolve_order_sale_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function public.approve_order(p_order_id bigint)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_advisor uuid;
  v_order_number text;
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can approve orders';
  end if;

  perform app_private.inventory_prepare_order_protected_allocations_v1(p_order_id);

  update public.orders o
  set status = 'queued', needs_reapproval = false, review_notes = null
  where o.id = p_order_id and o.status = 'created'
  returning o.attributed_advisor_id, o.order_number into v_advisor, v_order_number;
  if not found then
    raise exception 'Order % cannot be approved from its current status', p_order_id;
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (p_order_id, 'approved', auth.uid(), jsonb_build_object('order_number', v_order_number));
end;
$$;

revoke all on function public.approve_order(bigint) from public, anon;
grant execute on function public.approve_order(bigint) to authenticated, service_role;

create or replace function public.reapprove_queued_order(p_order_id bigint, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if not public.is_master_or_admin() then
    raise exception 'Only master/admin can re-approve queued orders';
  end if;

  perform app_private.inventory_prepare_order_protected_allocations_v1(p_order_id);

  update public.orders
  set queued_needs_reapproval = false,
      notes = case when p_notes is null or trim(p_notes) = '' then notes
        else coalesce(notes,'') || case when notes is null or notes = '' then '' else ' | ' end
          || 'master_reapprove=' || trim(p_notes) end
  where id = p_order_id and status = 'queued';
  if not found then
    raise exception 'Order % not found or not in queued status', p_order_id;
  end if;

  insert into public.order_events(order_id, event, performed_by, meta)
  values (p_order_id, 'queued_reapproved', auth.uid(), jsonb_build_object('notes', p_notes));
end;
$$;

revoke all on function public.reapprove_queued_order(bigint,text) from public, anon;
grant execute on function public.reapprove_queued_order(bigint,text) to authenticated, service_role;

-- Existing and future fried products use the same validated route contract.
-- Product and item identities are resolved by stable SKU/name, never by an
-- identity value generated in another database.
do $seed$
declare
  v_family record;
  v_product public.products%rowtype;
  v_raw public.inventory_items%rowtype;
  v_prefried public.inventory_items%rowtype;
  v_routes jsonb;
begin
  for v_family in
    select * from (values
      ('MINI_TEQ_F_25', 'Mini tequeño crudo', 'Mini tequeño prefrito', 25::numeric, 12::numeric),
      ('EMP_F_20', 'Empanadas Crudas', 'Empanadas Pre-Fritas', 20::numeric, 10::numeric),
      ('CACH_F_20', 'Cachitas Crudas', 'Cachitas Pre-Fritas', 20::numeric, 10::numeric),
      ('MAND_F_25', 'Mandocas Crudas', 'Mandocas Pre-Fritas', 25::numeric, 12::numeric),
      ('BOMB_F_25', 'Bombys Crudos', 'Bombys Pre-Fritos', 25::numeric, 12::numeric)
    ) family(sku, raw_name, prefried_name, full_units, half_units)
  loop
    select product.* into v_product from public.products product
    where product.sku = v_family.sku and product.inventory_policy = 'direct';
    select item.* into v_raw from public.inventory_items item
    where lower(item.name) = lower(v_family.raw_name) and item.merged_into_item_id is null;
    select item.* into v_prefried from public.inventory_items item
    where lower(item.name) = lower(v_family.prefried_name) and item.merged_into_item_id is null;

    if v_product.id is null or v_raw.id is null or v_prefried.id is null then
      raise exception 'Cambió la configuración auditada de la familia %; se detuvo la migración.', v_family.sku;
    end if;

    v_routes := jsonb_build_array(
      jsonb_build_object(
        'key', 'primary', 'name', 'Freír desde crudo', 'mode', 'primary',
        'links', jsonb_build_array(jsonb_build_object(
          'inventory_item_id', v_raw.id,
          'quantity_units', v_family.full_units,
          'half_quantity_units', v_family.half_units,
          'deduction_stage', 'kitchen'
        ))
      ),
      jsonb_build_object(
        'key', 'finish_prefried', 'name', 'Terminar desde prefrito', 'mode', 'master_fallback',
        'links', jsonb_build_array(jsonb_build_object(
          'inventory_item_id', v_prefried.id,
          'quantity_units', 1,
          'half_quantity_units', v_family.half_units / v_family.full_units,
          'deduction_stage', 'kitchen'
        ))
      )
    );
    v_routes := app_private.inventory_normalize_product_routes_v1(
      v_product.id, 'direct', true, v_routes, true
    );
    update public.products product
    set extra_fields = jsonb_set(coalesce(product.extra_fields, '{}'::jsonb),
      '{inventory_routes_v1}', v_routes, true)
    where product.id = v_product.id;
  end loop;
end;
$seed$;

comment on function public.inventory_save_protected_balance_v1(uuid,bigint,bigint,numeric,text) is
  'Master/Admin command: sell only the protected family balance, preserve a safety reserve, and optionally reopen from one known receipt.';
comment on function app_private.inventory_product_flexible_capacity_v1(bigint,timestamptz,bigint) is
  'Product capacity across primary and Master fallback routes; fixed combos inherit leaf capacity without duplicating inventory configuration.';
