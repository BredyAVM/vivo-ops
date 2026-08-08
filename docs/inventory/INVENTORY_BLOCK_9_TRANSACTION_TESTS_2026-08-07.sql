-- Vivo Ops Inventory Block 9 transaction tests.
-- Prerequisite: inventory_universal_drafts_v1.
-- Every item, presentation, link, component, and product is rolled back.

begin;

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_suffix text := txid_current()::text;
  v_result jsonb;
  v_item_id bigint;
  v_self_product_id bigint;
  v_self_item_id bigint;
  v_direct_product_id bigint;
  v_components_product_id bigint;
  v_none_product_id bigint;
  v_catalog_ready_before boolean;
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
    raise exception 'Block 9 tests require admin and non-admin Master users.';
  end if;

  v_catalog_ready_before := app_private.inventory_catalog_is_ready_v1();

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );

  v_failed := false;
  begin
    perform public.inventory_save_catalog_draft_v1(jsonb_build_object(
      'entry_kind', 'item',
      'inventory_item', jsonb_build_object(
        'name', 'TEST MASTER DENIED ' || v_suffix,
        'inventory_kind', 'finished_stock',
        'inventory_group', 'other',
        'unit_name', 'pieza',
        'tracking_mode', 'transactional'
      ),
      'presentations', '[]'::jsonb
    ));
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Master was able to create a universal catalog draft.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'item',
    'inventory_item', jsonb_build_object(
      'name', 'TEST RAW ' || v_suffix,
      'inventory_kind', 'raw_material',
      'inventory_group', 'raw',
      'unit_name', 'pieza',
      'tracking_mode', 'transactional',
      'availability_mode', 'on_hand_only',
      'consumption_triggers', jsonb_build_array('sale', 'production'),
      'low_stock_threshold', 10,
      'target_stock_units', 200,
      'primary_count_frequency', 'per_shift',
      'primary_count_role', 'kitchen'
    ),
    'presentations', jsonb_build_array(jsonb_build_object(
      'name', 'Bolsa',
      'base_units', 200,
      'allows_fractional_quantity', false
    ))
  ));
  v_item_id := (v_result ->> 'inventory_item_id')::bigint;

  if not exists (
    select 1
    from public.inventory_items item
    where item.id = v_item_id
      and not item.is_active
      and item.current_stock_units = 0
      and item.tracking_mode = 'transactional'
  ) or not exists (
    select 1
    from public.inventory_item_presentations presentation
    where presentation.inventory_item_id = v_item_id
      and presentation.name = 'Bolsa'
      and presentation.base_units_per_presentation = 200
  ) then
    raise exception 'The standalone item draft was not persisted correctly: %.', v_result;
  end if;

  v_failed := false;
  begin
    perform public.inventory_save_catalog_draft_v1(jsonb_build_object(
      'entry_kind', 'item',
      'inventory_item', jsonb_build_object(
        'name', lower('TEST RAW ' || v_suffix),
        'inventory_kind', 'raw_material',
        'inventory_group', 'raw',
        'unit_name', 'pieza',
        'tracking_mode', 'transactional'
      ),
      'presentations', '[]'::jsonb
    ));
  exception when unique_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Canonical item names were not protected case-insensitively.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST SELF ' || v_suffix,
      'sku', 'TEST-SELF-' || v_suffix,
      'type', 'product',
      'source_price_amount', 1,
      'source_price_currency', 'USD',
      'units_per_service', 1,
      'inventory_policy', 'self'
    ),
    'self_item', jsonb_build_object(
      'mode', 'new',
      'inventory_item', jsonb_build_object(
        'name', 'TEST SELF ITEM ' || v_suffix,
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

  if not exists (
    select 1
    from public.products product
    where product.id = v_self_product_id
      and not product.is_active
      and product.inventory_configuration_status = 'draft'
      and product.inventory_policy = 'self'
  ) or not exists (
    select 1
    from public.product_inventory_links link
    where link.product_id = v_self_product_id
      and link.inventory_item_id = v_self_item_id
      and link.deduction_mode = 'self_link'
      and link.configuration_version = 1
  ) then
    raise exception 'The self product draft was not persisted correctly: %.', v_result;
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST DIRECT ' || v_suffix,
      'sku', 'TEST-DIRECT-' || v_suffix,
      'type', 'product',
      'source_price_amount', 2,
      'source_price_currency', 'USD',
      'units_per_service', 5,
      'inventory_policy', 'direct'
    ),
    'links', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'quantity_units', 5,
      'deduction_stage', 'kitchen'
    ))
  ));
  v_direct_product_id := (v_result ->> 'product_id')::bigint;

  if not exists (
    select 1
    from public.product_inventory_links link
    where link.product_id = v_direct_product_id
      and link.inventory_item_id = v_item_id
      and link.deduction_mode = 'recipe'
      and link.quantity_units = 5
  ) then
    raise exception 'The direct product draft did not create its canonical link.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST COMPONENTS ' || v_suffix,
      'sku', 'TEST-COMP-' || v_suffix,
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

  if (select count(*) from public.product_components where parent_product_id = v_components_product_id) <> 2
    or not exists (
      select 1
      from public.products product
      where product.id = v_components_product_id
        and product.is_detail_editable
        and product.is_combo_component_selectable
    )
  then
    raise exception 'The components product draft was not persisted correctly.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'TEST NONE ' || v_suffix,
      'sku', 'TEST-NONE-' || v_suffix,
      'type', 'service',
      'source_price_amount', 0,
      'source_price_currency', 'USD',
      'units_per_service', 0,
      'inventory_policy', 'none',
      'none_reason', 'Servicio sin existencia fisica'
    )
  ));
  v_none_product_id := (v_result ->> 'product_id')::bigint;

  if not exists (
    select 1
    from public.products product
    where product.id = v_none_product_id
      and product.extra_fields ->> 'inventory_none_reason' = 'Servicio sin existencia fisica'
      and not product.inventory_enabled
  ) then
    raise exception 'The none policy reason was not persisted.';
  end if;

  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product_id', v_none_product_id,
    'product', jsonb_build_object(
      'name', 'TEST REUSED ' || v_suffix,
      'sku', 'TEST-REUSED-' || v_suffix,
      'type', 'product',
      'source_price_amount', 4,
      'source_price_currency', 'USD',
      'units_per_service', 5,
      'inventory_policy', 'direct'
    ),
    'links', jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_item_id,
      'quantity_units', 5,
      'deduction_stage', 'kitchen'
    ))
  ));

  if not (v_result ->> 'reused_product')::boolean
    or (v_result ->> 'product_id')::bigint <> v_none_product_id
    or not exists (
      select 1
      from public.products product
      where product.id = v_none_product_id
        and product.name = 'TEST REUSED ' || v_suffix
        and product.inventory_policy = 'direct'
        and product.inventory_configuration_status = 'draft'
        and not product.is_active
    )
  then
    raise exception 'The inactive product identity was not reused atomically: %.', v_result;
  end if;

  if app_private.inventory_catalog_is_ready_v1() is distinct from v_catalog_ready_before then
    raise exception 'Inactive drafts changed the global physical-opening readiness.';
  end if;
end;
$$;

rollback;
