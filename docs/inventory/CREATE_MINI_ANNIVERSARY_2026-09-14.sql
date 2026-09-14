-- Run inside a transaction with the requesting administrator's auth context.
-- Commercial window is reviewed manually by Master, as requested.
-- No new physical inventory items, no stock movements, no changes to the base product.
do $operation$
declare
  v_base public.products%rowtype;
  v_base_snapshot jsonb;
  v_created jsonb;
  v_product_id bigint;
  v_routes jsonb;
  v_links jsonb;
  v_item_count bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('MINI_TEQ_F_25_ANIV_20260914', 0));
  if exists (select 1 from public.products where sku = 'MINI_TEQ_F_25_ANIV_20260914') then
    raise exception 'Promotional SKU already exists; inspect it instead of duplicating or overwriting it';
  end if;
  select * into strict v_base from public.products where sku = 'MINI_TEQ_F_25';
  v_base_snapshot := to_jsonb(v_base);
  if v_base.units_per_service <> 25 or v_base.inventory_policy <> 'direct' then
    raise exception 'The original mini service has changed; review before creating the promotion';
  end if;
  select count(*) into v_item_count from public.inventory_items;

  select jsonb_agg(jsonb_set(r.value, '{links}', (
    select jsonb_agg(l.value - 'half_quantity_units' order by l.ordinality)
    from jsonb_array_elements(r.value->'links') with ordinality l(value, ordinality)
  )) order by r.ordinality)
  into v_routes
  from jsonb_array_elements(v_base.extra_fields->'inventory_routes_v1') with ordinality r(value, ordinality);
  select r.value->'links' into strict v_links
  from jsonb_array_elements(v_routes) r(value) where r.value->>'mode' = 'primary';

  v_created := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'Mini Tequeños Fritos (25 UND) · Aniversario 14–20 septiembre',
      'sku', 'MINI_TEQ_F_25_ANIV_20260914',
      'type', v_base.type,
      'source_price_currency', 'USD',
      'source_price_amount', 11,
      'units_per_service', 25,
      'allows_half_service', false,
      'is_temporary', true,
      'detail_units_limit', 0,
      'inventory_policy', 'direct',
      'commission_mode', v_base.commission_mode,
      'commission_value', v_base.commission_value,
      'commission_notes', v_base.commission_notes
    ),
    'links', v_links,
    'routes', v_routes
  ));
  v_product_id := (v_created->>'product_id')::bigint;
  perform public.inventory_activate_product_draft_v1(v_product_id);

  if not exists (select 1 from public.products where id = v_product_id
    and is_active and is_temporary and inventory_configuration_status = 'ready'
    and source_price_currency = 'USD' and source_price_amount = 11 and base_price_usd = 11
    and units_per_service = 25 and not allows_half_service
    and commission_mode = v_base.commission_mode
    and commission_value is not distinct from v_base.commission_value) then
    raise exception 'Promotional product verification failed';
  end if;
  if (select count(*) from public.inventory_items) <> v_item_count then
    raise exception 'Unexpected physical inventory item created';
  end if;
  if (select to_jsonb(p) from public.products p where id = v_base.id) <> v_base_snapshot then
    raise exception 'Original product was unexpectedly modified';
  end if;
  if (select count(*) from public.product_inventory_links where product_id = v_product_id and is_active) <> jsonb_array_length(v_links)
    or exists (
      select 1 from jsonb_array_elements(v_links) l(value)
      where not exists (select 1 from public.product_inventory_links pil
        where pil.product_id = v_product_id and pil.is_active
          and pil.inventory_item_id = (l.value->>'inventory_item_id')::bigint
          and pil.quantity_units = (l.value->>'quantity_units')::numeric)
    ) then
    raise exception 'Shared raw inventory verification failed';
  end if;
end;
$operation$;
