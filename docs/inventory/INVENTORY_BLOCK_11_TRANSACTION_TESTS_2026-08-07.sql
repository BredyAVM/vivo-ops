-- Vivo Ops Inventory Block 11 transaction tests.
-- Prerequisites: inventory_incremental_activation_v1 and inventory_receipt_reconciliation_v1.
-- Every item, opening, expectation, receipt, lot, and movement is rolled back.

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
  v_capacity jsonb;
  v_item_id bigint;
  v_presentation_id bigint;
  v_opening_count_id bigint;
  v_known_flow_id bigint;
  v_unknown_flow_id bigint;
  v_old_flow_id bigint;
  v_replacement_flow_id bigint;
  v_receipt_lot_id bigint;
  v_unplanned_lot_id bigint;
  v_known_operation uuid := gen_random_uuid();
  v_receipt_operation uuid := gen_random_uuid();
  v_unknown_operation uuid := gen_random_uuid();
  v_unknown_receipt_operation uuid := gen_random_uuid();
  v_unplanned_operation uuid := gen_random_uuid();
  v_old_operation uuid := gen_random_uuid();
  v_replacement_operation uuid := gen_random_uuid();
  v_catalog_ready_before boolean;
  v_order_count_before bigint;
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
      where elevated.user_id = role_row.user_id
        and elevated.role = 'admin'
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
    raise exception 'Block 11 tests require admin, non-admin Master, Kitchen, and Advisor users.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_catalog_ready_before := app_private.inventory_catalog_is_ready_v1();
  select count(*) into v_order_count_before from public.orders;

  -- Advisor cannot read or mutate the receipt center.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_receipt_workspace_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly read the receipt workspace.';
  end if;

  -- Build one isolated initialized item through the canonical draft/opening flow.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK11 ITEM ' || v_suffix,
      'inventory_kind', 'raw_material',
      'inventory_group', 'raw',
      'unit_name', 'pieza',
      'tracking_mode', 'transactional',
      'availability_mode', 'on_hand_only',
      'consumption_triggers', jsonb_build_array('sale', 'production'),
      'shelf_life_days', 30
    ),
    'presentations', jsonb_build_array(jsonb_build_object(
      'name', 'Bolsa de prueba',
      'base_units', 10,
      'allows_fractional_quantity', false
    ))
  ));
  v_item_id := (v_result ->> 'inventory_item_id')::bigint;

  select presentation.id into v_presentation_id
  from public.inventory_item_presentations presentation
  where presentation.inventory_item_id = v_item_id
    and presentation.name = 'Bolsa de prueba';

  v_result := public.inventory_submit_draft_opening_v1(
    gen_random_uuid(), v_item_id, 10, 'Apertura Block 11'
  );
  v_opening_count_id := (v_result ->> 'inventory_count_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_review_count_v1(v_opening_count_id, 'accept', null, 'Apertura aceptada');

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_activate_item_draft_v1(v_item_id);

  if not exists (
    select 1 from public.inventory_items item
    where item.id = v_item_id
      and item.is_active
      and item.current_stock_units = 10
  ) then
    raise exception 'The Block 11 item was not initialized at 10 units.';
  end if;

  v_workspace := public.inventory_receipt_workspace_v1();
  if not (v_workspace #>> '{permissions,can_plan}')::boolean
    or not (v_workspace #>> '{permissions,can_receive}')::boolean
  then
    raise exception 'Admin did not receive both receipt permissions: %.', v_workspace -> 'permissions';
  end if;

  -- Master records a known expectation; stock must remain unchanged.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_workspace := public.inventory_receipt_workspace_v1();
  if not (v_workspace #>> '{permissions,can_plan}')::boolean
    or (v_workspace #>> '{permissions,can_receive}')::boolean
  then
    raise exception 'Master receipt permissions are incorrect: %.', v_workspace -> 'permissions';
  end if;

  v_result := public.inventory_save_expected_receipt_v1(
    v_known_operation,
    v_item_id,
    now() + interval '1 day',
    jsonb_build_object(
      'source_name', 'Fábrica de prueba',
      'loose_units', 3,
      'presentations', jsonb_build_array(jsonb_build_object(
        'presentation_id', v_presentation_id,
        'quantity', 5
      ))
    ),
    'Se esperan cinco bolsas y tres piezas',
    null
  );
  v_known_flow_id := (v_result ->> 'expected_flow_id')::bigint;

  if (v_result ->> 'quantity_units')::numeric <> 53
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 10
    or not exists (
      select 1 from public.inventory_planned_flows flow
      where flow.id = v_known_flow_id
        and flow.flow_type = 'expected_receipt'
        and flow.status = 'active'
        and flow.quantity_units = 53
        and flow.capture_details #>> '{presentations,0,presentation_name}' = 'Bolsa de prueba'
        and (flow.capture_details #>> '{presentations,0,base_units_per_presentation}')::numeric = 10
    )
  then
    raise exception 'Known expectation changed stock or did not freeze 53 units.';
  end if;

  v_result := public.inventory_save_expected_receipt_v1(
    v_known_operation,
    v_item_id,
    now() + interval '1 day',
    jsonb_build_object('loose_units', 53),
    null,
    null
  );
  if v_result ->> 'status' <> 'replayed'
    or (v_result ->> 'expected_flow_id')::bigint <> v_known_flow_id
    or (select count(*) from public.inventory_planned_flows flow where flow.operation_id = v_known_operation) <> 1
  then
    raise exception 'Expected receipt idempotency failed.';
  end if;

  -- Master cannot perform the physical receipt.
  v_failed := false;
  begin
    perform public.inventory_reconcile_receipt_v1(
      gen_random_uuid(), v_item_id, jsonb_build_object('loose_units', 1),
      v_known_flow_id, null, now(), null, null
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Master unexpectedly registered physical merchandise.';
  end if;

  -- Kitchen cannot plan, but can record the blank physical capture.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_workspace := public.inventory_receipt_workspace_v1();
  if (v_workspace #>> '{permissions,can_plan}')::boolean
    or not (v_workspace #>> '{permissions,can_receive}')::boolean
  then
    raise exception 'Kitchen receipt permissions are incorrect: %.', v_workspace -> 'permissions';
  end if;

  v_failed := false;
  begin
    perform public.inventory_save_expected_receipt_v1(
      gen_random_uuid(), v_item_id, now() + interval '1 day',
      jsonb_build_object('loose_units', 1), null, null
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Kitchen unexpectedly planned a receipt.';
  end if;

  v_result := public.inventory_reconcile_receipt_v1(
    v_receipt_operation,
    v_item_id,
    jsonb_build_object(
      'source_name', 'Fábrica de prueba',
      'loose_units', 2,
      'presentations', jsonb_build_array(jsonb_build_object(
        'presentation_id', v_presentation_id,
        'quantity', 4
      ))
    ),
    v_known_flow_id,
    'LOTE-B11-' || v_suffix,
    now(),
    null,
    'Llegaron cuatro bolsas y dos piezas'
  );
  v_receipt_lot_id := (v_result ->> 'inventory_lot_id')::bigint;

  if (v_result ->> 'received_quantity_units')::numeric <> 42
    or (v_result ->> 'difference_quantity_units')::numeric <> -11
    or v_result ->> 'expected_flow_status' <> 'failed'
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 52
    or not exists (
      select 1 from public.inventory_lots lot
      where lot.id = v_receipt_lot_id
        and lot.planned_flow_id = v_known_flow_id
        and lot.initial_quantity_units = 42
        and lot.capture_details #>> '{source_name}' = 'Fábrica de prueba'
    )
    or not exists (
      select 1 from public.inventory_movements movement
      where movement.operation_id = v_receipt_operation
        and movement.inventory_lot_id = v_receipt_lot_id
        and movement.movement_type = 'inbound'
        and movement.quantity_units = 42
    )
    or not exists (
      select 1 from public.inventory_planned_flows flow
      where flow.id = v_known_flow_id
        and flow.status = 'failed'
        and flow.resolved_at is not null
    )
  then
    raise exception 'Physical receipt did not apply only 42 units and close the 53-unit expectation.';
  end if;

  v_result := public.inventory_reconcile_receipt_v1(
    v_receipt_operation,
    v_item_id,
    jsonb_build_object('loose_units', 999),
    null, null, now(), null, null
  );
  if v_result ->> 'status' <> 'replayed'
    or (v_result ->> 'inventory_lot_id')::bigint <> v_receipt_lot_id
    or (v_result ->> 'received_quantity_units')::numeric <> 42
    or (v_result ->> 'difference_quantity_units')::numeric <> -11
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 52
    or (select count(*) from public.inventory_movements movement where movement.operation_id = v_receipt_operation) <> 1
  then
    raise exception 'Physical receipt idempotency duplicated stock or lost its reconciliation result.';
  end if;

  -- Unknown expectation contributes zero projected units, then closes fulfilled on actual receipt.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_save_expected_receipt_v1(
    v_unknown_operation,
    v_item_id,
    now() + interval '1 day',
    jsonb_build_object('quantity_unknown', true, 'source_name', 'Cantidad por confirmar'),
    null,
    null
  );
  v_unknown_flow_id := (v_result ->> 'expected_flow_id')::bigint;
  v_capacity := app_private.inventory_item_capacity_v1(v_item_id, now() + interval '2 days', null);
  if v_result ->> 'quantity_units' is not null
    or (v_capacity ->> 'incoming_through_target')::numeric <> 0
  then
    raise exception 'Unknown expectation added fictitious projected stock: %.', v_capacity;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_kitchen::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_kitchen, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_reconcile_receipt_v1(
    v_unknown_receipt_operation,
    v_item_id,
    jsonb_build_object('loose_units', 5),
    v_unknown_flow_id,
    null,
    now(),
    null,
    null
  );
  if v_result ->> 'expected_flow_status' <> 'fulfilled'
    or v_result ->> 'difference_quantity_units' is not null
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 57
  then
    raise exception 'Unknown expectation was not fulfilled by the exact physical quantity.';
  end if;

  -- Unplanned receipt is allowed and freezes a one-time conversion override.
  v_result := public.inventory_reconcile_receipt_v1(
    v_unplanned_operation,
    v_item_id,
    jsonb_build_object('presentations', jsonb_build_array(jsonb_build_object(
      'presentation_id', v_presentation_id,
      'quantity', 1,
      'base_units_per_presentation', 9.5
    ))),
    null,
    null,
    now(),
    null,
    'Conversión puntual de prueba'
  );
  v_unplanned_lot_id := (v_result ->> 'inventory_lot_id')::bigint;
  if (v_result ->> 'received_quantity_units')::numeric <> 9.5
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 66.5
    or not exists (
      select 1 from public.inventory_lots lot
      where lot.id = v_unplanned_lot_id
        and lot.planned_flow_id is null
        and (lot.capture_details #>> '{presentations,0,conversion_overridden}')::boolean
        and (lot.capture_details #>> '{presentations,0,base_units_per_presentation}')::numeric = 9.5
        and (lot.capture_details #>> '{presentations,0,default_base_units_per_presentation}')::numeric = 10
    )
  then
    raise exception 'Unplanned receipt or frozen conversion override failed.';
  end if;

  -- Replacing and cancelling expectations never change stock or leave a residual promise.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_save_expected_receipt_v1(
    v_old_operation, v_item_id, now() + interval '3 days',
    jsonb_build_object('loose_units', 20), null, null
  );
  v_old_flow_id := (v_result ->> 'expected_flow_id')::bigint;

  v_result := public.inventory_save_expected_receipt_v1(
    v_replacement_operation, v_item_id, now() + interval '4 days',
    jsonb_build_object('loose_units', 30), 'Reprogramada', v_old_flow_id
  );
  v_replacement_flow_id := (v_result ->> 'expected_flow_id')::bigint;

  if not exists (
    select 1 from public.inventory_planned_flows old_flow
    join public.inventory_planned_flows new_flow on new_flow.id = v_replacement_flow_id
    where old_flow.id = v_old_flow_id
      and old_flow.status = 'cancelled'
      and old_flow.resolved_at is not null
      and new_flow.status = 'active'
      and new_flow.depends_on_flow_id = old_flow.id
      and new_flow.quantity_units = 30
  ) or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 66.5 then
    raise exception 'Expectation replacement lost lineage or changed physical stock.';
  end if;

  perform public.inventory_cancel_expected_receipt_v1(v_replacement_flow_id, 'Cancelación de prueba');
  v_result := public.inventory_cancel_expected_receipt_v1(v_replacement_flow_id, null);
  if v_result ->> 'status' <> 'replayed'
    or not exists (
      select 1 from public.inventory_planned_flows flow
      where flow.id = v_replacement_flow_id
        and flow.status = 'cancelled'
        and flow.resolved_at is not null
    )
    or (select item.current_stock_units from public.inventory_items item where item.id = v_item_id) <> 66.5
  then
    raise exception 'Expectation cancellation was not idempotent or changed stock.';
  end if;

  if exists (
    select 1 from public.inventory_planned_flows flow
    where flow.inventory_item_id = v_item_id
      and flow.flow_type = 'expected_receipt'
      and flow.status in ('draft', 'active')
  ) then
    raise exception 'Block 11 left an active expectation after reconciliation/cancellation.';
  end if;

  if app_private.inventory_catalog_is_ready_v1() is distinct from v_catalog_ready_before
    or (select count(*) from public.orders) <> v_order_count_before
  then
    raise exception 'Block 11 changed global readiness or touched orders.';
  end if;
end;
$$;

rollback;
