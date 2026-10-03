-- Read-only production trigger snapshots (2026-10-03) for price command regression.
CREATE OR REPLACE FUNCTION public.trg_order_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_locked boolean;
  v_product record;
  v_effective_unit numeric;
begin
  -- Find parent order lock state
  select o.is_price_locked
    into v_locked
  from public.orders o
  where o.id = coalesce(new.order_id, old.order_id);

  -- (A) If order is locked -> only master/admin can INSERT/UPDATE/DELETE items
  if v_locked is true then
    if not (public.is_admin() or public.is_master()) then
      raise exception 'Order is price-locked. Only master/admin can edit items.';
    end if;
  end if;

  -- (B) Pricing override ONLY admin (insert or update)
  if tg_op in ('INSERT','UPDATE') then
    if new.override_unit_price_usd is not null
       or new.override_reason is not null
       or new.override_approved_by is not null
       or new.override_approved_at is not null then

      if not public.is_admin() then
        raise exception 'Only ADMIN can change item pricing or set an override.';
      end if;

      -- If admin sets override price, stamp approval if not provided
      if new.override_unit_price_usd is not null then
        if new.override_approved_by is null then
          new.override_approved_by := auth.uid();
        end if;
        if new.override_approved_at is null then
          new.override_approved_at := now();
        end if;
      end if;
    end if;
  end if;

  -- (C) Prevent NON-admin from changing snapshot pricing fields on UPDATE
  if tg_op = 'UPDATE' then
    if not public.is_admin() then
      if new.unit_price_usd_snapshot is distinct from old.unit_price_usd_snapshot
         or new.line_total_usd is distinct from old.line_total_usd then
        raise exception 'Only ADMIN can change item pricing or set an override.';
      end if;
    end if;
  end if;

  -- (D) Fill snapshots + calculate line_total automatically (insert/update)
  if tg_op in ('INSERT','UPDATE') then
    select p.id, p.sku, p.name, p.base_price_usd
      into v_product
    from public.products p
    where p.id = new.product_id;

    if new.sku_snapshot is null then
      new.sku_snapshot := v_product.sku;
    end if;

    if new.product_name_snapshot is null then
      new.product_name_snapshot := v_product.name;
    end if;

    -- If snapshot unit price is null, take current product base_price_usd
    if new.unit_price_usd_snapshot is null then
      new.unit_price_usd_snapshot := v_product.base_price_usd;
    end if;

    -- Effective unit price: override if present (admin-only), else snapshot
    v_effective_unit := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
    new.line_total_usd := coalesce(new.qty, 0) * coalesce(v_effective_unit, 0);
  end if;

  return coalesce(new, old);
end;
$function$;
CREATE OR REPLACE FUNCTION public.trg_order_items_pricing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_effective_price numeric(12,2);
  v_price_fields_changed boolean;
  v_product_price numeric(12,2);
  v_is_crm_item boolean := new.crm_play_member_id is not null;
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      if not v_is_crm_item then
        select pg_catalog.round(coalesce(product.base_price_usd, 0)::numeric, 2)
        into v_product_price
        from public.products product
        where product.id = new.product_id;

        if not found then
          raise exception 'Product % not found for order item insert', new.product_id;
        end if;

        new.unit_price_usd_snapshot := v_product_price;
      end if;

      new.override_unit_price_usd := null;
      new.override_reason := null;
      new.override_approved_by := null;
      new.override_approved_at := null;
    elsif not v_is_crm_item and new.unit_price_usd_snapshot is null then
      select pg_catalog.round(coalesce(product.base_price_usd, 0)::numeric, 2)
      into v_product_price
      from public.products product
      where product.id = new.product_id;

      if not found then
        raise exception 'Product % not found for order item insert', new.product_id;
      end if;

      new.unit_price_usd_snapshot := v_product_price;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    v_price_fields_changed :=
      (new.unit_price_usd_snapshot is distinct from old.unit_price_usd_snapshot)
      or (new.override_unit_price_usd is distinct from old.override_unit_price_usd)
      or (new.override_reason is distinct from old.override_reason);

    if v_price_fields_changed and not public.is_admin() then
      raise exception 'Only ADMIN can change item pricing or set an override.';
    end if;
  end if;

  if new.override_unit_price_usd is not null then
    if coalesce(nullif(pg_catalog.btrim(new.override_reason), ''), '') = '' then
      raise exception 'override_reason is required when override_unit_price_usd is set.';
    end if;

    if tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and (
        new.override_unit_price_usd is distinct from old.override_unit_price_usd
        or new.override_reason is distinct from old.override_reason
      ))
    then
      new.override_approved_by := coalesce(auth.uid(), new.override_approved_by);
      new.override_approved_at := pg_catalog.now();
    end if;
  else
    new.override_reason := null;
    new.override_approved_by := null;
    new.override_approved_at := null;
  end if;

  v_effective_price := coalesce(new.override_unit_price_usd, new.unit_price_usd_snapshot);
  new.line_total_usd := pg_catalog.round((new.qty * v_effective_price)::numeric, 2);
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.trg_order_items_recalc_order_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order_id bigint;
  v_total numeric;
begin
  v_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(oi.line_total_usd), 0)
    into v_total
  from public.order_items oi
  where oi.order_id = v_order_id;

  update public.orders
     set total_usd = v_total
   where id = v_order_id;

  return null;
end;
$function$;
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
$function$;
create trigger order_items_guard before insert or update on public.order_items for each row execute function public.trg_order_items_guard();

create trigger order_items_pricing_guard before insert or update on public.order_items for each row execute function public.trg_order_items_pricing_guard();

create trigger order_items_set_pricing before insert or update on public.order_items for each row execute function public.trg_order_items_set_pricing();

create trigger order_items_recalc_order_total after insert or update on public.order_items for each row execute function public.trg_order_items_recalc_order_total();
