-- Canonical fulfillment routes for products that may consume different
-- physical stock depending on an explicit Master decision.
--
-- No table or column is added. Product route configuration reuses
-- products.extra_fields, order selection reuses orders.extra_fields, the
-- primary route remains mirrored in product_inventory_links, and all physical
-- consumption continues through the existing inventory sale resolver.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function app_private.inventory_default_product_routes_v1(
  p_product_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
select case
  when product.inventory_policy not in ('self', 'direct') then '[]'::jsonb
  else jsonb_build_array(jsonb_build_object(
    'key', 'primary',
    'name', case
      when product.inventory_policy = 'self' then 'Se descuenta a sí mismo'
      else 'Ruta principal'
    end,
    'mode', 'primary',
    'links', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'inventory_item_id', link.inventory_item_id,
        'quantity_units', link.quantity_units,
        'half_quantity_units', null,
        'deduction_stage', link.deduction_stage
      )) order by link.sort_order, link.id)
      from public.product_inventory_links link
      where link.product_id = product.id
        and link.configuration_version = 1
    ), '[]'::jsonb)
  ))
end
from public.products product
where product.id = p_product_id;
$$;

revoke all on function app_private.inventory_default_product_routes_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function app_private.inventory_product_routes_v1(
  p_product_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
select case
  when jsonb_typeof(product.extra_fields -> 'inventory_routes_v1') = 'array'
    and jsonb_array_length(product.extra_fields -> 'inventory_routes_v1') > 0
  then product.extra_fields -> 'inventory_routes_v1'
  else app_private.inventory_default_product_routes_v1(product.id)
end
from public.products product
where product.id = p_product_id;
$$;

revoke all on function app_private.inventory_product_routes_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function app_private.inventory_normalize_product_routes_v1(
  p_product_id bigint,
  p_inventory_policy text,
  p_allows_half_service boolean,
  p_routes jsonb,
  p_require_active_items boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_policy text := lower(btrim(coalesce(p_inventory_policy, '')));
  v_route jsonb;
  v_link jsonb;
  v_route_key text;
  v_route_name text;
  v_route_mode text;
  v_item_id bigint;
  v_quantity numeric;
  v_half_quantity numeric;
  v_stage text;
  v_seen_route_keys text[] := array[]::text[];
  v_seen_item_ids bigint[];
  v_primary_count integer := 0;
  v_normalized_routes jsonb := '[]'::jsonb;
  v_normalized_links jsonb;
begin
  if v_policy not in ('self', 'direct') then
    if p_routes is not null
      and jsonb_typeof(p_routes) = 'array'
      and jsonb_array_length(p_routes) > 0
    then
      raise exception 'Solo los productos con descuento propio o directo admiten rutas físicas.'
        using errcode = '22023';
    end if;
    return '[]'::jsonb;
  end if;

  if p_routes is null or jsonb_typeof(p_routes) <> 'array'
    or jsonb_array_length(p_routes) not between 1 and 10
  then
    raise exception 'La configuración requiere entre 1 y 10 rutas físicas.'
      using errcode = '22023';
  end if;

  for v_route in
    select route_row.value
    from jsonb_array_elements(p_routes) with ordinality route_row(value, ordinal)
    order by route_row.ordinal
  loop
    v_route_key := lower(btrim(coalesce(v_route ->> 'key', '')));
    v_route_name := btrim(coalesce(v_route ->> 'name', ''));
    v_route_mode := lower(btrim(coalesce(v_route ->> 'mode', '')));

    if v_route_key = '' or char_length(v_route_key) > 48
      or v_route_key !~ '^[a-z][a-z0-9_]*$'
    then
      raise exception 'Cada ruta requiere una clave simple de hasta 48 caracteres.'
        using errcode = '22023';
    end if;
    if v_route_key = any(v_seen_route_keys) then
      raise exception 'La ruta % está repetida.', v_route_key using errcode = '22023';
    end if;
    v_seen_route_keys := array_append(v_seen_route_keys, v_route_key);

    if v_route_name = '' or char_length(v_route_name) > 100 then
      raise exception 'Cada ruta requiere un nombre de hasta 100 caracteres.'
        using errcode = '22023';
    end if;
    if v_route_mode not in ('primary', 'master_fallback') then
      raise exception 'El modo de la ruta no es válido.' using errcode = '22023';
    end if;
    if v_route_mode = 'primary' then
      v_primary_count := v_primary_count + 1;
      if v_route_key <> 'primary' then
        raise exception 'La ruta principal debe usar la clave primary.' using errcode = '22023';
      end if;
    elsif v_route_key = 'primary' then
      raise exception 'La clave primary está reservada para la ruta principal.' using errcode = '22023';
    end if;

    if jsonb_typeof(v_route -> 'links') <> 'array'
      or jsonb_array_length(v_route -> 'links') not between 1 and 50
    then
      raise exception 'Cada ruta requiere entre 1 y 50 consumos físicos.'
        using errcode = '22023';
    end if;

    v_seen_item_ids := array[]::bigint[];
    v_normalized_links := '[]'::jsonb;
    for v_link in
      select link_row.value
      from jsonb_array_elements(v_route -> 'links') with ordinality link_row(value, ordinal)
      order by link_row.ordinal
    loop
      v_item_id := nullif(btrim(coalesce(v_link ->> 'inventory_item_id', '')), '')::bigint;
      v_quantity := nullif(btrim(coalesce(v_link ->> 'quantity_units', '')), '')::numeric;
      v_half_quantity := nullif(btrim(coalesce(v_link ->> 'half_quantity_units', '')), '')::numeric;
      v_stage := nullif(lower(btrim(coalesce(v_link ->> 'deduction_stage', ''))), '');

      if v_item_id is null or v_item_id = any(v_seen_item_ids) then
        raise exception 'Un ítem físico no puede repetirse dentro de la misma ruta.'
          using errcode = '22023';
      end if;
      v_seen_item_ids := array_append(v_seen_item_ids, v_item_id);
      if v_quantity is null or v_quantity <= 0 then
        raise exception 'Cada consumo completo debe ser mayor que cero.' using errcode = '22023';
      end if;
      if v_half_quantity is not null and (
        not coalesce(p_allows_half_service, false)
        or v_half_quantity <= 0
        or v_half_quantity >= v_quantity
      ) then
        raise exception 'El consumo de medio servicio debe ser positivo, menor al completo y solo aplica cuando el producto admite medio servicio.'
          using errcode = '22023';
      end if;
      if v_stage is not null and v_stage not in ('kitchen','production','packing','fulfillment') then
        raise exception 'La etapa de descuento no es válida.' using errcode = '22023';
      end if;
      if not exists (
        select 1
        from public.inventory_items item
        where item.id = v_item_id
          and item.merged_into_item_id is null
          and (
            not p_require_active_items
            or (item.is_active and item.tracking_mode <> 'not_tracked')
          )
      ) then
        raise exception 'Uno de los ítems de la ruta no existe o no está operativo.'
          using errcode = '22023';
      end if;

      v_normalized_links := v_normalized_links || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'inventory_item_id', v_item_id,
          'quantity_units', v_quantity,
          'half_quantity_units', v_half_quantity,
          'deduction_stage', v_stage
        ))
      );
    end loop;

    v_normalized_routes := v_normalized_routes || jsonb_build_array(jsonb_build_object(
      'key', v_route_key,
      'name', v_route_name,
      'mode', v_route_mode,
      'links', v_normalized_links
    ));
  end loop;

  if v_primary_count <> 1 then
    raise exception 'La configuración requiere exactamente una ruta principal.'
      using errcode = '22023';
  end if;
  if v_policy = 'self' and (
    jsonb_array_length(v_normalized_routes) <> 1
    or jsonb_array_length(v_normalized_routes -> 0 -> 'links') <> 1
  ) then
    raise exception 'Un producto que se descuenta a sí mismo solo admite su ruta principal y un ítem físico.'
      using errcode = '22023';
  end if;

  return v_normalized_routes;
