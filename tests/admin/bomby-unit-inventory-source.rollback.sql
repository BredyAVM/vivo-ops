-- Execute inside BEGIN/ROLLBACK after the catalog correction. Never commit fixtures.
do $test$
declare
  v_product bigint;
  v_bomby bigint;
  v_tequeno bigint;
  v_stock numeric;
  v_tequeno_stock numeric;
  v_history jsonb;
  v_resolution jsonb;
  v_id bigint;
  v_quantity numeric;
begin
  select id into strict v_product from public.products where sku = 'BOMBY_1';
  select id, current_stock_units into strict v_bomby, v_stock from public.inventory_items
    where name = 'Bombys Crudos' and merged_into_item_id is null for update;
  select id, current_stock_units into strict v_tequeno, v_tequeno_stock from public.inventory_items
    where name = 'Mini tequeño crudo' and merged_into_item_id is null for update;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') into v_history
    from public.inventory_movements m where m.order_id in (
      select order_id from public.order_items where product_id = v_product);

  assert (select count(*) = 1 and min(inventory_item_id) = v_bomby and min(quantity_units) = 1
    from public.product_inventory_links where product_id = v_product and is_active), 'canonical one-unit link';
  assert (select (extra_fields #>> '{inventory_routes_v1,0,links,0,inventory_item_id}')::bigint = v_bomby
    from public.products where id = v_product), 'route agrees with link';

  perform set_config('request.jwt.claim.sub',
    (select user_id::text from public.user_roles where role = 'admin' limit 1), true);
  assert auth.uid() is not null, 'admin fixture context required';
  for v_id, v_quantity in values (9000000210::bigint, 1::numeric), (9000000211::bigint, 43::numeric) loop
    insert into public.orders(id, order_number, source, fulfillment, status, total_usd, extra_fields)
    values(v_id, 'ROLLBACK-BOMBY-' || v_id, 'master', 'pickup', 'created', v_quantity, '{}');
    insert into public.order_items(id, order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd, product_name_snapshot)
    values(v_id, v_id, v_product, v_quantity, 1, v_quantity, 'ROLLBACK Bomby');
    v_resolution := app_private.inventory_resolve_order_sale_v1(v_id);
    assert jsonb_array_length(v_resolution -> 'lines') = 1, 'one physical source';
    assert (v_resolution #>> '{lines,0,inventory_item_id}')::bigint = v_bomby, 'Bomby, never mini tequeno';
    assert (v_resolution #>> '{lines,0,quantity_units}')::numeric = v_quantity, 'exact unit conversion';
    update public.orders set status = 'delivered' where id = v_id;
    assert (select sum(quantity_units) = -v_quantity from public.inventory_movements
      where order_id = v_id and movement_type = 'sale_out' and inventory_item_id = v_bomby), 'actual physical consumption';
    assert not exists(select 1 from public.inventory_movements where order_id = v_id and inventory_item_id = v_tequeno), 'no tequeno movement';
  end loop;
  assert (select current_stock_units = v_stock - 44 from public.inventory_items where id = v_bomby), 'exact 44-unit delta';
  assert (select current_stock_units = v_tequeno_stock from public.inventory_items where id = v_tequeno), 'tequeno balance unchanged';
  assert v_history = (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]')
    from public.inventory_movements m where m.order_id in (
      select order_id from public.order_items where product_id = v_product)
      and m.order_id not in (9000000210, 9000000211)), 'historical movements preserved';
end;
$test$;
select 'PASS: link, route, 1/43-unit resolution and dispatch, no tequeno consumption, historical preservation' as result;
