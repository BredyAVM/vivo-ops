CREATE OR REPLACE FUNCTION app_private.inventory_resolve_order_sale_routes_base_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$

