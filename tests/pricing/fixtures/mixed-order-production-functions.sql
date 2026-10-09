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
    -- Find parent order lock state
  select o.is_price_locked
    into v_locked
  from public.orders o
  where o.id = coalesce(new.order_id, old.order_id);

  -- (A) If order is locked -> only master/admin can INSERT/UPDATE/DELETE items
  if v_locked is true then
    if not (public.is_master_or_admin() or (auth.uid() is not null and public.has_role('counter') and exists (select 1 from public.orders o where o.id=coalesce(new.order_id,old.order_id) and o.fulfillment::text='pickup' and o.status::text in ('created','queued','confirmed','in_kitchen','ready')))) then
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


CREATE OR REPLACE FUNCTION app_private.update_order_core_atomic_v1(p_order_id bigint, p_expected_last_modified_at timestamp with time zone, p_order_patch jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_is_master boolean := public.is_master_or_admin();
  v_is_admin boolean := public.is_admin();
  v_order public.orders%rowtype;
  v_now timestamptz := statement_timestamp();
  v_item jsonb;
  v_existing public.order_items%rowtype;
  v_new_item_id bigint;
  v_item_ids jsonb := '[]'::jsonb;
  v_preserved_legacy_ids bigint[] := array[]::bigint[];
  v_preserved_approved_ids bigint[] := array[]::bigint[];
  v_item_count integer := 0;
  v_new_client_id bigint;
  v_new_advisor_id uuid;
  v_new_source text;
  v_new_status text;
  v_new_fulfillment text;
  v_extra jsonb;
  v_pricing jsonb;
  v_previous_fund numeric := 0;
  v_next_fund numeric := 0;
  v_available_fund numeric := 0;
  v_subtotal_usd numeric := 0;
  v_subtotal_bs numeric := 0;
  v_discount_enabled boolean := false;
  v_discount_pct numeric := 0;
  v_discount_usd numeric := 0;
  v_discount_bs numeric := 0;
  v_after_discount_usd numeric := 0;
  v_after_discount_bs numeric := 0;
  v_tax_pct numeric := 0;
  v_tax_usd numeric := 0;
  v_tax_bs numeric := 0;
  v_total_usd numeric := 0;
  v_total_bs numeric := 0;
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesión para modificar la orden.' using errcode = '42501';
  end if;
  if p_order_id is null or p_order_id <= 0 then
    raise exception 'La orden no es válida.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_order_patch) is distinct from 'object' then
    raise exception 'Los datos de la orden no son válidos.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_items) < 1
    or pg_catalog.jsonb_array_length(p_items) > 200
  then
    raise exception 'La orden debe contener entre 1 y 200 ítems.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('order-edit:' || p_order_id::text, 0)
  );

  select order_row.*
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'No se encontró la orden.' using errcode = 'P0002';
  end if;
  if v_order.last_modified_at is distinct from p_expected_last_modified_at then
    raise exception 'La orden cambió mientras la editabas. Ciérrala y vuelve a abrirla antes de guardar.'
      using errcode = '40001';
  end if;

  if v_is_master then
    if v_order.status::text not in ('created', 'queued', 'confirmed', 'in_kitchen', 'ready') then
      raise exception 'La orden ya no admite modificaciones operativas.' using errcode = '55000';
    end if;
  else
    if v_order.attributed_advisor_id is distinct from v_uid then
      raise exception 'No puedes modificar esta orden.' using errcode = '42501';
    end if;
    if v_order.status::text not in ('created', 'queued') then
      raise exception 'La orden ya entró a cocina y no puede modificarse.' using errcode = '55000';
    end if;
    if coalesce(v_order.is_price_locked, false) then
      raise exception 'La orden tiene el precio protegido y requiere revisión de Máster.' using errcode = '55000';
    end if;
  end if;

  begin
    v_new_client_id := nullif(p_order_patch ->> 'client_id', '')::bigint;
    v_new_advisor_id := nullif(p_order_patch ->> 'attributed_advisor_id', '')::uuid;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'El cliente o el asesor de la orden no es válido.' using errcode = '22023';
  end;

  v_new_source := coalesce(nullif(p_order_patch ->> 'source', ''), v_order.source::text);
  v_new_status := coalesce(nullif(p_order_patch ->> 'status', ''), v_order.status::text);
  v_new_fulfillment := coalesce(nullif(p_order_patch ->> 'fulfillment', ''), v_order.fulfillment::text);
  v_extra := case
    when pg_catalog.jsonb_typeof(p_order_patch -> 'extra_fields') = 'object'
      then p_order_patch -> 'extra_fields'
    else '{}'::jsonb
  end;

  if v_new_client_id is null or not exists (
    select 1 from public.clients client where client.id = v_new_client_id
  ) then
    raise exception 'El cliente de la orden no está disponible.' using errcode = '22023';
  end if;
  if v_new_source not in ('advisor', 'master', 'walk_in')
    or v_new_fulfillment not in ('pickup', 'delivery')
    or v_new_status not in ('created', 'queued', 'confirmed', 'in_kitchen', 'ready')
  then
    raise exception 'El estado operativo de la orden no es válido.' using errcode = '22023';
  end if;
  if v_new_fulfillment = 'delivery'
    and coalesce(pg_catalog.btrim(p_order_patch ->> 'delivery_address'), '') = ''
  then
    raise exception 'La dirección es obligatoria para delivery.' using errcode = '22023';
  end if;
  if not v_is_master and (
    v_new_advisor_id is distinct from v_uid
    or v_new_source <> 'advisor'
    or v_new_status <> 'created'
  ) then
    raise exception 'El asesor no puede cambiar la atribución ni el estado operativo de la orden.'
      using errcode = '42501';
  end if;
  if coalesce((p_order_patch ->> 'is_price_locked')::boolean, v_order.is_price_locked, false)
    and not v_is_admin
    and not coalesce(v_order.is_price_locked, false)
  then
    raise exception 'Solo admin puede proteger el precio de la orden.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) incoming(order_item_id bigint)
    where incoming.order_item_id is not null
    group by incoming.order_item_id
    having count(*) > 1
  ) then
    raise exception 'La modificación contiene una línea repetida.' using errcode = '23505';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) incoming(order_item_id bigint)
    left join public.order_items existing
      on existing.id = incoming.order_item_id
     and existing.order_id = p_order_id
    where incoming.order_item_id is not null
      and existing.id is null
  ) then
    raise exception 'Una línea de la orden cambió mientras la editabas. Vuelve a abrir el editor.'
      using errcode = '40001';
  end if;

  -- Redeemed benefits are immutable audit evidence. They must stay in the order;
  -- the optional decision happens before redemption.
  if exists (
    select 1
    from public.order_items existing
    where existing.order_id = p_order_id
      and existing.crm_play_member_id is not null
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(p_items) incoming(order_item_id bigint)
        where incoming.order_item_id = existing.id
      )
  ) then
    raise exception 'Un beneficio ya aplicado no puede quitarse desde una modificación ordinaria.'
      using errcode = '55000';
  end if;

  -- A date/address edit is not a new gift grant. Retain only exact existing
  -- legacy lines for the same order, client, advisor and source. Never trust a
  -- browser flag, product name or a copied line as proof of gift entitlement.
  perform item.id from public.order_items item
  where item.order_id = p_order_id order by item.id for update;

  select coalesce(pg_catalog.array_agg(item.id), array[]::bigint[])
  into v_preserved_legacy_ids
  from public.order_items item
  join public.products product on product.id = item.product_id
  join pg_catalog.jsonb_array_elements(p_items) incoming(value)
    on nullif(incoming.value ->> 'order_item_id', '')::bigint = item.id
  where item.order_id = p_order_id
    and v_new_client_id is not distinct from v_order.client_id
    and v_new_advisor_id is not distinct from v_order.attributed_advisor_id
    and v_new_source = v_order.source::text
    and item.crm_play_member_id is null
    and item.crm_play_benefit_id is null
    and item.crm_play_benefit_upgrade_id is null
    and (product.type::text = 'gambit'
      or product.extra_fields ->> 'catalog_access_scope' = 'crm_only')
    and coalesce(product.extra_fields ->> 'catalog_access_scope', '') <> 'advisor_gift'
    and nullif(incoming.value ->> 'crm_play_member_id', '') is null
    and nullif(incoming.value ->> 'crm_play_benefit_id', '') is null
    and nullif(incoming.value ->> 'crm_play_benefit_upgrade_id', '') is null
    and item.product_id = (incoming.value ->> 'product_id')::bigint
    and item.qty = (incoming.value ->> 'qty')::numeric
    and item.pricing_origin_currency = incoming.value ->> 'pricing_origin_currency'
    and item.pricing_origin_amount = (incoming.value ->> 'pricing_origin_amount')::numeric
    and item.unit_price_usd_snapshot = (incoming.value ->> 'unit_price_usd_snapshot')::numeric
    and item.line_total_usd = (incoming.value ->> 'line_total_usd')::numeric
    and item.unit_price_bs_snapshot = (incoming.value ->> 'unit_price_bs_snapshot')::numeric
    and item.line_total_bs_snapshot = (incoming.value ->> 'line_total_bs_snapshot')::numeric
    and item.admin_price_override_usd is not distinct from
      nullif(incoming.value ->> 'admin_price_override_usd', '')::numeric
    and item.override_unit_price_usd is not distinct from
      nullif(incoming.value ->> 'override_unit_price_usd', '')::numeric
    -- Detail serializers may reorder lines. Compare the complete multiset,
    -- including @sel quantities, without discarding duplicates or composition.
    and (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
      from pg_catalog.regexp_split_to_table(coalesce(item.notes, ''), E'\r?\n') line
      where btrim(line) <> '')
      = (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
      from pg_catalog.regexp_split_to_table(coalesce(incoming.value ->> 'notes', ''), E'\r?\n') line
      where btrim(line) <> '');

  -- Identity, context and complete economic evidence must still match the locked
  -- database row. An inactive catalog product can be retained, never re-granted.
  if v_is_master and not v_is_admin then
    select coalesce(pg_catalog.array_agg(item.id), array[]::bigint[])
    into v_preserved_approved_ids
    from public.order_items item
    join pg_catalog.jsonb_array_elements(p_items) incoming(value)
      on nullif(incoming.value ->> 'order_item_id', '')::bigint = item.id
    where item.order_id = p_order_id
      and item.admin_price_override_usd is not null
      and item.crm_play_member_id is null
      and v_new_client_id is not distinct from v_order.client_id
      and v_new_advisor_id is not distinct from v_order.attributed_advisor_id
      and v_new_source = v_order.source::text
      and item.product_id = (incoming.value ->> 'product_id')::bigint
      and (incoming.value ->> 'qty')::numeric > 0
      and item.pricing_origin_currency = incoming.value ->> 'pricing_origin_currency'
      and item.pricing_origin_amount = (incoming.value ->> 'pricing_origin_amount')::numeric
      and item.unit_price_usd_snapshot = (incoming.value ->> 'unit_price_usd_snapshot')::numeric
      and (incoming.value ->> 'line_total_usd')::numeric = case when item.qty=(incoming.value ->> 'qty')::numeric then item.line_total_usd else round(item.line_total_usd/item.qty*(incoming.value ->> 'qty')::numeric,2) end
      and item.unit_price_bs_snapshot = (incoming.value ->> 'unit_price_bs_snapshot')::numeric
      and (incoming.value ->> 'line_total_bs_snapshot')::numeric = case when item.qty=(incoming.value ->> 'qty')::numeric then item.line_total_bs_snapshot else round(item.unit_price_bs_snapshot*(incoming.value ->> 'qty')::numeric,2) end
      and item.admin_price_override_usd = (incoming.value ->> 'admin_price_override_usd')::numeric
      and btrim(coalesce(item.admin_price_override_reason, '')) =
        btrim(coalesce(incoming.value ->> 'admin_price_override_reason', ''))
      and item.override_unit_price_usd is not distinct from
        nullif(incoming.value ->> 'override_unit_price_usd', '')::numeric
      and item.crm_play_benefit_id is not distinct from
        nullif(incoming.value ->> 'crm_play_benefit_id', '')::bigint
      and item.crm_play_benefit_upgrade_id is not distinct from
        nullif(incoming.value ->> 'crm_play_benefit_upgrade_id', '')::bigint
      and nullif(incoming.value ->> 'crm_play_member_id', '') is null
      and (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
        from pg_catalog.regexp_split_to_table(coalesce(item.notes, ''), E'\r?\n') line
        where btrim(line) <> '')
        = (select coalesce(pg_catalog.array_agg(btrim(line) order by btrim(line)), array[]::text[])
        from pg_catalog.regexp_split_to_table(coalesce(incoming.value ->> 'notes', ''), E'\r?\n') line
        where btrim(line) <> '');
  end if;

  if not v_is_admin and (
    exists (
      select 1 from pg_catalog.jsonb_array_elements(p_items) incoming(value)
      where nullif(incoming.value ->> 'admin_price_override_usd', '') is not null
        and not coalesce(nullif(incoming.value ->> 'order_item_id', '')::bigint = any(v_preserved_approved_ids), false)
    ) or exists (
      select 1 from public.order_items item
      where item.order_id = p_order_id and item.admin_price_override_usd is not null
        and not (item.id = any(v_preserved_approved_ids)) and (not v_is_master or exists (select 1 from jsonb_array_elements(p_items) submitted(value) where nullif(submitted.value ->> 'order_item_id','')::bigint=item.id))
    )
  ) then
    raise exception 'Solo Administración puede cambiar una línea con precio especial. Conserva sus productos, cantidades y precios autorizados.'
      using errcode = '42501';
  end if;

  -- Reuse the existing retention path: no delete/insert, no approval restamping,
  -- no inventory replay and no loss of linked administrative evidence.
  v_preserved_legacy_ids := v_preserved_legacy_ids || v_preserved_approved_ids;


  -- Operational retained rows: preserve the unit snapshots and item identity.
  if v_is_master and not v_is_admin then
    v_preserved_legacy_ids := v_preserved_legacy_ids || array(
      select item.id from public.order_items item
      join jsonb_array_elements(p_items) incoming(value)
        on nullif(incoming.value->>'order_item_id','')::bigint=item.id
      where item.order_id=p_order_id and item.admin_price_override_usd is null
        and item.crm_play_member_id is null
        and app_private.order_item_operational_quantity_v1(to_jsonb(item),
          to_jsonb(jsonb_populate_record(item,incoming.value-array['order_item_id','admin_price_override_by_user_id','admin_price_override_at']))));
  end if;
  -- All other ordinary rows follow the original atomic rebuild and CRM guard.
  delete from public.order_items item
  where item.order_id = p_order_id
    and item.crm_play_member_id is null
    and not (item.id = any(v_preserved_legacy_ids));

  for v_item in
    select value
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as incoming(value, position)
    order by position
  loop
    begin
      if coalesce((v_item ->> 'product_id')::bigint, 0) <= 0
        or coalesce((v_item ->> 'qty')::numeric, 0) <= 0
        or coalesce(v_item ->> 'pricing_origin_currency', '') not in ('USD', 'VES')
        or coalesce((v_item ->> 'pricing_origin_amount')::numeric, -1) < 0
        or coalesce((v_item ->> 'unit_price_usd_snapshot')::numeric, -1) < 0
        or coalesce((v_item ->> 'unit_price_bs_snapshot')::numeric, -1) < 0
      then
        raise exception 'Cada ítem debe tener producto, cantidad y precios válidos.' using errcode = '22023';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Uno de los ítems contiene datos inválidos.' using errcode = '22023';
    end;

    if nullif(v_item ->> 'order_item_id', '')::bigint = any(v_preserved_legacy_ids) then
      update public.order_items item set qty=(v_item->>'qty')::numeric,
        line_total_usd=(v_item->>'line_total_usd')::numeric,
        line_total_bs_snapshot=(v_item->>'line_total_bs_snapshot')::numeric,
        notes=nullif(btrim(v_item->>'notes'),'')
      where item.id=(v_item->>'order_item_id')::bigint and item.crm_play_member_id is null
        and (item.qty is distinct from (v_item->>'qty')::numeric
          or item.notes is distinct from nullif(btrim(v_item->>'notes'),''));

      v_item_ids := v_item_ids || pg_catalog.jsonb_build_array((v_item ->> 'order_item_id')::bigint);
      continue;
    end if;

    v_existing := null;
    if nullif(v_item ->> 'order_item_id', '') is not null then
      select item.*
      into v_existing
      from public.order_items item
      where item.id = (v_item ->> 'order_item_id')::bigint
        and item.order_id = p_order_id
        and item.crm_play_member_id is not null;
    end if;

    if v_existing.id is not null then
      if v_existing.product_id is distinct from (v_item ->> 'product_id')::bigint
        or pg_catalog.abs(v_existing.qty - (v_item ->> 'qty')::numeric) > 0.001
        or (
          nullif(v_item ->> 'crm_play_member_id', '') is not null
          and v_existing.crm_play_member_id is distinct from (v_item ->> 'crm_play_member_id')::bigint
        )
        or (
          nullif(v_item ->> 'crm_play_benefit_id', '') is not null
          and v_existing.crm_play_benefit_id is distinct from (v_item ->> 'crm_play_benefit_id')::bigint
        )
        or (
          nullif(v_item ->> 'crm_play_benefit_upgrade_id', '') is not null
          and v_existing.crm_play_benefit_upgrade_id is distinct from (v_item ->> 'crm_play_benefit_upgrade_id')::bigint
        )
      then
        raise exception 'El beneficio ya aplicado conserva su producto, cantidad y ampliación.'
          using errcode = '55000';
      end if;

      update public.order_items item
      set notes = nullif(pg_catalog.btrim(v_item ->> 'notes'), '')
      where item.id = v_existing.id;
      v_new_item_id := v_existing.id;
    else
      insert into public.order_items (
        order_id,
        product_id,
        qty,
        pricing_origin_currency,
        pricing_origin_amount,
        pricing_fx_rate_snapshot,
        unit_price_usd_snapshot,
        line_total_usd,
        unit_price_bs_snapshot,
        line_total_bs_snapshot,
        admin_price_override_usd,
        admin_price_override_reason,
        admin_price_override_by_user_id,
        admin_price_override_at,
        sku_snapshot,
        product_name_snapshot,
        notes,
        crm_play_member_id,
        crm_play_benefit_id,
        crm_play_benefit_upgrade_id
      ) values (
        p_order_id,
        (v_item ->> 'product_id')::bigint,
        (v_item ->> 'qty')::numeric,
        v_item ->> 'pricing_origin_currency',
        (v_item ->> 'pricing_origin_amount')::numeric,
        nullif(v_extra #>> '{pricing,fx_rate}', '')::numeric,
        (v_item ->> 'unit_price_usd_snapshot')::numeric,
        coalesce((v_item ->> 'line_total_usd')::numeric, 0),
        (v_item ->> 'unit_price_bs_snapshot')::numeric,
        coalesce((v_item ->> 'line_total_bs_snapshot')::numeric, 0),
        nullif(v_item ->> 'admin_price_override_usd', '')::numeric,
        nullif(pg_catalog.btrim(v_item ->> 'admin_price_override_reason'), ''),
        case when nullif(v_item ->> 'admin_price_override_usd', '') is null then null else v_uid end,
        case when nullif(v_item ->> 'admin_price_override_usd', '') is null then null else v_now end,
        nullif(v_item ->> 'sku_snapshot', ''),
        coalesce(nullif(pg_catalog.btrim(v_item ->> 'product_name_snapshot'), ''), 'Ítem'),
        nullif(pg_catalog.btrim(v_item ->> 'notes'), ''),
        nullif(v_item ->> 'crm_play_member_id', '')::bigint,
        nullif(v_item ->> 'crm_play_benefit_id', '')::bigint,
        nullif(v_item ->> 'crm_play_benefit_upgrade_id', '')::bigint
      ) returning id into v_new_item_id;
    end if;

    v_item_ids := v_item_ids || pg_catalog.jsonb_build_array(v_new_item_id);
  end loop;

  select
    count(*)::integer,
    pg_catalog.round(coalesce(sum(item.line_total_usd), 0), 2),
    pg_catalog.round(coalesce(sum(item.line_total_bs_snapshot), 0), 2)
  into v_item_count, v_subtotal_usd, v_subtotal_bs
  from public.order_items item
  where item.order_id = p_order_id;

  if v_item_count <> pg_catalog.jsonb_array_length(p_items) then
    raise exception 'No se guardó la cantidad esperada de productos; la modificación fue revertida.'
      using errcode = 'P0001';
  end if;

  v_pricing := case when pg_catalog.jsonb_typeof(v_extra -> 'pricing') = 'object'
    then v_extra -> 'pricing' else '{}'::jsonb end;
  v_discount_enabled := coalesce((v_pricing ->> 'discount_enabled')::boolean, false);
  v_discount_pct := case when v_discount_enabled
    then greatest(0, least(100, coalesce((v_pricing ->> 'discount_pct')::numeric, 0)))
    else 0 end;
  v_tax_pct := greatest(0, coalesce((v_pricing ->> 'invoice_tax_pct')::numeric, 0));
  v_discount_usd := pg_catalog.round(v_subtotal_usd * v_discount_pct / 100, 2);
  v_discount_bs := pg_catalog.round(v_subtotal_bs * v_discount_pct / 100, 2);
  v_after_discount_usd := pg_catalog.round(v_subtotal_usd - v_discount_usd, 2);
  v_after_discount_bs := pg_catalog.round(v_subtotal_bs - v_discount_bs, 2);
  v_tax_usd := pg_catalog.round(v_after_discount_usd * v_tax_pct / 100, 2);
  v_tax_bs := pg_catalog.round(v_after_discount_bs * v_tax_pct / 100, 2);
  v_total_usd := pg_catalog.round(v_after_discount_usd + v_tax_usd, 2);
  v_total_bs := pg_catalog.round(v_after_discount_bs + v_tax_bs, 2);

  v_pricing := v_pricing || pg_catalog.jsonb_build_object(
    'subtotal_usd', v_subtotal_usd,
    'subtotal_bs', v_subtotal_bs,
    'discount_enabled', v_discount_enabled,
    'discount_pct', v_discount_pct,
    'discount_amount_usd', v_discount_usd,
    'discount_amount_bs', v_discount_bs,
    'subtotal_after_discount_usd', v_after_discount_usd,
    'subtotal_after_discount_bs', v_after_discount_bs,
    'invoice_tax_pct', v_tax_pct,
    'invoice_tax_amount_usd', v_tax_usd,
    'invoice_tax_amount_bs', v_tax_bs,
    'total_usd', v_total_usd,
    'total_bs', v_total_bs
  );
  v_extra := pg_catalog.jsonb_set(v_extra, '{pricing}', v_pricing, true);

  v_previous_fund := pg_catalog.round(coalesce(
    nullif(v_order.extra_fields #>> '{payment,client_fund_used_usd}', '')::numeric,
    0
  ), 2);
  v_next_fund := pg_catalog.round(coalesce(
    nullif(v_extra #>> '{payment,client_fund_used_usd}', '')::numeric,
    0
  ), 2);
  if v_previous_fund < 0 or v_next_fund < 0 or v_next_fund > v_total_usd then
    raise exception 'El uso del fondo del cliente no es válido.' using errcode = '22023';
  end if;

  perform client.id
  from public.clients client
  where client.id in (v_order.client_id, v_new_client_id)
  order by client.id
  for update;

  if v_previous_fund > 0 then
    update public.clients client
    set fund_balance_usd = pg_catalog.round(coalesce(client.fund_balance_usd, 0) + v_previous_fund, 2)
    where client.id = v_order.client_id;

    insert into public.client_fund_movements (
      client_id, movement_type, currency_code, amount, amount_usd, money_account_id,
      order_id, payment_report_id, reason_code, notes, created_by_user_id
    ) values (
      v_order.client_id, 'credit', 'USD', v_previous_fund, v_previous_fund, null,
      p_order_id, null, 'order_fund_restore', 'Restitución de fondo por edición de orden', v_uid
    );
  end if;

  if v_next_fund > 0 then
    select pg_catalog.round(coalesce(client.fund_balance_usd, 0), 2)
    into v_available_fund
    from public.clients client
    where client.id = v_new_client_id;

    if v_available_fund + 0.0001 < v_next_fund then
      raise exception 'El cliente no tiene suficiente fondo disponible.' using errcode = '22023';
    end if;

    update public.clients client
    set fund_balance_usd = pg_catalog.round(coalesce(client.fund_balance_usd, 0) - v_next_fund, 2)
    where client.id = v_new_client_id;

    insert into public.client_fund_movements (
      client_id, movement_type, currency_code, amount, amount_usd, money_account_id,
      order_id, payment_report_id, reason_code, notes, created_by_user_id
    ) values (
      v_new_client_id, 'debit', 'USD', v_next_fund, v_next_fund, null,
      p_order_id, null, 'order_fund_applied', 'Fondo aplicado por edición de orden', v_uid
    );
  end if;

  update public.orders order_row
  set
    client_id = v_new_client_id,
    attributed_advisor_id = v_new_advisor_id,
    source = v_new_source::public.order_source,
    status = v_new_status::public.order_status,
    fulfillment = v_new_fulfillment::public.fulfillment_type,
    total_usd = v_total_usd,
    total_bs_snapshot = v_total_bs,
    is_price_locked = coalesce((p_order_patch ->> 'is_price_locked')::boolean, order_row.is_price_locked),
    delivery_address = case when v_new_fulfillment = 'delivery'
      then nullif(pg_catalog.btrim(p_order_patch ->> 'delivery_address'), '') else null end,
    receiver_name = nullif(pg_catalog.btrim(p_order_patch ->> 'receiver_name'), ''),
    receiver_phone = nullif(pg_catalog.btrim(p_order_patch ->> 'receiver_phone'), ''),
    notes = nullif(pg_catalog.btrim(p_order_patch ->> 'notes'), ''),
    extra_fields = v_extra,
    queued_needs_reapproval = case when p_order_patch ? 'queued_needs_reapproval'
      then coalesce((p_order_patch ->> 'queued_needs_reapproval')::boolean, false)
      else order_row.queued_needs_reapproval end,
    queued_last_modified_at = case when p_order_patch ? 'queued_last_modified_at'
      then nullif(p_order_patch ->> 'queued_last_modified_at', '')::timestamptz
      else order_row.queued_last_modified_at end,
    queued_last_modified_by = case when p_order_patch ? 'queued_last_modified_by'
      then nullif(p_order_patch ->> 'queued_last_modified_by', '')::uuid
      else order_row.queued_last_modified_by end,
    last_modified_at = v_now,
    last_modified_by = v_uid
  where order_row.id = p_order_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'item_ids', v_item_ids,
    'item_count', v_item_count,
    'subtotal_usd', v_subtotal_usd,
    'subtotal_bs', v_subtotal_bs,
    'total_usd', v_total_usd,
    'total_bs', v_total_bs,
    'last_modified_at', v_now
  );
end;
$function$;
