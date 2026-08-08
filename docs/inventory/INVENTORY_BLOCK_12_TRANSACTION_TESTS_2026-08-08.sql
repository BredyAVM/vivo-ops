-- Vivo Ops Inventory Block 12 transaction tests.
-- Every fixture, opening, recipe, movement, flow, and lot is rolled back.

begin;

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_kitchen uuid;
  v_advisor uuid;
  v_suffix text := txid_current()::text;
  v_result jsonb;
  v_workspace jsonb;
  v_raw_item_id bigint;
  v_scheduled_item_id bigint;
  v_immediate_item_id bigint;
  v_scheduled_recipe_id bigint;
  v_immediate_recipe_id bigint;
  v_count_id bigint;
  v_flow_id bigint;
  v_failed_flow_id bigint;
  v_start_operation uuid := gen_random_uuid();
  v_complete_operation uuid := gen_random_uuid();
  v_immediate_operation uuid := gen_random_uuid();
  v_failed_operation uuid := gen_random_uuid();
  v_orders_before bigint;
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

  select role_row.user_id into v_kitchen
  from public.user_roles role_row
  where role_row.role = 'kitchen'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master')
    )
  order by role_row.user_id
  limit 1;

  select role_row.user_id into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master', 'kitchen')
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null or v_kitchen is null or v_advisor is null then
    raise exception 'Block 12 requires Admin, Master, Kitchen, and Advisor test actors.';
  end if;

  select count(*) into v_orders_before from public.orders;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK12 RAW ' || v_suffix,
      'inventory_kind', 'raw_material',
      'inventory_group', 'raw',
      'unit_name', 'pieza',
      'tracking_mode', 'transactional',
      'availability_mode', 'on_hand_only',
      'consumption_triggers', jsonb_build_array('production')
    )
  ));
  v_raw_item_id := (v_result ->> 'inventory_item_id')::bigint;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK12 SCHEDULED ' || v_suffix,
      'inventory_kind', 'finished_stock',
      'inventory_group', 'prefried',
      'unit_name', 'servicio',
      'tracking_mode', 'transactional',
      'availability_mode', 'scheduled_recipe',
      'consumption_triggers', jsonb_build_array('sale'),
      'shelf_life_days', 90
    )
  ));
  v_scheduled_item_id := (v_result ->> 'inventory_item_id')::bigint;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK12 IMMEDIATE ' || v_suffix,
      'inventory_kind', 'finished_stock',
      'inventory_group', 'sauces',
      'unit_name', 'recipiente',
      'tracking_mode', 'transactional',
      'availability_mode', 'immediate_recipe',
      'consumption_triggers', jsonb_build_array('sale')
    )
  ));
  v_immediate_item_id := (v_result ->> 'inventory_item_id')::bigint;

  foreach v_count_id in array array[
    (public.inventory_submit_draft_opening_v1(
      gen_random_uuid(), v_raw_item_id, 100, 'Block 12 raw opening'
    ) ->> 'inventory_count_id')::bigint,
    (public.inventory_submit_draft_opening_v1(
      gen_random_uuid(), v_scheduled_item_id, 0, 'Block 12 scheduled opening'
    ) ->> 'inventory_count_id')::bigint,
    (public.inventory_submit_draft_opening_v1(
      gen_random_uuid(), v_immediate_item_id, 0, 'Block 12 immediate opening'
    ) ->> 'inventory_count_id')::bigint
  ]
  loop
    perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
    perform pg_catalog.set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
      true
    );
    perform public.inventory_review_count_v1(v_count_id, 'accept', null, 'Accepted for Block 12');
  end loop;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_activate_item_draft_v1(v_raw_item_id);
  perform public.inventory_activate_item_draft_v1(v_scheduled_item_id);
  perform public.inventory_activate_item_draft_v1(v_immediate_item_id);

  insert into public.inventory_recipes (
    output_inventory_item_id,
    recipe_kind,
    output_quantity_units,
    notes,
    is_active,
    lead_time_minutes,
    production_multiple,
    version
  ) values (
    v_scheduled_item_id,
    'production',
    1,
    'Bloque 3: TEST BLOCK12 scheduled.',
    false,
    240,
    1,
    1
  ) returning id into v_scheduled_recipe_id;

  insert into public.inventory_recipe_components (
    recipe_id, input_inventory_item_id, quantity_units, sort_order
  ) values (v_scheduled_recipe_id, v_raw_item_id, 10, 1);

  insert into public.inventory_recipes (
    output_inventory_item_id,
    recipe_kind,
    output_quantity_units,
    notes,
    is_active,
    lead_time_minutes,
    production_multiple,
    version
  ) values (
    v_immediate_item_id,
    'production',
    1,
    'Bloque 3: TEST BLOCK12 immediate.',
    false,
    0,
    1,
    1
  ) returning id into v_immediate_recipe_id;

  insert into public.inventory_recipe_components (
    recipe_id, input_inventory_item_id, quantity_units, sort_order
  ) values (v_immediate_recipe_id, v_raw_item_id, 5, 1);

  perform public.inventory_activate_recipe_v1(v_scheduled_recipe_id);
  perform public.inventory_activate_recipe_v1(v_immediate_recipe_id);

  -- Master can read production but cannot consume stock or start a batch.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_workspace := public.inventory_production_workspace_v1();
  if (v_workspace #>> '{permissions,can_start}')::boolean then
    raise exception 'Master unexpectedly received production write permission.';
  end if;
  v_failed := false;
  begin
    perform public.inventory_start_recipe_v2(
      gen_random_uuid(), v_scheduled_recipe_id, 1, null, 'Master must be denied'
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Master unexpectedly started production.';
  end if;

  -- Starting delayed production consumes raw stock but does not credit prefried stock.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_start_recipe_v2(
    v_start_operation, v_scheduled_recipe_id, 2, null, 'Block 12 cooling batch'
  );
  v_flow_id := (v_result ->> 'production_flow_id')::bigint;
  if (v_result ->> 'availability_mode') <> 'scheduled'
    or (select current_stock_units from public.inventory_items where id = v_raw_item_id) <> 80
    or (select current_stock_units from public.inventory_items where id = v_scheduled_item_id) <> 0
  then
    raise exception 'Delayed start did not preserve the raw/WIP boundary: %.', v_result;
  end if;

  v_result := public.inventory_start_recipe_v2(
    v_start_operation, v_scheduled_recipe_id, 2, null, 'Replay'
  );
  if (v_result ->> 'status') <> 'replayed'
    or (select count(*) from public.inventory_movements where operation_id = v_start_operation) <> 1
  then
    raise exception 'Delayed start was not idempotent: %.', v_result;
  end if;

  -- Kitchen cannot finish before the four-hour availability boundary.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_complete_production_v1(
      v_complete_operation, v_flow_id, 1.5, 'Too early'
    );
  exception when others then
    if sqlstate = '22023' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'A delayed batch was completed before its availability time.';
  end if;

  -- Simulate the elapsed cooling window and declare the physical yield.
  update public.inventory_planned_flows
  set effective_at = now() - interval '1 minute'
  where id = v_flow_id;

  v_result := public.inventory_complete_production_v1(
    v_complete_operation, v_flow_id, 1.5, 'Physical yield'
  );
  if (v_result ->> 'difference_quantity_units')::numeric <> -0.5
    or (select current_stock_units from public.inventory_items where id = v_scheduled_item_id) <> 1.5
    or not exists (
      select 1 from public.inventory_lots lot
      where lot.planned_flow_id = v_flow_id
        and lot.lot_kind = 'production'
        and lot.initial_quantity_units = 1.5
    )
  then
    raise exception 'Delayed completion did not record actual yield: %.', v_result;
  end if;

  v_result := public.inventory_complete_production_v1(
    v_complete_operation, v_flow_id, 1.5, 'Replay'
  );
  if (v_result ->> 'status') <> 'replayed'
    or (select current_stock_units from public.inventory_items where id = v_scheduled_item_id) <> 1.5
  then
    raise exception 'Delayed completion was not idempotent: %.', v_result;
  end if;

  -- Immediate sauce-style production credits the declared physical output atomically.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_start_recipe_v2(
    v_immediate_operation, v_immediate_recipe_id, 1, 1.25, 'Immediate physical yield'
  );
  if (v_result ->> 'availability_mode') <> 'immediate'
    or (select current_stock_units from public.inventory_items where id = v_raw_item_id) <> 75
    or (select current_stock_units from public.inventory_items where id = v_immediate_item_id) <> 1.25
  then
    raise exception 'Immediate production was not atomic: %.', v_result;
  end if;

  -- A failed delayed batch keeps consumed inputs visible and never invents output.
  v_result := public.inventory_start_recipe_v2(
    v_failed_operation, v_scheduled_recipe_id, 1, null, 'Batch to fail'
  );
  v_failed_flow_id := (v_result ->> 'production_flow_id')::bigint;
  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_resolve_production_v1(
    v_failed_flow_id, 'failed', 'No usable output'
  );
  if (select current_stock_units from public.inventory_items where id = v_raw_item_id) <> 65
    or (select current_stock_units from public.inventory_items where id = v_scheduled_item_id) <> 1.5
    or (select status from public.inventory_planned_flows where id = v_failed_flow_id) <> 'failed'
  then
    raise exception 'Failed production hid consumed inputs or credited output: %.', v_result;
  end if;

  -- Advisor has no access to the production center.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_production_workspace_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly read the production workspace.';
  end if;

  if (select count(*) from public.orders) <> v_orders_before then
    raise exception 'Block 12 changed orders.';
  end if;
end;
$$;

rollback;
