-- Block 23 transactional certification.
-- Run as a privileged SQL session against the Vivo Ops project. Every data
-- mutation is rolled back; the final query must report draft_rolled_back=true.

begin;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (
    select user_id::text
    from public.user_roles
    where role = 'admin'::public.user_role
    limit 1
  ),
  true
);

do $test$
declare
  v_result jsonb;
  v_product_id bigint;
  v_active public.products%rowtype;
begin
  v_result := public.inventory_save_catalog_draft_v1(jsonb_build_object(
    'entry_kind', 'product',
    'product', jsonb_build_object(
      'name', 'Prueba transaccional bloque 23',
      'sku', 'BLOCK23-TX-ROLLBACK',
      'type', 'product',
      'source_price_amount', 12.34,
      'source_price_currency', 'USD',
      'units_per_service', 1,
      'allows_half_service', false,
      'is_temporary', true,
      'detail_units_limit', 0,
      'inventory_policy', 'none',
      'none_reason', 'Prueba transaccional',
      'commission_mode', 'fixed_item',
      'commission_value', 8.5,
      'commission_notes', 'Prueba',
      'advisor_gift_cost_usd', 1.25,
      'internal_rider_pay_usd', 0.75
    )
  ));

  v_product_id := (v_result ->> 'product_id')::bigint;
  if not exists (
    select 1
    from public.products product
    where product.id = v_product_id
      and product.commission_mode = 'fixed_item'
      and product.commission_value = 8.5
      and product.commission_notes = 'Prueba'
      and (product.extra_fields ->> 'advisor_gift_cost_usd')::numeric = 1.25
      and product.internal_rider_pay_usd = 0.75
      and product.source_price_amount = 12.34
      and product.source_price_currency = 'USD'::public.currency_code
      and not product.is_active
  ) then
    raise exception 'El borrador integrado no guardó todos los términos comerciales.';
  end if;

  select product.*
  into v_active
  from public.products product
  where product.is_active
  order by product.id
  limit 1;

  v_result := public.inventory_update_product_identity_v1(jsonb_build_object(
    'product_id', v_active.id,
    'name', v_active.name,
    'sku', v_active.sku,
    'units_per_service', v_active.units_per_service,
    'allows_half_service', v_active.allows_half_service,
    'is_temporary', v_active.is_temporary,
    'detail_units_limit', v_active.detail_units_limit,
    'source_price_amount', 99.25,
    'source_price_currency', 'USD',
    'commission_mode', 'fixed_order',
    'commission_value', 6,
    'commission_notes', 'Prueba activa',
    'advisor_gift_cost_usd', 2.5,
    'internal_rider_pay_usd', null
  ));

  if not exists (
    select 1
    from public.products product
    where product.id = v_active.id
      and product.source_price_amount = 99.25
      and product.commission_mode = 'fixed_order'
      and product.commission_value = 6
      and product.commission_notes = 'Prueba activa'
      and (product.extra_fields ->> 'advisor_gift_cost_usd')::numeric = 2.5
      and product.internal_rider_pay_usd is null
  ) then
    raise exception 'La edición integrada no guardó todos los términos comerciales.';
  end if;

  if coalesce((v_result ->> 'inventory_topology_changed')::boolean, true) then
    raise exception 'La edición comercial indicó un cambio de topología de inventario.';
  end if;
end;
$test$;

rollback;

select jsonb_build_object(
  'draft_rolled_back', not exists (
    select 1
    from public.products
    where sku = 'BLOCK23-TX-ROLLBACK'
  ),
  'public_contract', pg_catalog.to_regprocedure(
    'public.inventory_save_catalog_draft_v1(jsonb)'
  ) is not null,
  'private_core', pg_catalog.to_regprocedure(
    'app_private.inventory_save_catalog_draft_core_v1(jsonb)'
  ) is not null
) as verification;