end;
$$;

revoke all on function app_private.inventory_normalize_product_routes_v1(bigint,text,boolean,jsonb,boolean)
  from public, anon, authenticated, service_role;

-- Preserve the existing public draft RPC and enrich its already-atomic write
-- with validated routes. The private structural core remains unchanged.
create or replace function public.inventory_save_catalog_draft_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_product jsonb;
  v_product_id bigint;
  v_current public.products%rowtype;
  v_routes jsonb;
  v_commission_mode text;
  v_commission_value numeric;
  v_commission_notes text;
  v_advisor_gift_cost_usd numeric;
  v_advisor_gift_cost_provided boolean := false;
  v_internal_rider_pay_usd numeric;
begin
  v_result := app_private.inventory_save_catalog_draft_core_v1(p_configuration);
  if coalesce(v_result ->> 'entry_kind', '') <> 'product' then
    return v_result;
  end if;

  v_product_id := nullif(v_result ->> 'product_id', '')::bigint;
  v_product := p_configuration -> 'product';
  select product.* into v_current
  from public.products product
  where product.id = v_product_id
  for update;
  if not found then
    raise exception 'Supabase no devolvió el producto configurado.' using errcode = 'P0002';
  end if;

  if v_current.inventory_policy in ('self', 'direct') then
    v_routes := app_private.inventory_normalize_product_routes_v1(
      v_current.id,
      v_current.inventory_policy,
      v_current.allows_half_service,
      case
        when jsonb_typeof(p_configuration -> 'routes') = 'array'
          then p_configuration -> 'routes'
        else app_private.inventory_default_product_routes_v1(v_current.id)
      end,
      false
    );
    update public.products product
    set extra_fields = jsonb_set(
      coalesce(product.extra_fields, '{}'::jsonb),
      '{inventory_routes_v1}',
      v_routes,
      true
    )
    where product.id = v_current.id;
  else
    update public.products product
    set extra_fields = coalesce(product.extra_fields, '{}'::jsonb) - 'inventory_routes_v1'
    where product.id = v_current.id;
    v_routes := '[]'::jsonb;
  end if;

  v_commission_mode := case
    when v_product ? 'commission_mode' then lower(btrim(coalesce(v_product ->> 'commission_mode', '')))
    else v_current.commission_mode
  end;
  v_commission_value := case
    when v_product ? 'commission_value' then nullif(btrim(coalesce(v_product ->> 'commission_value', '')), '')::numeric
    else v_current.commission_value
  end;
  v_commission_notes := case
    when v_product ? 'commission_notes' then nullif(btrim(coalesce(v_product ->> 'commission_notes', '')), '')
    else v_current.commission_notes
  end;
  v_advisor_gift_cost_provided := v_product ? 'advisor_gift_cost_usd';
  if v_advisor_gift_cost_provided then
    v_advisor_gift_cost_usd := nullif(btrim(coalesce(v_product ->> 'advisor_gift_cost_usd', '')), '')::numeric;
  end if;
  v_internal_rider_pay_usd := case
    when v_product ? 'internal_rider_pay_usd' then nullif(btrim(coalesce(v_product ->> 'internal_rider_pay_usd', '')), '')::numeric
    else v_current.internal_rider_pay_usd
  end;

  if v_commission_mode not in ('default', 'fixed_item', 'fixed_order') then
    raise exception 'La modalidad de comisión no es válida.' using errcode = '22023';
  end if;
  if v_commission_mode = 'default' then
    v_commission_value := null;
  elsif v_commission_value is null or v_commission_value < 0 or v_commission_value > 100 then
    raise exception 'La comisión específica debe ser un porcentaje entre 0 y 100.' using errcode = '22023';
  end if;
  if v_commission_notes is not null and char_length(v_commission_notes) > 1000 then
    raise exception 'La nota de comisión admite hasta 1.000 caracteres.' using errcode = '22023';
  end if;
  if v_advisor_gift_cost_usd is not null and v_advisor_gift_cost_usd < 0 then
    raise exception 'El costo para el asesor no puede ser negativo.' using errcode = '22023';
  end if;
  if v_internal_rider_pay_usd is not null and v_internal_rider_pay_usd < 0 then
    raise exception 'El pago interno de delivery no puede ser negativo.' using errcode = '22023';
  end if;

  update public.products product
  set commission_mode = v_commission_mode,
      commission_value = v_commission_value,
      commission_notes = v_commission_notes,
      extra_fields = case
        when not v_advisor_gift_cost_provided then coalesce(product.extra_fields, '{}'::jsonb)
        when v_advisor_gift_cost_usd is null then coalesce(product.extra_fields, '{}'::jsonb) - 'advisor_gift_cost_usd'
        else jsonb_set(coalesce(product.extra_fields, '{}'::jsonb), '{advisor_gift_cost_usd}', to_jsonb(v_advisor_gift_cost_usd), true)
      end,
      internal_rider_pay_usd = v_internal_rider_pay_usd
  where product.id = v_product_id;

  return v_result || jsonb_build_object(
    'commission_mode', v_commission_mode,
    'commission_value', v_commission_value,
    'advisor_gift_cost_usd', v_advisor_gift_cost_usd,
    'internal_rider_pay_usd', v_internal_rider_pay_usd,
    'route_count', jsonb_array_length(v_routes)
  );
