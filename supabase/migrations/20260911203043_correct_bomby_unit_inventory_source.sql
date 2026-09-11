-- Applied as 20260911203043. User-confirmed: BOMBY_1 consumes one Bombys Crudos unit.
-- Catalog only: preserve activation, prices, orders, commitments and stock ledger.
set lock_timeout = '5s';
set statement_timeout = '30s';

do $correction$
declare
  v_product public.products%rowtype;
  v_link public.product_inventory_links%rowtype;
  v_old_item bigint;
  v_new_item bigint;
  v_routes jsonb;
begin
  select * into strict v_product from public.products where sku = 'BOMBY_1' for update;
  select id into strict v_old_item from public.inventory_items
    where name = 'Mini tequeño crudo' and merged_into_item_id is null;
  select id into strict v_new_item from public.inventory_items
    where name = 'Bombys Crudos' and merged_into_item_id is null
      and is_active and inventory_group = 'raw' and unit_name = 'pieza'
      and tracking_mode = 'transactional';
  select * into strict v_link from public.product_inventory_links
    where product_id = v_product.id and is_active for update;
  v_routes := v_product.extra_fields -> 'inventory_routes_v1';

  -- Re-running this exact correction must not duplicate its audit record.
  if v_product.extra_fields ? 'bomby_unit_source_correction_v1'
    and v_link.inventory_item_id = v_new_item and v_link.quantity_units = 1
    and (v_routes #>> '{0,links,0,inventory_item_id}')::bigint = v_new_item
    and (v_routes #>> '{0,links,0,quantity_units}')::numeric = 1 then
    return;
  end if;

  if v_product.inventory_policy <> 'direct' or not v_product.inventory_enabled
    or v_product.units_per_service <> 1 or v_link.quantity_units <> 1
    or v_link.inventory_item_id <> v_old_item
    or v_link.configuration_version <> 1
    or v_link.deduction_stage is distinct from 'kitchen'
    or jsonb_typeof(v_routes) is distinct from 'array'
    or jsonb_array_length(v_routes) <> 1
    or v_routes #>> '{0,key}' is distinct from 'primary'
    or v_routes #>> '{0,mode}' is distinct from 'primary'
    or jsonb_typeof(v_routes #> '{0,links}') is distinct from 'array'
    or jsonb_array_length(v_routes #> '{0,links}') <> 1
    or (v_routes #>> '{0,links,0,inventory_item_id}')::bigint is distinct from v_old_item
    or (v_routes #>> '{0,links,0,quantity_units}')::numeric is distinct from 1
  then
    raise exception 'BOMBY_1 cambió desde la auditoría; revisar antes de corregir.';
  end if;

  -- The audited product has no parents or open orders. Do not silently change
  -- an in-flight commitment if this precondition changes before application.
  if exists (select 1 from public.product_components where component_product_id = v_product.id)
    or exists (select 1 from public.orders o join public.order_items i on i.order_id = o.id
      where i.product_id = v_product.id and o.status not in ('cancelled', 'delivered')) then
    raise exception 'BOMBY_1 tiene dependencias u órdenes abiertas; revisar el corte primero.';
  end if;

  update public.product_inventory_links set inventory_item_id = v_new_item where id = v_link.id;
  update public.products
  set extra_fields = jsonb_set(extra_fields, '{inventory_routes_v1,0,links,0,inventory_item_id}',
        to_jsonb(v_new_item), false)
      || jsonb_build_object('bomby_unit_source_correction_v1', jsonb_build_object(
        'recorded_at', now(), 'authorization', 'Owner confirmed in financial task on 2026-09-11',
        'reason', 'Bomby por unidad descuenta una unidad de Bombys Crudos, no mini tequeño.',
        'previous_routes', v_routes, 'previous_link', to_jsonb(v_link),
        'new_inventory_item_id', v_new_item, 'quantity_units', 1,
        'historical_movements_changed', false))
  where id = v_product.id;
end;
$correction$;
