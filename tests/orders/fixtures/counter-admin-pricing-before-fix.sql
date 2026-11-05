-- Read-only production definition captured 2026-11-05. Only executed in isolated PostgreSQL.
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

  if new.reward_grant_id is not null then
    -- The later security-definer reward trigger validates ownership, funding and both currencies.
    return new;
  end if;
  if tg_op='UPDATE' and old.reward_grant_id is not null then raise exception 'Retira y vuelve a agregar la línea para quitar el premio.'; end if;

  if tg_op='UPDATE' and auth.uid() is not null and new.order_id=old.order_id
    and exists(select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or (public.has_role('counter') and o.fulfillment::text='pickup')
        or (public.has_role('advisor') and o.attributed_advisor_id=auth.uid()
          and not coalesce(o.is_price_locked,false) and o.status::text in ('created','queued')))
      and app_private.order_item_reduced_commercial_terms_v1(to_jsonb(old),to_jsonb(new),
        nullif(o.extra_fields#>>'{pricing,fx_rate}','')::numeric)) then
    return new;
  end if;
  -- A direct table update is not a back door to increase an old-price line.
  if tg_op='UPDATE' and new.product_id=old.product_id and new.qty>old.qty
    and old.crm_play_member_id is null and exists(select 1 from public.products p
      where p.id=old.product_id and (p.source_price_currency::text is distinct from old.pricing_origin_currency
        or p.source_price_amount is distinct from old.pricing_origin_amount)) then
    raise exception 'La cantidad añadida usa el precio actual. Agrégala como una línea nueva, conservando la cantidad acordada.' using errcode='22023';
  end if;

  if tg_op='INSERT' and new.draft_price_agreement_key is not null then
    declare agreed public.order_items%rowtype;
    begin
      agreed:=app_private.apply_agreed_draft_item_v1(new);
      if agreed.id is not null then return agreed; end if;
    end;
  end if;

  -- A note-only edit never recomputes a certified USD/Bs snapshot.
  if tg_op='UPDATE' and auth.uid() is not null
    and new.order_id=old.order_id
    and (to_jsonb(new)-'notes')=(to_jsonb(old)-'notes')
    and app_private.order_item_same_commercial_terms_v1(to_jsonb(old),to_jsonb(new))
    and exists (select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or (public.has_role('advisor')
        and o.attributed_advisor_id=auth.uid() and not coalesce(o.is_price_locked,false)
        and o.status::text in ('created','queued')))) then
    return new;
  end if;
  
  if tg_op = 'UPDATE' and auth.uid() is not null
    and (public.is_master_or_admin() or public.has_role('counter'))
    and app_private.order_item_operational_quantity_v1(to_jsonb(old),to_jsonb(new))
    and exists (select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or o.fulfillment::text='pickup')) then
    if new.qty is distinct from old.qty then
      new.line_total_usd := round(case when old.admin_price_override_usd is null then old.unit_price_usd_snapshot
        else old.line_total_usd / old.qty end * new.qty,2);
      new.line_total_bs_snapshot := round(old.unit_price_bs_snapshot * new.qty,2);
    end if;
    return new;
  end if;
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
    nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric as fx_rate
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

    if v_is_counter_direct_sale and position('@muerdeme|'in coalesce(new.notes,''))=0 then
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


  -- New ordinary lines use the native catalog price in BOTH currencies.
  -- Certified draft lines returned earlier; approved adjustments keep their own route.
  if tg_op='INSERT' and not v_is_crm_item and not v_is_counter_direct_sale
    and new.admin_price_override_usd is null and new.override_unit_price_usd is null then
    v_fx_rate:=coalesce(new.pricing_fx_rate_snapshot,v_product.fx_rate);
    if public.is_admin() is not true and v_fx_rate is distinct from v_product.fx_rate
      and v_fx_rate is distinct from (select rate_bs_per_usd from public.exchange_rates
        where is_active order by effective_at desc limit 1) then
      raise exception 'La tasa no coincide con la orden ni con la tasa activa.' using errcode='42501'; end if;
    if v_fx_rate is null or v_fx_rate<=0 or v_fx_rate::text in ('NaN','Infinity','-Infinity')
      or new.qty is null or new.qty<=0 or new.qty::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Cantidad o tasa inválida para agregar el producto.' using errcode='22023'; end if;
    new.pricing_origin_currency:=v_product.source_price_currency::text;
    new.pricing_origin_amount:=v_product.source_price_amount;
    if new.pricing_origin_amount is null or new.pricing_origin_amount<0
      or new.pricing_origin_amount::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Precio de catálogo inválido.' using errcode='22023'; end if;
    new.admin_price_override_reason:=null;
    new.admin_price_override_by_user_id:=null;
    new.admin_price_override_at:=null;
    new.pricing_fx_rate_snapshot:=v_fx_rate;
    if new.pricing_origin_currency='VES' then
      new.unit_price_bs_snapshot:=round(v_product.source_price_amount,2);
      new.line_total_bs_snapshot:=round(new.unit_price_bs_snapshot*new.qty,2);
      new.unit_price_usd_snapshot:=round(new.unit_price_bs_snapshot/v_fx_rate,2);
      new.line_total_usd:=round(new.line_total_bs_snapshot/v_fx_rate,2);
    elsif new.pricing_origin_currency='USD' then
      new.unit_price_usd_snapshot:=round(v_product.source_price_amount,2);
      new.line_total_usd:=round(new.unit_price_usd_snapshot*new.qty,2);
      new.unit_price_bs_snapshot:=round(new.unit_price_usd_snapshot*v_fx_rate,2);
      new.line_total_bs_snapshot:=round(new.line_total_usd*v_fx_rate,2);
    else raise exception 'Moneda de origen inválida.' using errcode='22023'; end if;
    return new;
  end if;
  -- VES is the economic source: convert the whole line before rounding USD.

  -- Earlier triggers can have replaced USD with catalog values already.
  -- Do not grant a new manual-price path to Master or Advisor.
  if not v_is_crm_item and not v_is_counter_direct_sale
    and new.pricing_origin_currency = 'VES'
    and new.override_unit_price_usd is null
    and (new.admin_price_override_usd is not null or (
      v_product.source_price_currency::text = 'VES'
      and new.pricing_origin_amount = v_product.source_price_amount
    ))
  then
    if new.admin_price_override_usd is not null then
      if public.is_admin() is not true then
        raise exception 'Solo admin puede ajustar precios manualmente.' using errcode = '42501';
      end if;
      if new.admin_price_override_usd < 0
        or new.admin_price_override_usd::text in ('NaN', 'Infinity', '-Infinity')
        or nullif(pg_catalog.btrim(new.admin_price_override_reason), '') is null
      then
        raise exception 'El ajuste requiere un precio valido y un motivo.' using errcode = '22023';
      end if;
    end if;

    -- A note-only update is not permission to revalue a historical snapshot.
    if tg_op = 'UPDATE' and row(new.product_id, new.qty,
      new.pricing_origin_currency, new.pricing_origin_amount,
      new.pricing_fx_rate_snapshot, new.admin_price_override_usd,
      new.admin_price_override_reason, new.unit_price_usd_snapshot,
      new.unit_price_bs_snapshot, new.line_total_bs_snapshot)
      is not distinct from row(old.product_id, old.qty,
      old.pricing_origin_currency, old.pricing_origin_amount,
      old.pricing_fx_rate_snapshot, old.admin_price_override_usd,
      old.admin_price_override_reason, old.unit_price_usd_snapshot,
      old.unit_price_bs_snapshot, old.line_total_bs_snapshot)
    then
      new.line_total_usd := old.line_total_usd;
      return new;
    end if;

    v_fx_rate := coalesce(new.pricing_fx_rate_snapshot, v_product.fx_rate);
    if public.is_admin() is not true
      and v_fx_rate is distinct from v_product.fx_rate
      and v_fx_rate is distinct from (
        select rate.rate_bs_per_usd from public.exchange_rates rate
        where rate.is_active order by rate.effective_at desc limit 1
      )
    then
      raise exception 'La tasa no coincide con la orden ni con la tasa activa.' using errcode = '42501';
    end if;
    if v_fx_rate is null or v_fx_rate <= 0
      or v_fx_rate::text in ('NaN', 'Infinity', '-Infinity')
      or new.pricing_origin_amount is null or new.pricing_origin_amount < 0
      or new.pricing_origin_amount::text in ('NaN', 'Infinity', '-Infinity')
      or new.qty is null or new.qty <= 0
      or new.qty::text in ('NaN', 'Infinity', '-Infinity')
    then
      raise exception 'Cantidad, precio o tasa VES invalida. Actualiza la orden antes de guardar.' using errcode = '22023';
    end if;
    new.pricing_fx_rate_snapshot := v_fx_rate;
    new.unit_price_bs_snapshot := pg_catalog.round(new.pricing_origin_amount, 2);
    new.line_total_bs_snapshot := pg_catalog.round(new.unit_price_bs_snapshot * new.qty, 2);
    new.unit_price_usd_snapshot := pg_catalog.round(new.unit_price_bs_snapshot / v_fx_rate, 2);
    new.line_total_usd := pg_catalog.round(new.line_total_bs_snapshot / v_fx_rate, 2);
    if new.admin_price_override_usd is not null then
      new.admin_price_override_usd := new.unit_price_bs_snapshot / v_fx_rate;
      new.admin_price_override_by_user_id := auth.uid();
      new.admin_price_override_at := coalesce(new.admin_price_override_at, statement_timestamp());
    end if;
    return new;
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