end;
$$;

revoke all on function public.inventory_save_catalog_draft_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_save_catalog_draft_v1(jsonb)
  to authenticated, service_role;

create or replace function public.inventory_update_product_routes_v1(
  p_configuration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_policy text := lower(btrim(coalesce(p_configuration ->> 'inventory_policy', '')));
  v_routes jsonb;
  v_primary_links jsonb := '[]'::jsonb;
  v_previous_routes jsonb;
  v_result jsonb;
  v_extra jsonb;
  v_history jsonb;
  v_last_index integer;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor and role_row.role = 'admin'::public.user_role
  ) then
    raise exception 'Solo administración puede versionar rutas físicas.' using errcode = '42501';
  end if;
  if p_configuration is null or jsonb_typeof(p_configuration) <> 'object' then
    raise exception 'La configuración de rutas no es válida.' using errcode = '22023';
  end if;

  select product.* into v_product
  from public.products product
  where product.id = (p_configuration ->> 'product_id')::bigint
  for update;
  if not found then
    raise exception 'El producto no existe.' using errcode = 'P0002';
  end if;

  v_previous_routes := app_private.inventory_product_routes_v1(v_product.id);
  v_routes := app_private.inventory_normalize_product_routes_v1(
    v_product.id,
    v_policy,
    v_product.allows_half_service,
    coalesce(p_configuration -> 'routes', '[]'::jsonb),
    true
  );
  if v_policy in ('self', 'direct') then
    select route.value -> 'links' into v_primary_links
    from jsonb_array_elements(v_routes) route(value)
    where route.value ->> 'key' = 'primary';
  end if;

  v_result := public.inventory_update_product_physical_configuration_v1(
    (p_configuration - 'routes') || jsonb_build_object('links', coalesce(v_primary_links, '[]'::jsonb))
  );

  select product.extra_fields into v_extra
  from public.products product
  where product.id = v_product.id
  for update;
  v_history := case
    when jsonb_typeof(v_extra -> 'inventory_physical_history') = 'array'
      then v_extra -> 'inventory_physical_history'
    else '[]'::jsonb
  end;
  v_last_index := jsonb_array_length(v_history) - 1;
  if v_last_index >= 0 then
    v_history := jsonb_set(
      v_history,
      array[v_last_index::text],
      (v_history -> v_last_index) || jsonb_build_object('routes', coalesce(v_previous_routes, '[]'::jsonb)),
      true
    );
  end if;

  v_extra := jsonb_set(v_extra, '{inventory_physical_history}', v_history, true);
  if v_policy in ('self', 'direct') then
    v_extra := jsonb_set(v_extra, '{inventory_routes_v1}', v_routes, true);
  else
    v_extra := v_extra - 'inventory_routes_v1';
  end if;
  update public.products product set extra_fields = v_extra where product.id = v_product.id;

  return v_result || jsonb_build_object(
    'route_count', jsonb_array_length(v_routes),
    'routes', v_routes
  );
