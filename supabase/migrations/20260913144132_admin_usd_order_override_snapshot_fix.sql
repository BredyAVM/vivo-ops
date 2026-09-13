-- Applied with the self-cleaning order-usd-override SQL integration test.
set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

CREATE OR REPLACE FUNCTION public.trg_order_items_set_pricing()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_product record;
  v_unit_price numeric;
  v_is_counter_direct_sale boolean := false;
  v_is_crm_item boolean := new.crm_play_member_id is not null;
  v_fx_rate numeric;
begin
  if new.override_unit_price_usd is not null
    or new.override_reason is not null
    or new.override_approved_by is not null
    or new.override_approved_at is not null
  then
    if not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  select
    product.id,
    product.sku,
    product.name,
    product.base_price_usd,
    product.base_price_bs,
    product.source_price_currency,
    product.source_price_amount,
    coalesce(order_data.extra_fields #>> '{counter,quick_sale}', 'false') = 'true' as is_counter_direct_sale,
    case
      when coalesce(order_data.extra_fields #>> '{counter,quick_sale}', 'false') = 'true'
        then nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric
      else null
    end as fx_rate
  into v_product
  from public.products product
  join public.orders order_data on order_data.id = new.order_id
  where product.id = new.product_id;

  if not found then
    raise exception 'Invalid product_id';
  end if;

  v_is_counter_direct_sale := v_product.is_counter_direct_sale;
  v_fx_rate := v_product.fx_rate;

  if tg_op = 'INSERT' then
    new.sku_snapshot := v_product.sku;
    new.product_name_snapshot := v_product.name;

    if v_is_crm_item then
      v_unit_price := coalesce(new.unit_price_usd_snapshot, 0);
      new.line_total_usd := pg_catalog.round(coalesce(new.qty, 0) * v_unit_price, 2);
      return new;
    end if;

    if v_is_counter_direct_sale then
      if v_fx_rate is null or v_fx_rate <= 0 then
        raise exception 'counter_exchange_rate_invalid';
      end if;

      new.pricing_origin_currency := v_product.source_price_currency::text;
      new.pricing_origin_amount := v_product.source_price_amount;

      if v_product.source_price_currency::text = 'VES' then
        new.unit_price_bs_snapshot := pg_catalog.round(v_product.source_price_amount, 2);
        new.line_total_bs_snapshot := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0), 2);
        new.unit_price_usd_snapshot := pg_catalog.round(v_product.source_price_amount / v_fx_rate, 2);
        new.line_total_usd := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0) / v_fx_rate, 2);
      else
        new.unit_price_usd_snapshot := pg_catalog.round(v_product.source_price_amount, 2);
        new.line_total_usd := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0), 2);
        new.unit_price_bs_snapshot := pg_catalog.round(v_product.source_price_amount * v_fx_rate, 2);
        new.line_total_bs_snapshot := pg_catalog.round(v_product.source_price_amount * coalesce(new.qty, 0) * v_fx_rate, 2);
      end if;

      return new;
    end if;

    new.unit_price_usd_snapshot := v_product.base_price_usd;
  end if;

  -- Modern administrative USD overrides are written by the atomic order editor.
  -- Its INSERT rebuild must not replace the authorized price with today's catalog.
  -- Leave CRM benefits, counter sales and legacy override precedence unchanged.
  if not v_is_crm_item
    and not v_is_counter_direct_sale
    and new.pricing_origin_currency = 'USD'
    and new.admin_price_override_usd is not null
  then
    if not public.is_admin() then
      raise exception 'Solo admin puede ajustar precios manualmente.' using errcode = '42501';
    end if;
    if new.admin_price_override_usd < 0
      or new.admin_price_override_usd::text in ('NaN', 'Infinity', '-Infinity')
      or nullif(pg_catalog.btrim(new.admin_price_override_reason), '') is null
    then
      raise exception 'El ajuste requiere un precio válido y un motivo.' using errcode = '22023';
    end if;
    new.unit_price_usd_snapshot := pg_catalog.round(new.admin_price_override_usd, 2);
    new.admin_price_override_by_user_id := auth.uid();
    new.admin_price_override_at := coalesce(new.admin_price_override_at, statement_timestamp());
    new.line_total_usd := pg_catalog.round(
      coalesce(new.qty, 0) * coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot), 2
    );
    -- Bs snapshots already use the editor's effective FX. The parent header can
    -- still contain the previous FX until the atomic command completes.
    return new;
  end if;

  v_unit_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
  new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_unit_price, 0);
  return new;
end;
$function$
;

commit;
