-- Inventory Block 5 transaction tests.
-- Prerequisite: 20260807190101_inventory_sale_resolver_v1.sql.
-- Every mutation is rolled back.

begin;

do $$
declare
  v_admin uuid;
  v_advisor uuid;
  v_source public.order_source;
  v_fulfillment public.fulfillment_type;
  v_order_id bigint;
  v_empty_order_id bigint;
  v_bad_order_id bigint;
  v_single_order_item_id bigint;
  v_resolution jsonb;
  v_opening jsonb;
  v_count_id bigint;
  v_operation uuid := 'b5000000-0000-4000-8000-000000000001';
  v_reversal uuid := 'b5000000-0000-4000-8000-000000000002';
  v_recommit uuid := 'b5000000-0000-4000-8000-000000000003';
  v_empty_operation uuid := 'b5000000-0000-4000-8000-000000000004';
  v_legacy_order_id bigint;
  v_failed boolean;
begin
  select role_row.user_id
  into v_admin
  from public.user_roles role_row
  where role_row.role = 'admin'
  order by role_row.user_id
  limit 1;

  if v_admin is null then
    raise exception 'Block 5 tests require one existing admin user.';
  end if;

  select role_row.user_id
  into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1
      from public.user_roles privileged
      where privileged.user_id = role_row.user_id
        and privileged.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  if v_advisor is null then
    raise exception 'Block 5 tests require one advisor without admin/master authority.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  select order_row.source, order_row.fulfillment
  into v_source, v_fulfillment
  from public.orders order_row
  where order_row.fulfillment = 'pickup'
  order by order_row.id
  limit 1;

  insert into public.orders (
    order_number,
    created_by_user_id,
    source,
    fulfillment,
    status,
    total_usd,
    extra_fields
  )
  values (
    'TEST-INV-B5-MIXED',
    v_admin,
    v_source,
    v_fulfillment,
    'delivered',
    0,
    '{}'::jsonb
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes
  )
  select v_order_id, product.id, 1, 0, 0, product.name, product.sku, null
  from public.products product
  where product.id = 164;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes
  )
  select v_order_id, product.id, 0.5, 0, 0, product.name, product.sku, null
  from public.products product
  where product.id = 5;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes
  )
  select v_order_id, product.id, 0.5, 0, 0, product.name, product.sku, null
  from public.products product
  where product.id = 129;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes
  )
  select v_order_id, product.id, 1, 0, 0, product.name, product.sku, null
  from public.products product
  where product.id = 65;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot,
    notes
  )
  select
    v_order_id,
    product.id,
    1,
    0,
    0,
    product.name,
    product.sku,
    E'Esta nota visible no decide inventario.\n@sel|marcador-inválido'
  from public.products product
  where product.id = 61
  returning id into v_single_order_item_id;

  insert into public.order_item_components (
    order_item_id,
    component_product_id,
    qty,
    component_name_snapshot
  )
  select v_single_order_item_id, product.id, 6, product.name
  from public.products product
  where product.id = 5;

  v_resolution := public.inventory_preview_order_sale_v1(v_order_id);

  if jsonb_array_length(v_resolution -> 'lines') <> 7 then
    raise exception 'Expected seven aggregated physical lines, got %.', v_resolution -> 'lines';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_resolution -> 'selection_sources') selection(value)
    where selection.value ->> 'source' = 'order_item_components'
      and (selection.value ->> 'component_product_id')::bigint = 5
      and (selection.value ->> 'quantity')::numeric = 6
  ) then
    raise exception 'The component snapshot did not override the malformed notes marker.';
  end if;

  if exists (
    select 1
    from (
      values
        (1::bigint, 25::numeric),
        (5::bigint, 6::numeric),
        (6::bigint, 6::numeric),
        (8::bigint, 1::numeric),
        (13::bigint, 7::numeric),
        (19::bigint, 7::numeric),
        (47::bigint, 3::numeric)
    ) expected(inventory_item_id, quantity_units)
    where not exists (
      select 1
      from jsonb_array_elements(v_resolution -> 'lines') line(value)
      where (line.value ->> 'inventory_item_id')::bigint = expected.inventory_item_id
        and (line.value ->> 'quantity_units')::numeric = expected.quantity_units
    )
  ) then
    raise exception 'Resolved physical quantities do not match tasting + half service + combo + snapshot: %.',
      v_resolution -> 'lines';
  end if;

  -- Authenticated is not sufficient: both public RPCs enforce the business role.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );

  v_failed := false;
  begin
    perform public.inventory_preview_order_sale_v1(v_order_id);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly received canonical sale preview authority.';
  end if;

  v_failed := false;
  begin
    perform public.inventory_commit_order_sale_v1(v_operation, v_order_id, null);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly received canonical sale commit authority.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- Without a structured snapshot, malformed markers must fail explicitly.
  insert into public.orders (
    order_number, created_by_user_id, source, fulfillment, status, total_usd, extra_fields
  )
  values (
    'TEST-INV-B5-BAD', v_admin, v_source, v_fulfillment, 'delivered', 0, '{}'::jsonb
  )
  returning id into v_bad_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot, notes
  )
  select v_bad_order_id, product.id, 1, 0, 0, product.name, product.sku, '@sel|bad'
  from public.products product
  where product.id = 61;

  if not exists (
    select 1
    from jsonb_array_elements(
      app_private.inventory_order_sale_diagnostics_v1(v_bad_order_id) -> 'errors'
    ) error_row(value)
    where error_row.value ->> 'code' = 'malformed_selection_marker'
  ) then
    raise exception 'Malformed selection marker was not rejected.';
  end if;

  -- Representative real orders: open event, selectable pack and fixed combo.
  if exists (
    select 1
    from (values (505::bigint), (1612::bigint), (1614::bigint)) sample(order_id)
    where jsonb_array_length(
      app_private.inventory_order_sale_diagnostics_v1(sample.order_id) -> 'errors'
    ) <> 0
  ) then
    raise exception 'A representative historical/current order no longer resolves canonically.';
  end if;

  -- No production item has been opened at this dated baseline.
  if exists (
    select 1
    from (values
      (1::bigint), (5::bigint), (6::bigint), (8::bigint),
      (13::bigint), (19::bigint), (47::bigint)
    ) item(id)
    where app_private.inventory_item_is_initialized_v1(item.id)
  ) then
    raise exception 'Dated Block 5 test expects these six items to remain unopened in production.';
  end if;

  v_opening := public.inventory_submit_count_v1(
    'b5000000-0000-4000-8000-000000000010',
    'opening',
    '[
      {"inventory_item_id":1,"counted_quantity_units":1000},
      {"inventory_item_id":5,"counted_quantity_units":1000},
      {"inventory_item_id":6,"counted_quantity_units":1000},
      {"inventory_item_id":8,"counted_quantity_units":1000},
      {"inventory_item_id":13,"counted_quantity_units":1000},
      {"inventory_item_id":19,"counted_quantity_units":1000},
      {"inventory_item_id":47,"counted_quantity_units":1000}
    ]'::jsonb,
    'Block 5 rollback test',
    null,
    null
  );
  v_count_id := (v_opening ->> 'inventory_count_id')::bigint;
  perform public.inventory_review_count_v1(v_count_id, 'accept', null, 'Block 5 rollback test');

  perform public.inventory_commit_order_sale_v1(v_operation, v_order_id, 'Block 5 rollback test');

  if (
    select count(*)
    from public.inventory_movements movement
    where movement.operation_id = v_operation
      and movement.movement_type = 'sale_out'
      and movement.quantity_units < 0
      and movement.order_id = v_order_id
      and movement.reason_code = 'order_delivery'
  ) <> 7 then
    raise exception 'Atomic sale did not persist exactly seven signed canonical movements.';
  end if;

  perform public.inventory_commit_order_sale_v1(v_operation, v_order_id, 'Idempotent replay');
  if (select count(*) from public.inventory_movements where operation_id = v_operation) <> 7 then
    raise exception 'Idempotent replay duplicated sale movements.';
  end if;

  v_failed := false;
  begin
    perform public.inventory_commit_order_sale_v1(
      'b5000000-0000-4000-8000-000000000099',
      v_order_id,
      'Must be rejected'
    );
  exception when others then
    v_failed := position('ya fue descontada' in sqlerrm) > 0;
  end;
  if not v_failed then
    raise exception 'A second operation key was not rejected for the same active sale.';
  end if;

  perform public.inventory_reverse_operation_v1(
    v_reversal,
    v_operation,
    'block_5_test_reversal',
    'Block 5 rollback test'
  );

  if exists (
    select 1
    from public.inventory_movements original
    where original.operation_id = v_operation
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversal_of_movement_id = original.id
          and reversal.operation_id = v_reversal
      )
  ) then
    raise exception 'Sale reversal did not reference every original movement.';
  end if;

  perform public.inventory_commit_order_sale_v1(v_recommit, v_order_id, 'Recommit after full reversal');
  if (select count(*) from public.inventory_movements where operation_id = v_recommit) <> 7 then
    raise exception 'A fully reversed order could not be committed again.';
  end if;

  -- A catalog product with policy none is valid and produces no stock write.
  insert into public.orders (
    order_number, created_by_user_id, source, fulfillment, status, total_usd, extra_fields
  )
  values (
    'TEST-INV-B5-NONE', v_admin, v_source, v_fulfillment, 'delivered', 0, '{}'::jsonb
  )
  returning id into v_empty_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_empty_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product
  where product.inventory_policy = 'none'
  order by product.id
  limit 1;

  if public.inventory_commit_order_sale_v1(v_empty_operation, v_empty_order_id, null) ->> 'status'
     <> 'no_inventory_effect' then
    raise exception 'A non-inventoriable-only order should be a valid no-op.';
  end if;
  if exists (select 1 from public.inventory_movements where operation_id = v_empty_operation) then
    raise exception 'A non-inventoriable-only order wrote a stock movement.';
  end if;

  -- Orders already discounted by the legacy writer cannot be discounted twice.
  select movement.order_id
  into v_legacy_order_id
  from public.inventory_movements movement
  join public.orders order_row on order_row.id = movement.order_id
  where movement.operation_id is null
    and movement.movement_type = 'sale_out'
    and order_row.status = 'delivered'
  order by movement.id
  limit 1;

  v_failed := false;
  begin
    perform public.inventory_commit_order_sale_v1(
      'b5000000-0000-4000-8000-000000000098',
      v_legacy_order_id,
      'Must be rejected'
    );
  exception when others then
    v_failed := position('descuento legado' in sqlerrm) > 0;
  end;
  if not v_failed then
    raise exception 'Legacy double-deduction guard did not reject the order.';
  end if;
end
$$;

rollback;