end;
$$;

revoke all on function public.inventory_update_product_routes_v1(jsonb)
  from public, anon;
grant execute on function public.inventory_update_product_routes_v1(jsonb)
  to authenticated, service_role;

-- The legacy diagnostic remains the authoritative primary-route resolver. This
-- wrapper replaces only the contributions explicitly rerouted by Master.
create or replace function app_private.inventory_resolve_order_sale_v1(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_diagnostics jsonb;
  v_first_error jsonb;
  v_selections jsonb;
  v_selection record;
  v_order_item_id bigint;
  v_product_id bigint;
  v_lines jsonb;
begin
  v_diagnostics := app_private.inventory_order_sale_diagnostics_v1(p_order_id);
  if jsonb_array_length(v_diagnostics -> 'errors') > 0 then
    v_first_error := v_diagnostics -> 'errors' -> 0;
    raise exception '[%] %', v_first_error ->> 'code', v_first_error ->> 'message'
      using errcode = '22023', detail = (v_diagnostics -> 'errors')::text;
  end if;

  select case
    when jsonb_typeof(order_row.extra_fields -> 'inventory_route_selections') = 'object'
      then order_row.extra_fields -> 'inventory_route_selections'
    else '{}'::jsonb
  end into v_selections
  from public.orders order_row
  where order_row.id = p_order_id;

  for v_selection in select entry.key, entry.value from jsonb_each_text(v_selections) entry
  loop
    if v_selection.key !~ '^[1-9][0-9]*:[1-9][0-9]*$' then
      raise exception 'La orden contiene una selección de ruta con formato inválido.' using errcode = '22023';
    end if;
    v_order_item_id := split_part(v_selection.key, ':', 1)::bigint;
    v_product_id := split_part(v_selection.key, ':', 2)::bigint;
    if v_selection.value <> 'primary' and not exists (
      select 1
      from public.order_items order_item
      join public.products product on product.id = order_item.product_id
      cross join lateral jsonb_array_elements(app_private.inventory_product_routes_v1(product.id)) route(value)
      where order_item.id = v_order_item_id
        and order_item.order_id = p_order_id
        and order_item.product_id = v_product_id
        and route.value ->> 'key' = v_selection.value
        and route.value ->> 'mode' = 'master_fallback'
    ) then
      raise exception 'La ruta % ya no es válida para esta orden.', v_selection.value using errcode = '22023';
    end if;
  end loop;

  with base_sources as (
    select
      (line.value ->> 'inventory_item_id')::bigint as inventory_item_id,
      line.value ->> 'inventory_item_name' as inventory_item_name,
      source.value as source
    from jsonb_array_elements(v_diagnostics -> 'lines') line(value)
    cross join lateral jsonb_array_elements(line.value -> 'sources') source(value)
  ),
  kept_sources as (
    select source.inventory_item_id, source.inventory_item_name, source.source
    from base_sources source
    where coalesce(
      v_selections ->> format(
        '%s:%s',
        source.source ->> 'order_item_id',
        source.source ->> 'leaf_product_id'
      ),
      'primary'
    ) = 'primary'
  ),
  alternate_sources as (
    select
      inventory_item.id as inventory_item_id,
      inventory_item.name as inventory_item_name,
      jsonb_build_object(
        'order_item_id', order_item.id,
        'root_product_id', product.id,
        'leaf_product_id', product.id,
        'route_key', selection.value,
        'quantity_units',
          trunc(order_item.qty) * (link.value ->> 'quantity_units')::numeric
          + case
              when order_item.qty - trunc(order_item.qty) = 0.5
              then coalesce(
                nullif(link.value ->> 'half_quantity_units', '')::numeric,
                floor((link.value ->> 'quantity_units')::numeric / 2)
              )
              else 0
            end
      ) as source
    from jsonb_each_text(v_selections) selection
    join public.order_items order_item
      on order_item.id = split_part(selection.key, ':', 1)::bigint
     and order_item.order_id = p_order_id
    join public.products product
      on product.id = order_item.product_id
     and product.id = split_part(selection.key, ':', 2)::bigint
    cross join lateral jsonb_array_elements(app_private.inventory_product_routes_v1(product.id)) route(value)
    cross join lateral jsonb_array_elements(route.value -> 'links') link(value)
    join public.inventory_items inventory_item
      on inventory_item.id = (link.value ->> 'inventory_item_id')::bigint
    where selection.value <> 'primary'
      and route.value ->> 'key' = selection.value
  ),
  all_sources as (
    select * from kept_sources
    union all
    select * from alternate_sources
  ),
  grouped as (
    select
      source.inventory_item_id,
      source.inventory_item_name,
      sum((source.source ->> 'quantity_units')::numeric) as quantity_units,
      jsonb_agg(source.source order by (source.source ->> 'order_item_id')::bigint) as sources
    from all_sources source
    where (source.source ->> 'quantity_units')::numeric > 0
    group by source.inventory_item_id, source.inventory_item_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id', grouped.inventory_item_id,
    'inventory_item_name', grouped.inventory_item_name,
    'quantity_units', grouped.quantity_units,
    'sources', grouped.sources
  ) order by grouped.inventory_item_id), '[]'::jsonb)
  into v_lines
  from grouped;

  return (v_diagnostics - 'errors') || jsonb_build_object(
    'status', 'resolved',
    'lines', v_lines,
    'route_selections', v_selections
  );
