-- Vivo Ops Inventory Block 6 transaction tests.
-- Run after the Block 6 migration. Every fixture and state change is rolled back.

begin;

do $$
declare
  v_admin uuid := '8c296814-8b98-48d4-8db1-ce27b4c808eb';
  v_master uuid := '833e2079-6bc7-4708-aa9f-1b25ac20a911';
  v_advisor uuid := '1a496721-7bd7-4571-9632-4714bc76a2d5';
  v_other_advisor uuid := '3109cc38-c706-4975-8a41-9420a1392c71';
  v_tag text := 'TEST-INV-B6-' || pg_catalog.txid_current()::text;
  v_item_id bigint;
  v_product_id bigint;
  v_committed_order_id bigint;
  v_request_order_id bigint;
  v_future_order_id bigint;
  v_single_order_id bigint;
  v_combo_order_id bigint;
  v_count_id bigint;
  v_opening jsonb;
  v_preview jsonb;
  v_committed_at timestamptz := now() + interval '24 hours';
  v_request_at timestamptz := now() + interval '1 hour';
  v_future_at timestamptz := now() + interval '11 days';
  v_failed boolean;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- The production backfill must exactly match the already-audited Block 5
  -- resolver and must not create physical movements.
  if exists (
    select 1
    from public.orders order_row
    cross join lateral app_private.inventory_resolve_order_sale_v1(order_row.id) resolution
    where order_row.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
      and not order_row.needs_reapproval
      and not order_row.queued_needs_reapproval
      and (
        select count(*)
        from public.inventory_planned_flows flow
        where flow.order_id = order_row.id
          and flow.flow_type = 'order_commitment'
          and flow.status in ('draft', 'active')
      ) <> jsonb_array_length(resolution -> 'lines')
  ) then
    raise exception 'An approved production order was not backfilled exactly once per physical line.';
  end if;

  if exists (
    select 1
    from public.inventory_planned_flows flow
    join public.orders order_row on order_row.id = flow.order_id
    cross join lateral app_private.inventory_resolve_order_sale_v1(order_row.id) resolution
    where flow.flow_type = 'order_commitment'
      and flow.status in ('draft', 'active')
      and not exists (
        select 1
        from jsonb_array_elements(resolution -> 'lines') line(value)
        where (line.value ->> 'inventory_item_id')::bigint = flow.inventory_item_id
          and (line.value ->> 'quantity_units')::numeric = flow.quantity_units
      )
  ) then
    raise exception 'A production commitment differs from its canonical physical resolution.';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.order_id in (
      select flow.order_id
      from public.inventory_planned_flows flow
      where flow.flow_type = 'order_commitment'
    )
      and movement.created_at >= pg_catalog.transaction_timestamp()
  ) then
    raise exception 'Commitment backfill moved physical stock.';
  end if;

  insert into public.inventory_items (
    name,
    inventory_kind,
    unit_name,
    current_stock_units,
    is_active,
    inventory_group,
    tracking_mode,
    availability_mode,
    primary_count_frequency,
    primary_count_role
  ) values (
    v_tag || '-ITEM',
    'raw_material',
    'pieza',
    0,
    true,
    'other',
    'transactional',
    'on_hand_only',
    'per_shift',
    'admin'
  ) returning id into v_item_id;

  insert into public.products (
    sku,
    name,
    type,
    units_per_service,
    is_inventory_item,
    inventory_enabled,
    inventory_kind,
    inventory_unit_name,
    inventory_deduction_mode,
    inventory_group,
    inventory_policy,
    inventory_configuration_status
  ) values (
    v_tag || '-SKU',
    v_tag || '-PRODUCT',
    'product',
    1,
    true,
    true,
    'finished_good',
    'pieza',
    'self',
    'other',
    'direct',
    'ready'
  ) returning id into v_product_id;

  insert into public.product_inventory_links (
    product_id,
    inventory_item_id,
    deduction_mode,
    quantity_units,
    is_active,
    configuration_version,
    deduction_stage
  ) values (
    v_product_id,
    v_item_id,
    'self_link',
    1,
    true,
    1,
    'kitchen'
  );

  v_opening := public.inventory_submit_count_v1(
    'b6000000-0000-4000-8000-000000000001',
    'opening',
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'counted_quantity_units', 550
    )),
    'Block 6 rollback test',
    null,
    null
  );
  v_count_id := (v_opening ->> 'inventory_count_id')::bigint;
  perform public.inventory_review_count_v1(
    v_count_id,
    'accept',
    null,
    'Block 6 rollback test'
  );

  -- Existing approved demand: 500 pieces tomorrow from 550 on hand.
  insert into public.orders (
    order_number,
    created_by_user_id,
    source,
    attributed_advisor_id,
    fulfillment,
    status,
    total_usd,
    extra_fields
  ) values (
    v_tag || '-COMMITTED',
    v_admin,
    'advisor',
    v_advisor,
    'pickup',
    'created',
    0,
    jsonb_build_object('schedule', jsonb_build_object(
      'date', to_char(timezone('America/Caracas', v_committed_at), 'YYYY-MM-DD'),
      'time_24', to_char(timezone('America/Caracas', v_committed_at), 'HH24:MI:SS'),
      'asap', false
    ))
  ) returning id into v_committed_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  ) values (
    v_committed_order_id, v_product_id, 500, 0, 0,
    v_tag || '-PRODUCT', v_tag || '-SKU'
  );

  update public.orders
  set status = 'queued', last_modified_by = v_admin
  where id = v_committed_order_id;

  if (
    select coalesce(sum(flow.quantity_units), 0)
    from public.inventory_planned_flows flow
    where flow.order_id = v_committed_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status = 'active'
  ) <> 500 then
    raise exception 'Approval did not create the expected 500-piece commitment.';
  end if;

  -- Candidate request: 200 pieces today. Without replenishment only 50 are
  -- available without affecting tomorrow's approved order.
  insert into public.orders (
    order_number,
    created_by_user_id,
    source,
    attributed_advisor_id,
    fulfillment,
    status,
    total_usd,
    extra_fields
  ) values (
    v_tag || '-REQUEST',
    v_advisor,
    'advisor',
    v_advisor,
    'pickup',
    'created',
    0,
    jsonb_build_object('schedule', jsonb_build_object(
      'date', to_char(timezone('America/Caracas', v_request_at), 'YYYY-MM-DD'),
      'time_24', to_char(timezone('America/Caracas', v_request_at), 'HH24:MI:SS'),
      'asap', false
    ))
  ) returning id into v_request_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  ) values (
    v_request_order_id, v_product_id, 200, 0, 0,
    v_tag || '-PRODUCT', v_tag || '-SKU'
  );

  v_preview := public.inventory_preview_order_commitment_v1(v_request_order_id);
  if v_preview ->> 'decision' <> 'insufficient'
    or (v_preview #>> '{lines,0,available_without_affecting_commitments}')::numeric <> 50
    or (v_preview #>> '{lines,0,shortage_quantity_units}')::numeric <> 150
  then
    raise exception 'The 550/500/200 scenario did not protect the 500 committed pieces.';
  end if;

  -- A known incoming 200 before tomorrow's commitment makes the request
  -- possible, but it must be labelled as depending on that replenishment.
  insert into public.inventory_planned_flows (
    inventory_item_id,
    flow_type,
    quantity_units,
    effective_at,
    status,
    notes,
    created_by_user_id
  ) values (
    v_item_id,
    'expected_receipt',
    200,
    v_committed_at - interval '1 hour',
    'active',
    'Block 6 rollback test',
    v_admin
  );

  v_preview := public.inventory_preview_order_commitment_v1(v_request_order_id);
  if v_preview ->> 'decision' <> 'relies_on_incoming'
    or (v_preview #>> '{lines,0,available_without_affecting_commitments}')::numeric <> 250
    or (v_preview #>> '{lines,0,available_without_incoming}')::numeric <> 50
    or not (v_preview #>> '{lines,0,relies_on_incoming}')::boolean
  then
    raise exception 'Expected replenishment was not exposed as an explicit dependency.';
  end if;

  -- More than ten days away: keep the commitment as draft and exclude it from
  -- the rolling operational reading.
  insert into public.orders (
    order_number,
    created_by_user_id,
    source,
    attributed_advisor_id,
    fulfillment,
    status,
    total_usd,
    extra_fields
  ) values (
    v_tag || '-FUTURE',
    v_admin,
    'advisor',
    v_advisor,
    'pickup',
    'created',
    0,
    jsonb_build_object('schedule', jsonb_build_object(
      'date', to_char(timezone('America/Caracas', v_future_at), 'YYYY-MM-DD'),
      'time_24', to_char(timezone('America/Caracas', v_future_at), 'HH24:MI:SS'),
      'asap', false
    ))
  ) returning id into v_future_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  ) values (
    v_future_order_id, v_product_id, 2000, 0, 0,
    v_tag || '-PRODUCT', v_tag || '-SKU'
  );

  update public.orders
  set status = 'queued', last_modified_by = v_admin
  where id = v_future_order_id;

  if not exists (
    select 1
    from public.inventory_planned_flows flow
    where flow.order_id = v_future_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status = 'draft'
      and flow.quantity_units = 2000
  ) or public.inventory_preview_order_commitment_v1(v_future_order_id) ->> 'decision'
    <> 'outside_horizon'
  then
    raise exception 'A future event was not retained as a draft outside the ten-day horizon.';
  end if;

  -- Reapproval releases the open flow, approval rebuilds it, and delivery
  -- closes it as fulfilled. None of these lifecycle actions moves stock.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );

  update public.order_items
  set qty = 501
  where order_id = v_committed_order_id;

  if (
    select coalesce(sum(flow.quantity_units), 0)
    from public.inventory_planned_flows flow
    where flow.order_id = v_committed_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status = 'active'
  ) <> 500 then
    raise exception 'Advisor-side mutation approved its own revised commitment.';
  end if;

  update public.orders
  set queued_needs_reapproval = true, last_modified_by = v_advisor
  where id = v_committed_order_id;

  if exists (
    select 1 from public.inventory_planned_flows flow
    where flow.order_id = v_committed_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status in ('draft', 'active')
  ) then
    raise exception 'A commitment stayed open while the order required reapproval.';
  end if;

  update public.order_items
  set qty = 500
  where order_id = v_committed_order_id;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );

  update public.orders
  set queued_needs_reapproval = false, last_modified_by = v_master
  where id = v_committed_order_id;

  if (
    select count(*) from public.inventory_planned_flows flow
    where flow.order_id = v_committed_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status in ('draft', 'active')
  ) <> 1 then
    raise exception 'Master reapproval did not rebuild exactly one open commitment.';
  end if;

  update public.orders
  set status = 'delivered', last_modified_by = v_master
  where id = v_committed_order_id;

  if not exists (
    select 1 from public.inventory_planned_flows flow
    where flow.order_id = v_committed_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status = 'fulfilled'
  ) or exists (
    select 1 from public.inventory_movements movement
    where movement.order_id = v_committed_order_id
  ) then
    raise exception 'Delivery lifecycle did not close planning independently from physical stock.';
  end if;

  -- Freeze a selectable Single Pack and a fixed combo into the existing
  -- order_item_components table.
  insert into public.orders (
    order_number, created_by_user_id, source, attributed_advisor_id,
    fulfillment, status, total_usd, extra_fields
  ) values (
    v_tag || '-SINGLE', v_admin, 'advisor', v_advisor,
    'pickup', 'created', 0,
    jsonb_build_object('schedule', jsonb_build_object(
      'date', to_char(timezone('America/Caracas', v_request_at), 'YYYY-MM-DD'),
      'time_24', to_char(timezone('America/Caracas', v_request_at), 'HH24:MI:SS'),
      'asap', false
    ))
  ) returning id into v_single_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot, notes
  )
  select
    v_single_order_id, product.id, 1, 0, 0, product.name, product.sku,
    E'@sel|5|3\n@sel|8|3\n@sel|2|1'
  from public.products product where product.id = 61;

  if (
    select count(*)
    from public.order_item_components snapshot
    join public.order_items order_item on order_item.id = snapshot.order_item_id
    where order_item.order_id = v_single_order_id
  ) <> 3 then
    raise exception 'Selectable Single Pack composition was not frozen.';
  end if;

  insert into public.orders (
    order_number, created_by_user_id, source, attributed_advisor_id,
    fulfillment, status, total_usd, extra_fields
  ) values (
    v_tag || '-COMBO', v_admin, 'advisor', v_advisor,
    'pickup', 'created', 0,
    jsonb_build_object('schedule', jsonb_build_object(
      'date', to_char(timezone('America/Caracas', v_request_at), 'YYYY-MM-DD'),
      'time_24', to_char(timezone('America/Caracas', v_request_at), 'HH24:MI:SS'),
      'asap', false
    ))
  ) returning id into v_combo_order_id;

  insert into public.order_items (
    order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
    product_name_snapshot, sku_snapshot
  )
  select v_combo_order_id, product.id, 1, 0, 0, product.name, product.sku
  from public.products product where product.id = 65;

  if (
    select count(*)
    from public.order_item_components snapshot
    join public.order_items order_item on order_item.id = snapshot.order_item_id
    where order_item.order_id = v_combo_order_id
  ) <> 6 or (
    select sum(snapshot.qty)
    from public.order_item_components snapshot
    join public.order_items order_item on order_item.id = snapshot.order_item_id
    where order_item.order_id = v_combo_order_id
  ) <> 26 then
    raise exception 'Fixed combo composition was not frozen with 25 pieces and its sauce.';
  end if;

  v_failed := false;
  begin
    insert into public.order_items (
      order_id, product_id, qty, unit_price_usd_snapshot, line_total_usd,
      product_name_snapshot, sku_snapshot, notes
    )
    select
      v_single_order_id, product.id, 1, 0, 0, product.name, product.sku,
      '@sel|bad'
    from public.products product where product.id = 61;
  exception when sqlstate '22023' then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Malformed structured selection was not rejected at write time.';
  end if;

  -- An attributed Advisor may preview, another Advisor may not, and only
  -- Master/Admin may rebuild an approved commitment.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_preview_order_commitment_v1(v_request_order_id);

  perform pg_catalog.set_config('request.jwt.claim.sub', v_other_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_other_advisor, 'role', 'authenticated')::text,
    true
  );
  v_failed := false;
  begin
    perform public.inventory_preview_order_commitment_v1(v_request_order_id);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'A different Advisor unexpectedly previewed the request.';
  end if;

  v_failed := false;
  begin
    perform public.inventory_rebuild_order_commitment_v1(v_future_order_id);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Advisor unexpectedly received commitment rebuild authority.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_rebuild_order_commitment_v1(v_future_order_id);

  if (
    select count(*) from public.inventory_planned_flows flow
    where flow.order_id = v_future_order_id
      and flow.flow_type = 'order_commitment'
      and flow.status in ('draft', 'active')
  ) <> 1 then
    raise exception 'Rebuild was not idempotent for open commitments.';
  end if;

  if pg_catalog.has_table_privilege('authenticated', 'public.order_item_components', 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', 'public.order_item_components', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', 'public.order_item_components', 'DELETE')
  then
    raise exception 'Authenticated still has direct snapshot write privileges.';
  end if;
end
$$;

rollback;
