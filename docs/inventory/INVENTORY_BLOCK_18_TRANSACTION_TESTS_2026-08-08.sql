-- Vivo Ops Inventory Block 18: flavor stock and product-cutover boundary tests.
-- Every fixture is rolled back. This script must never be changed to COMMIT.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '45s';
set local idle_in_transaction_session_timeout = '30s';

do $$
declare
  v_admin uuid;
  v_master uuid;
  v_counter uuid;
  v_advisor uuid;
  v_parent_id bigint;
  v_manzana_product_id bigint;
  v_manzana_item_id bigint;
  v_order_id bigint;
  v_order_item_id bigint;
  v_readiness jsonb;
  v_opening jsonb;
  v_catalog jsonb;
  v_preview jsonb;
  v_availability jsonb;
  v_delivery_at timestamptz := now() + interval '1 day';
begin
  select user_id into v_admin
  from public.user_roles
  where role = 'admin'
  order by user_id
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

  select role_row.user_id into v_advisor
  from public.user_roles role_row
  where role_row.role = 'advisor'
    and not exists (
      select 1 from public.user_roles elevated
      where elevated.user_id = role_row.user_id
        and elevated.role in ('admin', 'master', 'counter')
    )
  order by role_row.user_id
  limit 1;

  if v_admin is null or v_master is null or v_counter is null or v_advisor is null then
    raise exception 'Block 18 requires Admin, Master, Counter, and Advisor actors.';
  end if;

  select id into v_parent_id
  from public.products
  where sku = 'YUKYPACK' and is_active;

  select product.id, item.id
  into v_manzana_product_id, v_manzana_item_id
  from public.products product
  join public.product_inventory_links link
    on link.product_id = product.id
   and link.configuration_version = 1
  join public.inventory_items item on item.id = link.inventory_item_id
  where product.sku = 'YUKYPACK-MANZANA'
    and item.name = 'Yukipack Manzana';

  if v_parent_id is null or v_manzana_product_id is null or v_manzana_item_id is null then
    raise exception 'Yukipack flavor configuration is incomplete.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  v_readiness := public.inventory_cutover_readiness_v1();
  v_opening := public.inventory_opening_status_v1();

  if not (v_readiness ->> 'structural_ready')::boolean
    or (v_readiness ->> 'operational_ready')::boolean
    or v_readiness ->> 'cutover_mode' <> 'legacy'
    or (v_readiness #>> '{opening,eligible_count}')::integer <> 48
    or (v_opening ->> 'eligible_count')::integer <> 48
    or exists (
      select 1
      from jsonb_array_elements(v_opening -> 'items') opening_item
      where (opening_item ->> 'id')::bigint = 48
    )
  then
    raise exception 'Product opening boundary is not the expected 0/48 legacy state: % / %.',
      v_readiness, v_opening;
  end if;

  if (
    select count(*)
    from public.inventory_items item
    where item.name in ('Yukipack Manzana', 'Yukipack Pera', 'Yukipack Durazno')
      and item.is_active
      and item.tracking_mode = 'transactional'
      and item.current_stock_units = 0
  ) <> 3
    or exists (
      select 1
      from public.inventory_items item
      where item.id = 75
        and (item.is_active or item.tracking_mode <> 'not_tracked')
    )
  then
    raise exception 'Flavor stock did not replace the generic tracked item safely.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_counter::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter, 'role', 'authenticated')::text,
    true
  );
  v_catalog := public.counter_read_catalog();

  if not exists (
    select 1 from jsonb_array_elements(v_catalog -> 'products') product
    where product ->> 'sku' = 'YUKYPACK'
  )
    or exists (
      select 1 from jsonb_array_elements(v_catalog -> 'products') product
      where product ->> 'sku' like 'YUKYPACK-%'
    )
    or (
      select count(*) from jsonb_array_elements(v_catalog -> 'components') component
      where component ->> 'parentSku' = 'YUKYPACK'
        and component ->> 'componentSku' in (
          'YUKYPACK-MANZANA', 'YUKYPACK-PERA', 'YUKYPACK-DURAZNO'
        )
    ) <> 3
  then
    raise exception 'Counter catalog did not expose Yukipack as one root with three flavors: %.', v_catalog;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_advisor::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_advisor, 'role', 'authenticated')::text,
    true
  );
  v_availability := public.inventory_catalog_availability_v1(
    v_delivery_at,
    array[v_parent_id]::bigint[],
    'advisor_availability'
  );

  if (v_availability ->> 'inventory_blocks_submission')::boolean
    or not exists (
      select 1 from jsonb_array_elements(v_availability -> 'products') product
      where (product ->> 'product_id')::bigint = v_parent_id
        and (product ->> 'selection_required')::boolean
        and product ->> 'availability_state' = 'inventory_not_active'
        and (product ->> 'requires_master_review')::boolean
    )
  then
    raise exception 'Advisor Yukipack availability is not informative and non-blocking: %.', v_availability;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', v_master::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_master, 'role', 'authenticated')::text,
    true
  );

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
    'TEST-INV-B18-ROLLBACK',
    v_master,
    'master',
    'pickup',
    'ready',
    0,
    jsonb_build_object(
      'schedule',
      jsonb_build_object(
        'date', to_char(timezone('America/Caracas', v_delivery_at), 'YYYY-MM-DD'),
        'time_24', to_char(timezone('America/Caracas', v_delivery_at), 'HH24:MI:SS'),
        'asap', false
      )
    ),
    v_master
  ) returning id into v_order_id;

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
    '@sel|' || v_manzana_product_id::text || '|1'
  from public.products product
  where product.id = v_parent_id
  returning id into v_order_item_id;

  v_preview := public.inventory_preview_order_sale_v1(v_order_id);

  if jsonb_array_length(v_preview -> 'lines') <> 1
    or not exists (
      select 1 from jsonb_array_elements(v_preview -> 'lines') line
      where (line ->> 'inventory_item_id')::bigint = v_manzana_item_id
        and line ->> 'inventory_item_name' = 'Yukipack Manzana'
        and (line ->> 'quantity_units')::numeric = 1
    )
    or exists (
      select 1 from jsonb_array_elements(v_preview -> 'lines') line
      where (line ->> 'inventory_item_id')::bigint = 75
    )
  then
    raise exception 'Yukipack sale did not resolve exclusively to the selected flavor: %.', v_preview;
  end if;
end;
$$;

rollback;

select jsonb_build_object(
  'block', 18,
  'result', 'pass',
  'rollback_verified', not exists (
    select 1 from public.orders where order_number = 'TEST-INV-B18-ROLLBACK'
  )
);
