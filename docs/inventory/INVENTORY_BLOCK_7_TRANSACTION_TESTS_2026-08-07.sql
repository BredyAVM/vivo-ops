-- Vivo Ops Inventory Block 7 transaction tests.
-- Prerequisite: inventory_opening_cutover_v1.
-- Every fixture, opening balance, movement, and order is rolled back.

begin;

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_advisor uuid;
  v_counter uuid;
  v_first_item_id bigint;
  v_first_count_id bigint;
  v_recount_id bigint;
  v_first_line_id bigint;
  v_rest_count_id bigint;
  v_lines jsonb;
  v_status jsonb;
  v_pre_cutover_order_id bigint;
  v_master_order_id bigint;
  v_counter_order_id bigint;
  v_counter_denied_order_id bigint;
  v_delivery_at timestamptz := now() + interval '1 hour';
  v_schedule jsonb;
  v_failed boolean;
begin
  select role_row.user_id into v_admin
  from public.user_roles role_row
  where role_row.role = 'admin'
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_master
  from public.user_roles role_row
  where role_row.role = 'master'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id and elevated.role = 'admin'
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_counter
  from public.user_roles role_row
  where role_row.role = 'counter'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null or v_advisor is null or v_counter is null then
    raise exception 'Block 7 tests require distinct admin, master, advisor, and counter users.';
  end if;

  v_schedule := jsonb_build_object('schedule', jsonb_build_object(
    'date', to_char(timezone('America/Caracas', v_delivery_at), 'YYYY-MM-DD'),
    'time_24', to_char(timezone('America/Caracas', v_delivery_at), 'HH24:MI:SS'),
    'asap', false
  ));

  if exists (select 1 from public.inventory_counts where count_kind = 'opening') then
    raise exception 'The dated Block 7 baseline expects zero production opening counts.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_status := public.inventory_opening_status_v1();
  if (v_status ->> 'eligible_count')::integer <> 47
    or (v_status ->> 'pending_count')::integer <> 47
    or (v_status ->> 'accepted_count')::integer <> 0
    or (v_status ->> 'ready')::boolean
    or public.inventory_cutover_mode_v1() <> 'legacy'
  then
    raise exception 'The physical opening did not start from the audited 0/47 legacy baseline: %.', v_status;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );

  v_failed := false;
  begin
    perform public.inventory_opening_status_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly received physical-opening visibility.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  select item.id into v_first_item_id
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
  order by item.id
  limit 1;

  v_first_count_id := (
    public.inventory_submit_count_v1(
      'b7000000-0000-4000-8000-000000000001',
      'opening',
      jsonb_build_array(jsonb_build_object(
        'inventory_item_id', v_first_item_id,
        'counted_quantity_units', 1000
      )),
      'Block 7 first blind batch',
      null,
      null
    ) ->> 'inventory_count_id'
  )::bigint;

  v_status := public.inventory_opening_status_v1();
  if (v_status ->> 'under_review_count')::integer <> 1
    or (v_status ->> 'pending_count')::integer <> 46
    or public.inventory_cutover_mode_v1() <> 'opening'
    or public.inventory_catalog_ready_v1()
  then
    raise exception 'A partial opening activated the catalog or reported the wrong progress: %.', v_status;
  end if;

  v_failed := false;
  begin
    insert into public.inventory_movements (
      inventory_item_id,
      movement_type,
      quantity_units,
      reason_code,
      created_by_user_id
    ) values (
      v_first_item_id,
      'inbound',
      1,
      'legacy_writer_must_fail',
      v_admin
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'The legacy writer inserted a movement after the item entered the canonical ledger.';
  end if;

  -- Delivery remains untouched during the controlled opening window.
  insert into public.orders (
    order_number, created_by_user_id, source, fulfillment, status,
    total_usd, extra_fields, last_modified_by
  ) values (
    'TEST-INV-B7-PRE-CUTOVER', v_admin, 'master', 'pickup', 'ready',
    0, v_schedule, v_admin
  ) returning id into v_pre_cutover_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_pre_cutover_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product where product.id = 5;

  update public.orders
  set status = 'delivered', last_modified_by = v_admin
  where id = v_pre_cutover_order_id;

  if exists (
    select 1 from public.inventory_movements movement
    where movement.order_id = v_pre_cutover_order_id
  ) then
    raise exception 'A delivery moved stock before the complete opening was accepted.';
  end if;

  select count_line.id into v_first_line_id
  from public.inventory_count_lines count_line
  where count_line.inventory_count_id = v_first_count_id;

  v_recount_id := (
    public.inventory_review_count_v1(
      v_first_count_id,
      'request_recount',
      array[v_first_line_id],
      'Verify the first physical quantity'
    ) ->> 'recount_inventory_count_id'
  )::bigint;

  perform public.inventory_submit_count_v1(
    'b7000000-0000-4000-8000-000000000002',
    'recount',
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_first_item_id,
      'counted_quantity_units', 900
    )),
    'Block 7 selective recount',
    null,
    v_recount_id
  );
  perform public.inventory_review_count_v1(v_recount_id, 'accept', null, 'Recount accepted');

  if (select status from public.inventory_counts where id = v_first_count_id) <> 'accepted'
    or (select line_status from public.inventory_count_lines where id = v_first_line_id) <> 'accepted'
  then
    raise exception 'Accepting the selective recount did not close its opening parent.';
  end if;

  if (select current_stock_units from public.inventory_items where id = v_first_item_id) <> 900 then
    raise exception 'The selective recount did not leave the physical quantity as the stock projection.';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'inventory_item_id', item.id,
      'counted_quantity_units', 1000
    )
    order by item.id
  ) into v_lines
  from public.inventory_items item
  where item.is_active
    and item.merged_into_item_id is null
    and item.tracking_mode in ('transactional', 'periodic_count')
    and item.id <> v_first_item_id;

  v_rest_count_id := (
    public.inventory_submit_count_v1(
      'b7000000-0000-4000-8000-000000000003',
      'opening',
      v_lines,
      'Block 7 remaining blind opening batch',
      null,
      null
    ) ->> 'inventory_count_id'
  )::bigint;
  perform public.inventory_review_count_v1(v_rest_count_id, 'accept', null, 'Final opening batch accepted');

  v_status := public.inventory_opening_status_v1();
  if (v_status ->> 'accepted_count')::integer <> 47
    or (v_status ->> 'pending_count')::integer <> 0
    or not (v_status ->> 'ready')::boolean
    or not public.inventory_catalog_ready_v1()
    or public.inventory_cutover_mode_v1() <> 'canonical'
  then
    raise exception 'The complete accepted opening did not activate canonical mode: %.', v_status;
  end if;

  -- Master delivery: the order update and physical sale are one transaction.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );

  insert into public.orders (
    order_number, created_by_user_id, source, fulfillment, status,
    total_usd, extra_fields, last_modified_by
  ) values (
    'TEST-INV-B7-MASTER', v_master, 'master', 'pickup', 'ready',
    0, v_schedule, v_master
  ) returning id into v_master_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_master_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product where product.id = 5;

  update public.orders
  set status = 'delivered', last_modified_by = v_master
  where id = v_master_order_id;

  if not exists (
    select 1
    from public.inventory_movements movement
    where movement.order_id = v_master_order_id
      and movement.operation_id is not null
      and movement.movement_type = 'sale_out'
      and movement.quantity_units < 0
      and movement.created_by_user_id = v_master
  ) then
    raise exception 'Master delivery did not atomically create its canonical sale.';
  end if;

  -- Counter has a strict boundary: only its own walk-in pickup.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  insert into public.orders (
    order_number, created_by_user_id, source, fulfillment, status,
    total_usd, extra_fields, last_modified_by
  ) values (
    'TEST-INV-B7-COUNTER', v_counter, 'walk_in', 'pickup', 'delivered',
    0, v_schedule, v_counter
  ) returning id into v_counter_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_counter_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product where product.id = 5;

  insert into public.orders (
    order_number, created_by_user_id, attributed_advisor_id, source, fulfillment,
    status, total_usd, extra_fields, last_modified_by
  ) values (
    'TEST-INV-B7-COUNTER-DENIED', v_advisor, v_advisor, 'advisor', 'pickup',
    'delivered', 0, v_schedule, v_counter
  ) returning id into v_counter_denied_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_counter_denied_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product where product.id = 5;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_counter::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter, 'role', 'authenticated')::text,
    true
  );

  perform public.inventory_commit_order_sale_v1(
    'b7000000-0000-4000-8000-000000000010',
    v_counter_order_id,
    'Counter boundary test'
  );

  if not exists (
    select 1 from public.inventory_movements movement
    where movement.operation_id = 'b7000000-0000-4000-8000-000000000010'
      and movement.order_id = v_counter_order_id
      and movement.created_by_user_id = v_counter
      and movement.quantity_units < 0
  ) then
    raise exception 'Counter could not commit its own walk-in pickup.';
  end if;

  v_failed := false;
  begin
    perform public.inventory_commit_order_sale_v1(
      'b7000000-0000-4000-8000-000000000011',
      v_counter_denied_order_id,
      'Counter must be denied'
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Counter committed an advisor order outside its authority boundary.';
  end if;
end
$$;

rollback;