end;
$$;

revoke all on function app_private.inventory_resolve_order_sale_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function public.inventory_order_route_options_v1(
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
  v_effective_at timestamptz;
  v_order_item record;
  v_route jsonb;
  v_link jsonb;
  v_capacity jsonb;
  v_routes jsonb;
  v_route_lines jsonb;
  v_options jsonb := '[]'::jsonb;
  v_requested numeric;
  v_decision text;
  v_selection_key text;
  v_selected_route text;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  select order_row.* into v_order from public.orders order_row where order_row.id = p_order_id;
  if not found then
    raise exception 'La orden no existe.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo administración o Máster pueden evaluar rutas alternativas.' using errcode = '42501';
  end if;

  v_effective_at := app_private.inventory_order_effective_at_v1(p_order_id);
  for v_order_item in
    select order_item.id, order_item.product_id, order_item.qty, product.name as product_name,
           product.allows_half_service
    from public.order_items order_item
    join public.products product on product.id = order_item.product_id
    where order_item.order_id = p_order_id
      and product.inventory_policy in ('self', 'direct')
    order by order_item.id
  loop
    v_routes := app_private.inventory_product_routes_v1(v_order_item.product_id);
    if coalesce(jsonb_array_length(v_routes), 0) <= 1 then
      continue;
    end if;
    v_selection_key := format('%s:%s', v_order_item.id, v_order_item.product_id);
    v_selected_route := coalesce(
      v_order.extra_fields -> 'inventory_route_selections' ->> v_selection_key,
      'primary'
    );

    declare
      v_route_payloads jsonb := '[]'::jsonb;
    begin
      for v_route in select value from jsonb_array_elements(v_routes)
      loop
        v_route_lines := '[]'::jsonb;
        v_decision := 'available';
        for v_link in select value from jsonb_array_elements(v_route -> 'links')
        loop
          v_requested := trunc(v_order_item.qty) * (v_link ->> 'quantity_units')::numeric
            + case when v_order_item.qty - trunc(v_order_item.qty) = 0.5
                then coalesce(
                  nullif(v_link ->> 'half_quantity_units', '')::numeric,
                  floor((v_link ->> 'quantity_units')::numeric / 2)
                ) else 0 end;
          v_capacity := app_private.inventory_item_capacity_v1(
            (v_link ->> 'inventory_item_id')::bigint,
            v_effective_at,
            p_order_id
          );
          if v_capacity ->> 'status' in ('outside_horizon', 'requires_opening') then
            v_decision := v_capacity ->> 'status';
          elsif nullif(v_capacity ->> 'available_without_affecting_commitments', '')::numeric < v_requested then
            v_decision := 'insufficient';
          elsif v_decision = 'available'
            and nullif(v_capacity ->> 'available_without_incoming', '')::numeric < v_requested
          then
            v_decision := 'relies_on_incoming';
          end if;
          v_route_lines := v_route_lines || jsonb_build_array(
            v_link || v_capacity || coalesce((
              select jsonb_build_object('inventory_item_name', item.name, 'unit_name', item.unit_name)
              from public.inventory_items item
              where item.id = (v_link ->> 'inventory_item_id')::bigint
            ), '{}'::jsonb) || jsonb_build_object('requested_quantity_units', v_requested)
          );
        end loop;
        v_route_payloads := v_route_payloads || jsonb_build_array(
          (v_route - 'links') || jsonb_build_object(
            'selected', v_route ->> 'key' = v_selected_route,
            'decision', v_decision,
            'lines', v_route_lines
          )
        );
      end loop;
      v_options := v_options || jsonb_build_array(jsonb_build_object(
        'order_item_id', v_order_item.id,
        'product_id', v_order_item.product_id,
        'product_name', v_order_item.product_name,
        'order_quantity', v_order_item.qty,
        'selected_route_key', v_selected_route,
        'routes', v_route_payloads
      ));
    end;
  end loop;

  return jsonb_build_object(
    'status', 'ready',
    'order_id', p_order_id,
    'calculated_at', now(),
    'effective_at', v_effective_at,
    'options', v_options,
    'orders_blocked', false
  );
end;
$$;

revoke all on function public.inventory_order_route_options_v1(bigint)
  from public, anon;
grant execute on function public.inventory_order_route_options_v1(bigint)
  to authenticated;

create or replace function public.inventory_select_order_item_route_v1(
  p_order_item_id bigint,
  p_route_key text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_order_item record;
  v_order public.orders%rowtype;
  v_route jsonb;
  v_route_key text := lower(btrim(coalesce(p_route_key, '')));
  v_selection_key text;
  v_selections jsonb;
  v_commitment jsonb;
begin
  if v_actor is null then
    raise exception 'Autenticación requerida.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.user_roles role_row
    where role_row.user_id = v_actor
      and role_row.role in ('admin'::public.user_role, 'master'::public.user_role)
  ) then
    raise exception 'Solo administración o Máster pueden seleccionar una ruta alternativa.' using errcode = '42501';
  end if;

  select order_item.id, order_item.order_id, order_item.product_id, product.name as product_name
  into v_order_item
  from public.order_items order_item
  join public.products product on product.id = order_item.product_id
  where order_item.id = p_order_item_id;
  if not found then
    raise exception 'La línea de la orden no existe.' using errcode = 'P0002';
  end if;

  select order_row.* into v_order
  from public.orders order_row
  where order_row.id = v_order_item.order_id
  for update;
  if v_order.status in ('delivered'::public.order_status, 'cancelled'::public.order_status) then
    raise exception 'Una orden cerrada no puede cambiar su ruta física.' using errcode = '22023';
  end if;

  select route.value into v_route
  from jsonb_array_elements(app_private.inventory_product_routes_v1(v_order_item.product_id)) route(value)
  where route.value ->> 'key' = v_route_key;
  if not found then
    raise exception 'La ruta seleccionada no existe para este producto.' using errcode = '22023';
  end if;
  if v_route_key <> 'primary' and v_route ->> 'mode' <> 'master_fallback' then
    raise exception 'La ruta seleccionada no admite decisión del Máster.' using errcode = '22023';
  end if;

  v_selection_key := format('%s:%s', v_order_item.id, v_order_item.product_id);
  v_selections := case
    when jsonb_typeof(v_order.extra_fields -> 'inventory_route_selections') = 'object'
      then v_order.extra_fields -> 'inventory_route_selections'
    else '{}'::jsonb
  end;
  v_selections := jsonb_set(v_selections, array[v_selection_key], to_jsonb(v_route_key), true);

  update public.orders order_row
  set extra_fields = jsonb_set(
        coalesce(order_row.extra_fields, '{}'::jsonb),
        '{inventory_route_selections}',
        v_selections,
        true
      ),
      last_modified_by = v_actor,
      updated_at = now()
  where order_row.id = v_order.id;

  insert into public.order_timeline_events (
    order_id, order_number, event_type, event_group, title, message,
    severity, actor_user_id, payload
  ) values (
    v_order.id, v_order.order_number, 'inventory_route_selected', 'inventory',
    'Ruta física actualizada',
    format('%s: %s.', v_order_item.product_name, v_route ->> 'name'),
    case when v_route_key = 'primary' then 'info' else 'warning' end,
    v_actor,
    jsonb_strip_nulls(jsonb_build_object(
      'order_item_id', v_order_item.id,
      'product_id', v_order_item.product_id,
      'route_key', v_route_key,
      'route_name', v_route ->> 'name',
      'note', nullif(btrim(coalesce(p_note, '')), '')
    ))
  );

  if v_order.status in (
    'queued'::public.order_status, 'confirmed'::public.order_status,
    'in_kitchen'::public.order_status, 'ready'::public.order_status,
    'out_for_delivery'::public.order_status
  ) and not coalesce(v_order.needs_reapproval, false)
    and not coalesce(v_order.queued_needs_reapproval, false)
  then
    v_commitment := app_private.inventory_materialize_order_commitment_v1(v_order.id, v_actor);
  end if;

  return jsonb_build_object(
    'status', 'selected',
    'order_id', v_order.id,
    'order_item_id', v_order_item.id,
    'product_id', v_order_item.product_id,
    'route_key', v_route_key,
    'route_name', v_route ->> 'name',
    'commitment', v_commitment,
    'orders_blocked', false
  );
end;
$$;

revoke all on function public.inventory_select_order_item_route_v1(bigint,text,text)
  from public, anon;
grant execute on function public.inventory_select_order_item_route_v1(bigint,text,text)
  to authenticated;

-- Certified current example: Cachitas fritas normally consume raw pieces, but
-- Master may explicitly finish prefried stock when operations require it.
do $seed$
declare
  v_routes jsonb;
begin
  if not exists (
    select 1 from public.products product
    where product.id = 11 and product.sku = 'CACH_F_20'
      and product.inventory_policy = 'direct'
  ) or not exists (
    select 1 from public.inventory_items item
    where item.id = 13 and item.name = 'Cachitas Crudas'
  ) or not exists (
    select 1 from public.inventory_items item
    where item.id = 15 and item.name = 'Cachitas Pre-Fritas'
  ) then
    raise exception 'La configuración auditada de Cachitas cambió; se detuvo la ruta alternativa.';
  end if;

  v_routes := jsonb_build_array(
    jsonb_build_object(
      'key', 'primary', 'name', 'Freír desde crudo', 'mode', 'primary',
      'links', jsonb_build_array(jsonb_build_object(
        'inventory_item_id', 13, 'quantity_units', 20,
        'half_quantity_units', 10, 'deduction_stage', 'kitchen'
      ))
    ),
    jsonb_build_object(
      'key', 'finish_prefried', 'name', 'Terminar desde prefrito', 'mode', 'master_fallback',
      'links', jsonb_build_array(jsonb_build_object(
        'inventory_item_id', 15, 'quantity_units', 1,
        'half_quantity_units', 0.5, 'deduction_stage', 'kitchen'
      ))
    )
  );
  v_routes := app_private.inventory_normalize_product_routes_v1(11, 'direct', true, v_routes, true);
  update public.products product
  set extra_fields = jsonb_set(
    coalesce(product.extra_fields, '{}'::jsonb),
    '{inventory_routes_v1}',
    v_routes,
    true
  )
  where product.id = 11;
end;
$seed$;

comment on function app_private.inventory_product_routes_v1(bigint) is
  'Canonical validated route reader. Reuses products.extra_fields and synthesizes the legacy primary route when needed.';
comment on function public.inventory_update_product_routes_v1(jsonb) is
  'Admin-only versioned route writer. Mirrors only the primary route to product_inventory_links and preserves prior routes in physical history.';
comment on function public.inventory_order_route_options_v1(bigint) is
  'Current non-blocking route alternatives for Master order review, including physical units and dated capacity.';
comment on function public.inventory_select_order_item_route_v1(bigint,text,text) is
  'Master/Admin route selector stored in orders.extra_fields; rebuilds commitments and never blocks the order process.';
