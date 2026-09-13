-- Self-cleaning integration test: even success rolls every fixture write back.
-- No real order, payment, stock or customer balance is modified.
do $test$
declare
  v_admin uuid;
  v_advisor uuid;
  v_client bigint := 9000000340;
  v_product bigint := 9000000340;
  v_order bigint := 9000000340;
  v_patch jsonb;
  v_items jsonb;
  v_receipt jsonb;
  v_modified timestamptz;
  v_before jsonb;
begin
  begin
    select user_id into strict v_admin from public.user_roles where role = 'admin' limit 1;
    select user_id into strict v_advisor from public.user_roles r where role = 'advisor'
      and not exists (select 1 from public.user_roles a where a.user_id = r.user_id and a.role in ('admin', 'master')) limit 1;
    perform set_config('request.jwt.claim.sub', v_admin::text, true);

    insert into public.clients(id, full_name) values(v_client, 'ROLLBACK USD override fixture');
    insert into public.products(id, sku, name, base_price_usd, base_price_bs,
      source_price_currency, source_price_amount, is_inventory_item, inventory_enabled)
    values(v_product, 'ROLLBACK-USD-OVERRIDE', 'ROLLBACK USD product', 15, 1500, 'USD', 15, false, false);
    insert into public.orders(id, order_number, client_id, attributed_advisor_id,
      created_by_user_id, source, fulfillment, status, extra_fields)
    values(v_order, 'ROLLBACK-USD-OVERRIDE', v_client, v_advisor, v_admin, 'master', 'pickup', 'created',
      '{"pricing":{"fx_rate":100},"payment":{"client_fund_used_usd":0}}');

    v_patch := jsonb_build_object('client_id', v_client, 'attributed_advisor_id', v_advisor,
      'source', 'master', 'status', 'created', 'fulfillment', 'pickup',
      'extra_fields', '{"pricing":{"fx_rate":100},"payment":{"client_fund_used_usd":0}}'::jsonb);
    v_items := jsonb_build_array(jsonb_build_object('product_id', v_product, 'qty', 3,
      'pricing_origin_currency', 'USD', 'pricing_origin_amount', 9,
      'unit_price_usd_snapshot', 9, 'line_total_usd', 27,
      'unit_price_bs_snapshot', 900, 'line_total_bs_snapshot', 2700,
      'admin_price_override_usd', 9, 'admin_price_override_reason', 'Synthetic approved adjustment'));

    select last_modified_at into v_modified from public.orders where id = v_order;
    v_receipt := public.update_order_core_atomic_v1(v_order, v_modified, v_patch, v_items);
    assert (v_receipt ->> 'total_usd')::numeric = 27, 'authorized USD total must survive the atomic rebuild';
    assert (v_receipt ->> 'total_bs')::numeric = 2700, 'Bs total must agree with the authorized USD price';
    assert (select unit_price_usd_snapshot = 9 and line_total_usd = 27
      and admin_price_override_by_user_id = v_admin and admin_price_override_at is not null
      from public.order_items where order_id = v_order), 'persisted item and override attribution';
    assert (select total_usd = 27 and total_bs_snapshot = 2700
      and (extra_fields #>> '{pricing,total_usd}')::numeric = 27
      from public.orders where id = v_order), 'header and pricing JSON must agree';

    -- A second save uses the same override and a NEW FX. Item triggers must not
    -- recalculate Bs using the old parent FX before the command updates it.
    v_patch := jsonb_set(v_patch, '{extra_fields,pricing}',
      '{"fx_rate":125,"discount_enabled":true,"discount_pct":10,"invoice_tax_pct":16}');
    v_items := jsonb_set(v_items, '{0,unit_price_bs_snapshot}', '1125');
    v_items := jsonb_set(v_items, '{0,line_total_bs_snapshot}', '3375');
    v_items := jsonb_set(v_items, '{0,order_item_id}', v_receipt #> '{item_ids,0}');
    v_receipt := public.update_order_core_atomic_v1(v_order,
      (v_receipt ->> 'last_modified_at')::timestamptz, v_patch, v_items);
    assert (v_receipt ->> 'subtotal_usd')::numeric = 27, 'repeat save retains adjusted subtotal';
    assert (v_receipt ->> 'total_usd')::numeric = 28.19, 'discount and tax apply to adjusted USD';
    assert (v_receipt ->> 'total_bs')::numeric = 3523.5, 'new FX, discount and tax apply to Bs';

    -- A bad override must roll back deletion/reinsertion, not leave a partial order.
    select jsonb_agg(to_jsonb(i) order by i.id) into v_before from public.order_items i where order_id = v_order;
    v_items := jsonb_set(v_items, '{0,order_item_id}', v_receipt #> '{item_ids,0}');
    begin
      perform public.update_order_core_atomic_v1(v_order,
        (v_receipt ->> 'last_modified_at')::timestamptz, v_patch,
        jsonb_set(v_items, '{0,admin_price_override_reason}', '""'));
      raise exception 'invalid override unexpectedly accepted';
    exception when sqlstate '22023' then null;
    end;
    assert (select jsonb_agg(to_jsonb(i) order by i.id) = v_before from public.order_items i where order_id = v_order),
      'failed save must preserve every original item';
    assert (select total_usd = 28.19 from public.orders where id = v_order), 'failed save preserves header';

    -- Admin may set zero or increase prices too; zero must not fall back to catalog.
    update public.order_items set admin_price_override_usd = 0, pricing_origin_amount = 0,
      unit_price_usd_snapshot = 0, unit_price_bs_snapshot = 0, line_total_bs_snapshot = 0 where order_id = v_order;
    assert (select unit_price_usd_snapshot = 0 and line_total_usd = 0 from public.order_items where order_id = v_order), 'zero USD override';
    update public.order_items set admin_price_override_usd = 20, pricing_origin_amount = 20,
      unit_price_usd_snapshot = 20, unit_price_bs_snapshot = 2500, line_total_bs_snapshot = 7500 where order_id = v_order;
    assert (select unit_price_usd_snapshot = 20 and line_total_usd = 60 from public.order_items where order_id = v_order), 'upward USD override';

    -- Calling the same definer RPC as an advisor cannot authorize a cheap price.
    perform set_config('request.jwt.claim.sub', v_advisor::text, true);
    v_patch := jsonb_set(v_patch, '{source}', '"advisor"');
    select last_modified_at into v_modified from public.orders where id = v_order;
    begin
      perform public.update_order_core_atomic_v1(v_order, v_modified, v_patch, v_items);
      raise exception 'advisor override unexpectedly accepted';
    exception when sqlstate '42501' then null;
    end;
    assert (select line_total_usd = 60 from public.order_items where order_id = v_order), 'denied advisor save is atomic';

    -- Normal advisor catalog pricing remains unchanged, including forged snapshots.
    v_items := jsonb_build_array((v_items -> 0) - 'order_item_id' - 'admin_price_override_usd' - 'admin_price_override_reason');
    v_receipt := public.update_order_core_atomic_v1(v_order, v_modified, v_patch, v_items);
    assert (v_receipt ->> 'total_usd')::numeric = 46.98, 'advisor remains on catalog: 45 minus 10% plus 16%';
    assert (select unit_price_usd_snapshot = 15 from public.order_items where order_id = v_order), 'advisor supplied cheap snapshot cannot override catalog';

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    -- Legacy explicit override keeps its existing precedence.
    update public.order_items set override_unit_price_usd = 8, override_reason = 'Synthetic legacy override' where order_id = v_order;
    assert (select line_total_usd = 24 from public.order_items where order_id = v_order), 'legacy override remains effective';

    -- Counter VES uses line-level conversion: 3 Bs / 7 = .43, not .14 * 3.
    delete from public.order_items where order_id = v_order;
    update public.products set source_price_currency = 'VES', source_price_amount = 1 where id = v_product;
    update public.orders set extra_fields = '{"counter":{"quick_sale":true},"pricing":{"fx_rate":7}}' where id = v_order;
    insert into public.order_items(order_id, product_id, qty, product_name_snapshot, unit_price_usd_snapshot, line_total_usd)
    values(v_order, v_product, 3, 'ROLLBACK counter', 15, 45);
    assert (select unit_price_usd_snapshot = .14 and line_total_usd = .43 and line_total_bs_snapshot = 3
      from public.order_items where order_id = v_order), 'counter VES rounding stays unchanged';

    assert not exists(select 1 from public.inventory_movements where order_id = v_order), 'no stock movement';
    assert not exists(select 1 from public.client_fund_movements where order_id = v_order), 'no customer fund movement';
    raise exception using errcode = 'ZX001', message = 'rollback successful test fixtures';
  exception when sqlstate 'ZX001' then null;
  end;
  assert not exists(select 1 from public.orders where id = v_order), 'fixture must be rolled back';
  assert not exists(select 1 from public.products where id = v_product), 'fixture product must be rolled back';
  assert not exists(select 1 from public.clients where id = v_client), 'fixture client must be rolled back';
end;
$test$;
