-- Vivo Ops Inventory Block 10 transaction tests.
-- Prerequisites: inventory_universal_drafts_v1 and inventory_incremental_activation_v1.
-- Every draft, count, movement, activation, link, and product is rolled back.

begin;

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_suffix text := txid_current()::text;
  v_result jsonb;
  v_diagnostics jsonb;
  v_item_id bigint;
  v_blocked_item_id bigint;
  v_opening_count_id bigint;
  v_opening_line_id bigint;
  v_recount_count_id bigint;
  v_self_product_id bigint;
  v_self_item_id bigint;
  v_direct_product_id bigint;
  v_components_product_id bigint;
  v_none_product_id bigint;
  v_blocked_product_id bigint;
  v_catalog_ready_before boolean;
  v_cutover_before text;
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
      select 1
      from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role = 'admin'
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null then
    raise exception 'Block 10 tests require admin and non-admin Master users.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );

  v_failed := false;
  begin
    perform public.inventory_activation_queue_v1();
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Master was able to read the administrative activation queue.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_catalog_ready_before := app_private.inventory_catalog_is_ready_v1();
  v_cutover_before := public.inventory_cutover_mode_v1();

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK10 ITEM ' || v_suffix,
      'inventory_kind', 'raw_material',
      'inventory_group', 'raw',
      'unit_name', 'pieza',
      'tracking_mode', 'transactional',
      'availability_mode', 'on_hand_only',
      'consumption_triggers', jsonb_build_array('sale', 'production')
    ),
    'presentations', jsonb_build_array(jsonb_build_object(
      'name', 'Bolsa',
      'base_units', 100,
      'allows_fractional_quantity', false
    ))
  ));
  v_item_id := (v_result ->> 'inventory_item_id')::bigint;

  v_failed := false;
  begin
    perform public.inventory_activate_item_draft_v1(v_item_id);
  exception when sqlstate '22023' then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'A tracked item was activated without accepted opening.';
  end if;

  v_result := public.inventory_submit_draft_opening_v1(
    gen_random_uuid(),
    v_item_id,
    12,
    'Apertura de prueba Block 10'
  );
  v_opening_count_id := (v_result ->> 'inventory_count_id')::bigint;

  select count_line.id into v_opening_line_id
  from public.inventory_count_lines count_line
  where count_line.inventory_count_id = v_opening_count_id
    and count_line.inventory_item_id = v_item_id;

  if not exists (
    select 1
    from public.inventory_items item
    where item.id = v_item_id
      and not item.is_active
      and item.current_stock_units = 12
  ) or app_private.inventory_item_has_accepted_opening_v1(v_item_id) then
    raise exception 'Draft opening did not preserve inactive/review state.';
  end if;

  if app_private.inventory_catalog_is_ready_v1() is distinct from v_catalog_ready_before
    or public.inventory_cutover_mode_v1() is distinct from v_cutover_before
  then
    raise exception 'Inactive draft opening changed the global catalog mode.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  v_result := public.inventory_review_count_v1(
    v_opening_count_id,
    'request_recount',
    array[v_opening_line_id],
    'Validar existencia inicial'
  );
  v_recount_count_id := (v_result ->> 'recount_inventory_count_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_submit_staged_recount_v1(
    gen_random_uuid(),
    v_recount_count_id,
    jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'counted_quantity_units', 11,
      'note', 'Reconteo de prueba'
    )),
    null
  );

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_review_count_v1(v_recount_count_id, 'accept', null, null);

  if not app_private.inventory_item_has_accepted_opening_v1(v_item_id)
    or not exists (
      select 1
      from public.inventory_counts count_header
      where count_header.id = v_opening_count_id
        and count_header.status = 'accepted'
    )
    or not exists (
      select 1
      from public.inventory_items item
      where item.id = v_item_id
        and not item.is_active
        and item.current_stock_units = 11
    )
  then
    raise exception 'Accepted recount did not close the opening lineage correctly.';
  end if;

  v_failed := false;
  begin
    perform public.inventory_activate_item_draft_v1(v_item_id);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Master was able to activate an inventory draft.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_activate_item_draft_v1(v_item_id);

  if not exists (
    select 1
    from public.inventory_items item
    where item.id = v_item_id
      and item.is_active
      and item.current_stock_units = 11
  ) or app_private.inventory_catalog_is_ready_v1() is distinct from v_catalog_ready_before then
    raise exception 'Reviewed item activation changed stock or global readiness.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST BLOCK10 SELF ' || v_suffix,
      'sku', 'TEST-B10-SELF-' || v_suffix,
      'type', 'product',
      'source_price_amount', 1,
      'source_price_currency', 'USD',
      'units_per_service', 1,
      'inventory_policy', 'self'
    ),
    'self_item', jsonb_build_object(
      'mode', 'new',
      'inventory_item', jsonb_build_object(
        'name', 'TEST BLOCK10 SELF ITEM ' || v_suffix,
        'inventory_kind', 'finished_stock',
        'inventory_group', 'other',
        'unit_name', 'unidad',
        'tracking_mode', 'transactional',
        'availability_mode', 'on_hand_only',
        'consumption_triggers', jsonb_build_array('sale')
      ),
      'presentations', '[]'::jsonb,
      'quantity_units', 1,
      'deduction_stage', 'fulfillment'
    )
  ));
  v_self_product_id := (v_result ->> 'product_id')::bigint;
  v_self_item_id := (v_result ->> 'inventory_item_id')::bigint;

  v_diagnostics := app_private.inventory_product_activation_diagnostics_v1(v_self_product_id);
  if (v_diagnostics ->> 'ready')::boolean then
    raise exception 'Self product was ready before its physical opening.';
  end if;

  v_result := public.inventory_submit_draft_opening_v1(
    gen_random_uuid(), v_self_item_id, 8, 'Apertura producto self'
  );
  v_opening_count_id := (v_result ->> 'inventory_count_id')::bigint;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );
  perform public.inventory_review_count_v1(v_opening_count_id, 'accept', null, null);

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_diagnostics := app_private.inventory_product_activation_diagnostics_v1(v_self_product_id);
  if not (v_diagnostics ->> 'ready')::boolean then
    raise exception 'Reviewed self product did not become activatable: %.', v_diagnostics;
  end if;
  perform public.inventory_activate_product_draft_v1(v_self_product_id);

  if not exists (
    select 1
    from public.products product
    where product.id = v_self_product_id
      and product.is_active
      and product.inventory_configuration_status = 'ready'
  ) or not exists (
    select 1
    from public.inventory_items item
    where item.id = v_self_item_id
      and item.is_active
      and item.current_stock_units = 8
  ) or not exists (
    select 1
    from public.product_inventory_links link
    where link.product_id = v_self_product_id
      and link.configuration_version = 1
      and link.is_active
  ) then
    raise exception 'Atomic self product activation was incomplete.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST BLOCK10 DIRECT ' || v_suffix,
      'sku', 'TEST-B10-DIRECT-' || v_suffix,
      'type', 'product',
      'source_price_amount', 2,
      'source_price_currency', 'USD',
      'units_per_service', 2,
      'inventory_policy', 'direct'
    ),
    'links', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'quantity_units', 2,
      'deduction_stage', 'kitchen'
    ))
  ));
  v_direct_product_id := (v_result ->> 'product_id')::bigint;
  perform public.inventory_activate_product_draft_v1(v_direct_product_id);

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST BLOCK10 COMPONENTS ' || v_suffix,
      'sku', 'TEST-B10-COMP-' || v_suffix,
      'type', 'combo',
      'source_price_amount', 3,
      'source_price_currency', 'USD',
      'units_per_service', 2,
      'inventory_policy', 'components',
      'detail_units_limit', 2
    ),
    'components', jsonb_build_array(
      jsonb_build_object(
        'component_product_id', v_self_product_id,
        'component_mode', 'fixed',
        'quantity', 1,
        'counts_toward_detail_limit', false,
        'is_required', true
      ),
      jsonb_build_object(
        'component_product_id', v_direct_product_id,
        'component_mode', 'selectable',
        'quantity', 1,
        'counts_toward_detail_limit', true,
        'is_required', false
      )
    )
  ));
  v_components_product_id := (v_result ->> 'product_id')::bigint;
  perform public.inventory_activate_product_draft_v1(v_components_product_id);

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST BLOCK10 NONE ' || v_suffix,
      'sku', 'TEST-B10-NONE-' || v_suffix,
      'type', 'service',
      'source_price_amount', 0,
      'source_price_currency', 'USD',
      'units_per_service', 0,
      'inventory_policy', 'none',
      'none_reason', 'Servicio sin consumo fisico'
    )
  ));
  v_none_product_id := (v_result ->> 'product_id')::bigint;
  perform public.inventory_activate_product_draft_v1(v_none_product_id);

  if (
    select count(*)
    from public.products product
    where product.id in (v_direct_product_id, v_components_product_id, v_none_product_id)
      and product.is_active
      and product.inventory_configuration_status = 'ready'
  ) <> 3 then
    raise exception 'Direct, components, or none activation failed.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST BLOCK10 BLOCKED ITEM ' || v_suffix,
      'inventory_kind', 'finished_stock',
      'inventory_group', 'other',
      'unit_name', 'unidad',
      'tracking_mode', 'transactional'
    ),
    'presentations', '[]'::jsonb
  ));
  v_blocked_item_id := (v_result ->> 'inventory_item_id')::bigint;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST BLOCK10 BLOCKED PRODUCT ' || v_suffix,
      'sku', 'TEST-B10-BLOCKED-' || v_suffix,
      'type', 'product',
      'source_price_amount', 1,
      'source_price_currency', 'USD',
      'units_per_service', 1,
      'inventory_policy', 'direct'
    ),
    'links', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_blocked_item_id,
      'quantity_units', 1,
      'deduction_stage', 'fulfillment'
    ))
  ));
  v_blocked_product_id := (v_result ->> 'product_id')::bigint;

  v_failed := false;
  begin
    perform public.inventory_activate_product_draft_v1(v_blocked_product_id);
  exception when sqlstate '22023' then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'A product with pending physical opening was activated.';
  end if;

  v_result := public.inventory_activation_queue_v1();
  if not exists (
    select 1
    from jsonb_array_elements(v_result -> 'products') product_row
    where (product_row ->> 'id')::bigint = v_blocked_product_id
  ) or not exists (
    select 1
    from jsonb_array_elements(v_result -> 'items') item_row
    where (item_row ->> 'id')::bigint = v_blocked_item_id
      and item_row ->> 'opening_status' = 'pending'
  ) then
    raise exception 'Activation queue did not expose the blocked draft and its pending opening.';
  end if;

  if app_private.inventory_catalog_is_ready_v1() is distinct from v_catalog_ready_before then
    raise exception 'Incremental activation declared a different global readiness state.';
  end if;

  if v_cutover_before = 'canonical'
    and public.inventory_cutover_mode_v1() <> 'canonical'
  then
    raise exception 'Incremental activation regressed a canonical catalog.';
  end if;
end;
$$;

rollback;
