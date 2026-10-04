CREATE OR REPLACE FUNCTION public.counter_build_pickup_item_plan(p_order_id bigint, p_existing_items jsonb, p_added_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders%rowtype;
  v_rate numeric(18,6);
  v_existing_plan jsonb;
  v_added_plan jsonb;
  v_existing_count integer;
  v_had_reduction boolean := false;
  v_had_existing_increase boolean := false;
  v_subtotal_usd numeric(12,2);
  v_subtotal_bs numeric(12,2);
  v_discount_enabled boolean;
  v_discount_pct numeric(9,4);
  v_discount_usd numeric(12,2);
  v_discount_bs numeric(12,2);
  v_after_discount_usd numeric(12,2);
  v_after_discount_bs numeric(12,2);
  v_invoice_tax_pct numeric(9,4);
  v_invoice_tax_usd numeric(12,2);
  v_invoice_tax_bs numeric(12,2);
  v_total_usd numeric(12,2);
  v_total_bs numeric(12,2);
begin
  p_existing_items := coalesce(p_existing_items, '[]'::jsonb);
  p_added_items := coalesce(p_added_items, '[]'::jsonb);

  if jsonb_typeof(p_existing_items) <> 'array'
     or jsonb_array_length(p_existing_items) > 200 then
    raise exception 'existing_items must be an array with at most 200 lines';
  end if;

  if jsonb_typeof(p_added_items) <> 'array'
     or jsonb_array_length(p_added_items) > 100 then
    raise exception 'added_items must be an array with at most 100 lines';
  end if;

  select *
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  select count(*)::integer
  into v_existing_count
  from public.order_items item
  where item.order_id = p_order_id;

  if jsonb_array_length(p_existing_items) <> v_existing_count then
    raise exception 'existing_items must include every current order line exactly once';
  end if;

  if exists (
    select 1
    from (
      select requested.item_id, count(*) as uses
      from jsonb_to_recordset(p_existing_items)
        as requested(item_id bigint, qty numeric)
      group by requested.item_id
    ) duplicate
    where duplicate.item_id is null or duplicate.uses <> 1
  ) then
    raise exception 'Every existing item requires one unique item_id';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_existing_items)
      as requested(item_id bigint, qty numeric)
    left join public.order_items item
      on item.id = requested.item_id
     and item.order_id = p_order_id
    where item.id is null
       or requested.qty is null
       or requested.qty < 0
       or requested.qty > 999
  ) then
    raise exception 'An existing item or quantity is invalid';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_added_items)
      as requested(product_id bigint, qty numeric, notes text)
    left join public.products product
      on product.id = requested.product_id
     and product.is_active = true
    where product.id is null
       or requested.qty is null
       or requested.qty <= 0
       or requested.qty > 999
       or char_length(coalesce(requested.notes, '')) > 4000
  ) then
    raise exception 'An added product or quantity is invalid';
  end if;

  select rate.rate_bs_per_usd
  into v_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  if coalesce(v_rate, 0) <= 0 then
    raise exception 'There is no active exchange rate';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'itemId', item.id,
          'productId', item.product_id,
          'name', item.product_name_snapshot,
          'sku', item.sku_snapshot,
          'previousQty', item.qty,
          'qty', requested.qty,
          'notes', item.notes,
          'pricingOriginCurrency', item.pricing_origin_currency,
          'pricingOriginAmount', item.pricing_origin_amount,
          'unitUsd', item.unit_price_usd_snapshot,
          'unitBs', coalesce(
            item.unit_price_bs_snapshot,
            round(item.unit_price_usd_snapshot * v_rate, 2)
          ),
          'lineUsd', round(item.unit_price_usd_snapshot * requested.qty, 2),
          'lineBs', round(
            coalesce(
              item.unit_price_bs_snapshot,
              item.unit_price_usd_snapshot * v_rate
            ) * requested.qty,
            2
          )
        )
        order by item.id
      ),
      '[]'::jsonb
    ),
    coalesce(bool_or(requested.qty < item.qty), false),
    coalesce(bool_or(requested.qty > item.qty), false)
  into
    v_existing_plan,
    v_had_reduction,
    v_had_existing_increase
  from public.order_items item
  join jsonb_to_recordset(p_existing_items)
    as requested(item_id bigint, qty numeric)
    on requested.item_id = item.id
  where item.order_id = p_order_id;

  with requested as (
    select
      value,
      ordinality,
      (value ->> 'product_id')::bigint as product_id,
      (value ->> 'qty')::numeric as qty,
      nullif(btrim(value ->> 'notes'), '') as notes
    from jsonb_array_elements(p_added_items) with ordinality
  ),
  priced as (
    select
      requested.ordinality,
      requested.product_id,
      requested.qty,
      requested.notes,
      product.name,
      product.sku,
      product.base_price_usd,
      case
        when product.source_price_currency = 'VES' then 'VES'
        else 'USD'
      end as source_currency,
      case
        when product.source_price_currency = 'VES'
          then coalesce(nullif(product.source_price_amount, 0), product.base_price_bs, 0)
        else coalesce(nullif(product.source_price_amount, 0), product.base_price_usd, 0)
      end as source_amount
    from requested
    join public.products product
      on product.id = requested.product_id
     and product.is_active = true
  ),
  snapshots as (
    select
      priced.*,
      round(priced.base_price_usd, 2) as unit_usd,
      case
        when priced.source_currency = 'VES'
          then round(priced.source_amount, 2)
        else round(priced.source_amount * v_rate, 2)
      end as unit_bs
    from priced
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'productId', snapshots.product_id,
        'name', snapshots.name,
        'sku', snapshots.sku,
        'qty', snapshots.qty,
        'notes', snapshots.notes,
        'pricingOriginCurrency', snapshots.source_currency,
        'pricingOriginAmount', snapshots.source_amount,
        'unitUsd', snapshots.unit_usd,
        'unitBs', snapshots.unit_bs,
        'lineUsd', round(snapshots.unit_usd * snapshots.qty, 2),
        'lineBs', round(snapshots.unit_bs * snapshots.qty, 2)
      )
      order by snapshots.ordinality
    ),
    '[]'::jsonb
  )
  into v_added_plan
  from snapshots;

  if not v_had_reduction
     and not v_had_existing_increase
     and jsonb_array_length(v_added_plan) = 0 then
    raise exception 'The pickup item plan does not contain changes';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_existing_plan) item
    where (item ->> 'qty')::numeric > 0
  )
  and jsonb_array_length(v_added_plan) = 0 then
    raise exception 'A pickup order must keep at least one item';
  end if;

  select
    round(coalesce(sum((item ->> 'lineUsd')::numeric), 0), 2),
    round(coalesce(sum((item ->> 'lineBs')::numeric), 0), 2)
  into v_subtotal_usd, v_subtotal_bs
  from (
    select item
    from jsonb_array_elements(v_existing_plan) item
    where (item ->> 'qty')::numeric > 0
    union all
    select item
    from jsonb_array_elements(v_added_plan) item
  ) lines;

  v_discount_enabled :=
    coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_enabled}', '')::boolean, false)
    or coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_amount_usd}', '')::numeric, 0) > 0
    or coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_amount_bs}', '')::numeric, 0) > 0;
  v_discount_pct := case
    when v_discount_enabled
      then greatest(
        0,
        least(
          100,
          coalesce(nullif(v_order.extra_fields #>> '{pricing,discount_pct}', '')::numeric, 0)
        )
      )
    else 0
  end;
  v_invoice_tax_pct := greatest(
    0,
    coalesce(nullif(v_order.extra_fields #>> '{pricing,invoice_tax_pct}', '')::numeric, 0)
  );

  v_discount_usd := round(v_subtotal_usd * v_discount_pct / 100, 2);
  v_discount_bs := round(v_subtotal_bs * v_discount_pct / 100, 2);
  v_after_discount_usd := round(greatest(v_subtotal_usd - v_discount_usd, 0), 2);
  v_after_discount_bs := round(greatest(v_subtotal_bs - v_discount_bs, 0), 2);
  v_invoice_tax_usd := round(v_after_discount_usd * v_invoice_tax_pct / 100, 2);
  v_invoice_tax_bs := round(v_after_discount_bs * v_invoice_tax_pct / 100, 2);
  v_total_usd := round(v_after_discount_usd + v_invoice_tax_usd, 2);
  v_total_bs := round(v_after_discount_bs + v_invoice_tax_bs, 2);

  return jsonb_build_object(
    'existingItems', v_existing_plan,
    'addedItems', v_added_plan,
    'hadReduction', v_had_reduction,
    'hadExistingIncrease', v_had_existing_increase,
    'hasAdditions', jsonb_array_length(v_added_plan) > 0,
    'needsKitchen',
      v_had_existing_increase or jsonb_array_length(v_added_plan) > 0,
    'pricing', jsonb_build_object(
      'fx_rate', v_rate,
      'discount_enabled', v_discount_enabled,
      'discount_pct', v_discount_pct,
      'discount_amount_usd', v_discount_usd,
      'discount_amount_bs', v_discount_bs,
      'subtotal_usd', v_subtotal_usd,
      'subtotal_bs', v_subtotal_bs,
      'subtotal_after_discount_usd', v_after_discount_usd,
      'subtotal_after_discount_bs', v_after_discount_bs,
      'invoice_tax_pct', v_invoice_tax_pct,
      'invoice_tax_amount_usd', v_invoice_tax_usd,
      'invoice_tax_amount_bs', v_invoice_tax_bs,
      'total_usd', v_total_usd,
      'total_bs', v_total_bs
    )
  );
end;
$function$
;
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
$function$
;
CREATE OR REPLACE FUNCTION public.trg_order_items_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_order_id bigint;
  v_locked boolean;
  v_bypass text;
begin
  -- Bypass controlado (para función de recalcular precios)
  v_bypass := current_setting('app.bypass_lock', true);
  if v_bypass = 'true' then
    return coalesce(new, old);
  end if;

  v_order_id := coalesce(new.order_id, old.order_id);

  select o.is_price_locked into v_locked
  from public.orders o
  where o.id = v_order_id;

  if v_locked then
    -- Solo master/admin puede tocar items si está locked
    if not public.is_master_or_admin() then
      raise exception 'Order is price-locked. Only master/admin can edit items.';
    end if;

    -- Aún siendo master/admin: si quieres, puedes permitir todo.
    -- Pero por seguridad, mantenemos el criterio: cambios estructurales requieren intención.
    -- (Si prefieres permitir todo a master/admin, dime y lo abrimos.)
  end if;

  return coalesce(new, old);
end;
$function$
;
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
$function$
;
