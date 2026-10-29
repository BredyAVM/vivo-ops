CREATE OR REPLACE FUNCTION app_private.inventory_resolve_order_sale_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$

