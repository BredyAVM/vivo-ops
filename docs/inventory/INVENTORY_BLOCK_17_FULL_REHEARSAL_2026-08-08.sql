-- Vivo Ops Inventory Block 17: full cutover rehearsal.
--
-- This script exercises the current production catalog, but every opening,
-- recipe activation, receipt, production run, order, and movement is rolled back.
-- It must never be changed to COMMIT.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '45s';
set local idle_in_transaction_session_timeout = '30s';

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_kitchen uuid;
  v_advisor uuid;
  v_opening_status jsonb;
  v_opening_lines jsonb;
  v_opening_count_id bigint;
  v_readiness jsonb;
  v_result jsonb;
  v_failed boolean;
  v_expected_flow_id bigint;
  v_production_flow_id bigint;
  v_order_id bigint;
  v_product_id bigint;
  v_schedule jsonb;
  v_delivery_at timestamptz := now() + interval '1 hour';
  v_order_count_before bigint;
  v_inventory_count_before bigint;
  v_movement_count_before bigint;
  v_flow_count_before bigint;
  v_lot_count_before bigint;
  v_active_canonical_recipe_count_before bigint;
  v_recipe record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('vivo_inventory_block_17_rehearsal', 0)
  ) then
    raise exception 'Another inventory cutover rehearsal is already running.';
  end if;

  select role_row.user_id
  into v_admin
  from public.user_roles role_row
  where role_row.role = 'admin'
  order by role_row.user_id
  limit 1;

  select role_row.user_id
  into v_master
  from public.user_roles role_row
  where role_row.role = 'master'
    and not exists (
      select 1
      from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role = 'admin'
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id
  into v_kitchen
  from public.user_roles role_row
  where role_row.role = 'kitchen'
    and not exists (
      select 1
      from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id
  into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1
      from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master', 'kitchen')
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null or v_kitchen is null or v_advisor is null then
    raise exception 'Block 17 requires Admin, Master, Kitchen, and Advisor actors.';
  end if;

  select count(*) into v_order_count_before from public.orders;
  select count(*) into v_inventory_count_before from public.inventory_counts;
  select count(*) into v_movement_count_before from public.inventory_movements;
  select count(*) into v_flow_count_before from public.inventory_planned_flows;
  select count(*) into v_lot_count_before from public.inventory_lots;
  select count(*)
  into v_active_canonical_recipe_count_before
  from public.inventory_recipes recipe
  where recipe.is_active
    and coalesce(recipe.notes, '') like 'Bloque 3:%';

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_readiness := public.inventory_cutover_readiness_v1();
  if not (v_readiness ->> 'structural_ready')::boolean
    or (v_readiness ->> 'operational_ready')::boolean
    or v_readiness ->> 'cutover_mode' <> 'legacy'
    or (v_readiness #>> '{opening,accepted_count}')::integer <> 0
    or (v_readiness #>> '{opening,eligible_count}')::integer <> 47
    or (v_readiness #>> '{recipes,active_count}')::integer <> 0
    or (v_readiness #>> '{recipes,canonical_count}')::integer <> 13
  then
    raise exception 'The live baseline is not the certified 0/47 legacy starting point: %.', v_readiness;
  end if;

  v_opening_status := public.inventory_opening_status_v1();

  -- Thirty-six values are exact and directly canonical. Yukypack uses its
  -- technical total of 50 while its flavor mapping remains unresolved. The
  -- other ten unresolved rows deliberately use zero only inside this rehearsal:
  -- Cajas grandes, regular prefried stock, and eight sauce rows. These test
  -- values are not approval of their real opening balance.
  select jsonb_agg(
    jsonb_build_object(
      'inventory_item_id', source.item_id,
      'counted_quantity_units',
      case source.item_id
        -- Prefried services.
        when 2 then 7
        when 14 then 8
        when 15 then 10
        when 16 then 3
        when 17 then 2

        -- Beverages, counted as individual units.
        when 28 then 4
        when 26 then 8
        when 29 then 9
        when 30 then 15
        when 27 then 29
        when 34 then 5
        when 35 then 4
        when 32 then 5
        when 31 then 9
        when 33 then 7
        when 75 then 50 -- 14 apple + 14 pear + 22 peach; mapping remains unresolved.
        when 38 then 16
        when 45 then 0
        when 36 then 20
        when 37 then 0
        when 44 then 0
        when 39 then 13
        when 43 then 0
        when 42 then 1
        when 41 then 0
        when 40 then 2
        when 76 then 6
        when 46 then 0

        -- Raw stock, normalized to the canonical base unit.
        when 1 then 1600   -- 8 bags x 200 pieces.
        when 20 then 18    -- Loose pieces, not bags.
        when 6 then 750    -- 5 bags x 150 pieces.
        when 13 then 450   -- 3 bags x 150 pieces.
        when 5 then 425    -- 4.25 bags x 100 pieces.
        when 19 then 525   -- 3.5 bags x 150 pieces.
        when 47 then 125   -- 4 bags x 30 pieces + 5 loose pieces.

        -- Exact sauce inputs.
        when 3 then 4.125  -- 1.25 containers x 3.3 kg.
        when 4 then 7      -- 7 containers x 1 kg.
        else 0
      end
    )
    order by source.item_id
  )
  into v_opening_lines
  from (
    select (element ->> 'id')::bigint as item_id
    from jsonb_array_elements(v_opening_status -> 'items') element
    where element ->> 'opening_status' = 'pending'
  ) source;

  if jsonb_array_length(v_opening_lines) <> 47
    or not exists (
      select 1
      from jsonb_array_elements(v_opening_lines) line
      where (line ->> 'inventory_item_id')::bigint = 1
        and (line ->> 'counted_quantity_units')::numeric = 1600
    )
    or not exists (
      select 1
      from jsonb_array_elements(v_opening_lines) line
      where (line ->> 'inventory_item_id')::bigint = 5
        and (line ->> 'counted_quantity_units')::numeric = 425
    )
    or not exists (
      select 1
      from jsonb_array_elements(v_opening_lines) line
      where (line ->> 'inventory_item_id')::bigint = 47
        and (line ->> 'counted_quantity_units')::numeric = 125
    )
  then
    raise exception 'The physical-count normalization did not produce the expected 47-line rehearsal.';
  end if;

  v_result := public.inventory_submit_count_v1(
    'b1700000-0000-4000-8000-000000000001'::uuid,
    'opening',
    v_opening_lines,
    'Block 17 rollback-only opening rehearsal',
    null,
    null
  );
  v_opening_count_id := (v_result ->> 'inventory_count_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_review_count_v1(
    v_opening_count_id,
    'accept',
    null,
    'Block 17 rollback-only acceptance'
  );

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_opening_status := public.inventory_opening_status_v1();
  if (v_opening_status ->> 'accepted_count')::integer <> 47
    or not (v_opening_status ->> 'ready')::boolean
    or public.inventory_cutover_mode_v1() <> 'canonical'
  then
    raise exception 'The rehearsal did not reach canonical opening mode: %.', v_opening_status;
  end if;

  for v_recipe in
    select recipe.id
    from public.inventory_recipes recipe
    where coalesce(recipe.notes, '') like 'Bloque 3:%'
    order by recipe.id
  loop
    perform public.inventory_activate_recipe_v1(v_recipe.id);
  end loop;

  v_readiness := public.inventory_cutover_readiness_v1();
  if not (v_readiness ->> 'operational_ready')::boolean
    or v_readiness ->> 'status' <> 'ready_for_canonical_operation'
    or (v_readiness #>> '{recipes,active_count}')::integer <> 13
  then
    raise exception 'Opening plus recipe activation did not become operationally ready: %.', v_readiness;
  end if;

  -- Master plans six Pepsi 2 L units. Kitchen receives five; only five enter stock.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_save_expected_receipt_v1(
    'b1700000-0000-4000-8000-000000000002'::uuid,
    28,
    now() + interval '1 hour',
    jsonb_build_object('loose_units', 6, 'source_name', 'Block 17 rehearsal'),
    'Expected quantity for rollback-only receipt test',
    null
  );
  v_expected_flow_id := (v_result ->> 'expected_flow_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_reconcile_receipt_v1(
    'b1700000-0000-4000-8000-000000000003'::uuid,
    28,
    jsonb_build_object('loose_units', 5, 'source_name', 'Block 17 rehearsal'),
    v_expected_flow_id,
    'BLOCK17-RECEIPT',
    now(),
    null,
    'Five physical units received'
  );
  if (v_result ->> 'received_quantity_units')::numeric <> 5
    or (v_result ->> 'difference_quantity_units')::numeric <> -1
    or (select item.current_stock_units from public.inventory_items item where item.id = 28) <> 9
  then
    raise exception 'Receipt reconciliation failed in the full rehearsal: %.', v_result;
  end if;

  -- Delayed prefried production consumes raw pieces now and credits services only after cooling.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_start_recipe_v2(
    'b1700000-0000-4000-8000-000000000004'::uuid,
    16,
    2,
    null,
    'Block 17 delayed prefried rehearsal'
  );
  v_production_flow_id := (v_result ->> 'production_flow_id')::bigint;
  if v_result ->> 'availability_mode' <> 'scheduled'
    or (select item.current_stock_units from public.inventory_items item where item.id = 1) <> 1550
    or (select item.current_stock_units from public.inventory_items item where item.id = 2) <> 7
  then
    raise exception 'Delayed production credited stock before cooling: %.', v_result;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_complete_production_v1(
      'b1700000-0000-4000-8000-000000000005'::uuid,
      v_production_flow_id,
      1.5,
      'Must fail before cooling finishes'
    );
  exception when others then
    if sqlstate = '22023' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'Kitchen completed delayed production before the four-hour boundary.';
  end if;

  update public.inventory_planned_flows
  set effective_at = now() - interval '1 minute'
  where id = v_production_flow_id;

  v_result := public.inventory_complete_production_v1(
    'b1700000-0000-4000-8000-000000000005'::uuid,
    v_production_flow_id,
    1.5,
    'Declared physical yield after cooling'
  );
  if (select item.current_stock_units from public.inventory_items item where item.id = 2) <> 8.5
    or (v_result ->> 'difference_quantity_units')::numeric <> -0.5
  then
    raise exception 'Delayed production did not credit the declared physical yield: %.', v_result;
  end if;

  -- Immediate tartar production consumes mayonnaise and menjurje atomically.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_start_recipe_v2(
    'b1700000-0000-4000-8000-000000000006'::uuid,
    22,
    1,
    1,
    'Block 17 immediate sauce rehearsal'
  );
  if v_result ->> 'availability_mode' <> 'immediate'
    or (select item.current_stock_units from public.inventory_items item where item.id = 3) <> 3.125
    or (select item.current_stock_units from public.inventory_items item where item.id = 4) <> 6.95
    or (select item.current_stock_units from public.inventory_items item where item.id = 7) <> 1
  then
    raise exception 'Immediate sauce production was not atomic: %.', v_result;
  end if;

  -- Advisor receives availability information, but inventory never blocks submission.
  select product.id
  into v_product_id
  from public.products product
  join public.product_inventory_links link
    on link.product_id = product.id
   and link.inventory_item_id = 1
   and link.is_active
  where product.is_active
    and product.inventory_policy in ('self', 'direct')
  order by product.id
  limit 1;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_catalog_availability_v1(
    v_delivery_at,
    array[v_product_id]::bigint[],
    'advisor_availability'
  );
  if (v_result ->> 'inventory_blocks_submission')::boolean
    or jsonb_array_length(v_result -> 'products') <> 1
    or exists (
      select 1
      from jsonb_array_elements(v_result -> 'products') product
      where product ? 'internal_details'
    )
  then
    raise exception 'Advisor availability violated the non-blocking boundary: %.', v_result;
  end if;

  v_failed := false;
  begin
    perform public.inventory_cutover_readiness_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly read the internal cutover audit.';
  end if;

  -- One isolated Master order certifies the atomic sale boundary. It is rolled back below.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_schedule := jsonb_build_object('schedule', jsonb_build_object(
    'date', to_char(timezone('America/Caracas', v_delivery_at), 'YYYY-MM-DD'),
    'time_24', to_char(timezone('America/Caracas', v_delivery_at), 'HH24:MI:SS'),
    'asap', false
  ));

  insert into public.orders (
    order_number,
    created_by_user_id,
    source,
    fulfillment,
    status,
    total_usd,
    extra_fields,
    last_modified_by
  ) values (
    'TEST-INV-B17-ROLLBACK',
    v_master,
    'master',
    'pickup',
    'ready',
    0,
    v_schedule,
    v_master
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    unit_price_usd_snapshot,
    line_total_usd,
    product_name_snapshot,
    sku_snapshot
  )
  select
    v_order_id,
    product.id,
    1,
    0,
    0,
    product.name,
    product.sku
  from public.products product
  where product.id = v_product_id;

  update public.orders
  set status = 'delivered',
      last_modified_by = v_master
  where id = v_order_id;

  if not exists (
    select 1
    from public.inventory_movements movement
    where movement.order_id = v_order_id
      and movement.movement_type = 'sale_out'
      and movement.quantity_units < 0
      and movement.created_by_user_id = v_master
  ) then
    raise exception 'Delivered Master order did not create its atomic canonical sale.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_readiness := public.inventory_cutover_readiness_v1();
  if not (v_readiness ->> 'operational_ready')::boolean
    or (v_readiness ->> 'inventory_blocks_orders')::boolean
    or not (v_readiness #>> '{safety,advisor_can_submit}')::boolean
    or not (v_readiness #>> '{safety,master_keeps_final_decision}')::boolean
  then
    raise exception 'The full operational rehearsal ended outside the canonical safety contract: %.', v_readiness;
  end if;

  if (select count(*) from public.orders) <> v_order_count_before + 1
    or (select count(*) from public.inventory_counts) <= v_inventory_count_before
    or (select count(*) from public.inventory_movements) <= v_movement_count_before
    or (select count(*) from public.inventory_planned_flows) <= v_flow_count_before
    or (select count(*) from public.inventory_lots) <= v_lot_count_before
    or (
      select count(*)
      from public.inventory_recipes recipe
      where recipe.is_active
        and coalesce(recipe.notes, '') like 'Bloque 3:%'
    ) <> v_active_canonical_recipe_count_before + 13
  then
    raise exception 'The rehearsal did not exercise every expected persistence boundary before rollback.';
  end if;
end;
$$;

rollback;

-- Independent post-rollback verification. The fixed operation IDs and test order
-- must not exist, and the readiness state must still be the live legacy baseline.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select role_row.user_id::text
      from public.user_roles role_row
      where role_row.role = 'admin'
      order by role_row.user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  false
);

do $$
declare
  v_readiness jsonb := public.inventory_cutover_readiness_v1();
begin
  if exists (
    select 1
    from public.inventory_movements movement
    where movement.operation_id::text like 'b1700000-0000-4000-8000-%'
  )
    or exists (
      select 1
      from public.inventory_planned_flows flow
      where flow.operation_id::text like 'b1700000-0000-4000-8000-%'
    )
    or exists (
      select 1
      from public.orders order_row
      where order_row.order_number = 'TEST-INV-B17-ROLLBACK'
    )
    or v_readiness ->> 'cutover_mode' <> 'legacy'
    or (v_readiness ->> 'operational_ready')::boolean
    or (v_readiness #>> '{opening,accepted_count}')::integer <> 0
    or (v_readiness #>> '{recipes,active_count}')::integer <> 0
  then
    raise exception 'Rollback verification failed: %.', v_readiness;
  end if;
end;
$$;

select jsonb_build_object(
  'certification', 'pass',
  'rollback_verified', true,
  'persisted_test_orders', (
    select count(*)
    from public.orders order_row
    where order_row.order_number = 'TEST-INV-B17-ROLLBACK'
  ),
  'persisted_test_movements', (
    select count(*)
    from public.inventory_movements movement
    where movement.operation_id::text like 'b1700000-0000-4000-8000-%'
  ),
  'live_readiness', public.inventory_cutover_readiness_v1()
);
