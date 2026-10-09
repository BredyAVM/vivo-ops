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

CREATE OR REPLACE FUNCTION public.advisor_create_order_atomic_v1(p_request_id uuid, p_client_id bigint, p_fulfillment fulfillment_type, p_total_usd numeric, p_total_bs_snapshot numeric, p_delivery_address text, p_receiver_name text, p_receiver_phone text, p_notes text, p_extra_fields jsonb, p_items jsonb, p_draft_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_request_hash text;
  v_existing public.orders%rowtype;
  v_draft public.advisor_order_drafts%rowtype;
  v_order_id bigint;
  v_order_number text;
  v_order_created_at timestamptz;
  v_order_total_usd numeric;
  v_order_total_bs numeric;
  v_inserted_items integer := 0;
  v_attempt integer;
  v_schedule jsonb;
begin
  if v_uid is null or not public.has_role('advisor') then
    raise exception 'Solo un asesor autenticado puede crear esta orden.'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'No se pudo identificar este intento de creación.'
      using errcode = '22023';
  end if;

  if p_client_id is null or p_client_id <= 0 or not exists (
    select 1 from public.clients client where client.id = p_client_id
  ) then
    raise exception 'Selecciona un cliente válido antes de crear la orden.'
      using errcode = '22023';
  end if;

  if p_total_usd is null or p_total_usd < 0
     or p_total_bs_snapshot is null or p_total_bs_snapshot < 0 then
    raise exception 'Los totales de la orden no son válidos.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_extra_fields) is distinct from 'object' then
    raise exception 'La información adicional de la orden no es válida.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 200
     or exists (
       select 1
       from jsonb_array_elements(p_items) item
       where jsonb_typeof(item) is distinct from 'object'
     ) then
    raise exception 'Debes agregar entre 1 y 200 productos válidos.'
      using errcode = '22023';
  end if;

  v_request_hash := md5(jsonb_build_object(
    'client_id', p_client_id,
    'fulfillment', p_fulfillment::text,
    'total_usd', round(p_total_usd, 2),
    'total_bs_snapshot', round(p_total_bs_snapshot, 2),
    'delivery_address', nullif(btrim(coalesce(p_delivery_address, '')), ''),
    'receiver_name', nullif(btrim(coalesce(p_receiver_name, '')), ''),
    'receiver_phone', nullif(btrim(coalesce(p_receiver_phone, '')), ''),
    'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'extra_fields', p_extra_fields,
    'items', p_items,
    'draft_id', p_draft_id
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended('advisor-order-create:' || v_uid::text || ':' || p_request_id::text, 0)
  );

  select order_row.*
  into v_existing
  from public.orders order_row
  where order_row.created_by_user_id = v_uid
    and order_row.advisor_creation_idempotency_key = p_request_id;

  if found then
    if v_existing.advisor_creation_request_hash is distinct from v_request_hash then
      raise exception 'Este intento ya creó una orden con información diferente. Abre la orden creada antes de volver a intentarlo.'
        using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.order_items item where item.order_id = v_existing.id
    ) then
      raise exception 'La solicitud anterior quedó incompleta y requiere revisión de Master.'
        using errcode = '23514';
    end if;

    return jsonb_build_object(
      'orderId', v_existing.id,
      'orderNumber', v_existing.order_number,
      'totalUsd', v_existing.total_usd,
      'totalBs', v_existing.total_bs_snapshot,
      'replayed', true
    );
  end if;

  if p_draft_id is not null then
    select draft.*
    into v_draft
    from public.advisor_order_drafts draft
    where draft.id = p_draft_id
      and draft.advisor_user_id = v_uid
    for update;

    if not found then
      raise exception 'No se encontró el borrador que estás convirtiendo.'
        using errcode = '22023';
    end if;

    if v_draft.status = 'converted' and v_draft.converted_order_id is not null then
      select order_row.*
      into v_existing
      from public.orders order_row
      where order_row.id = v_draft.converted_order_id
        and order_row.attributed_advisor_id = v_uid;

      if found and exists (
        select 1 from public.order_items item where item.order_id = v_existing.id
      ) then
        return jsonb_build_object(
          'orderId', v_existing.id,
          'orderNumber', v_existing.order_number,
          'totalUsd', v_existing.total_usd,
          'totalBs', v_existing.total_bs_snapshot,
          'replayed', true,
          'duplicateSource', 'converted_draft'
        );
      end if;
    end if;

    if v_draft.status not in ('draft', 'quoted') then
      raise exception 'Este borrador ya fue cerrado y no puede crear otra orden.'
        using errcode = '22023';
    end if;

    if coalesce(v_draft.payload #>> '{event_budget,kind}', '') = 'admin_event_budget' then
      raise exception 'Solo Administración puede convertir un presupuesto de evento.'
        using errcode = '42501';
    end if;
  end if;

  for v_attempt in 1..25 loop
    v_order_number := format(
      'VO-%s-%s',
      to_char(timezone('America/Caracas', statement_timestamp()), 'YYYYMMDD'),
      lpad(floor(random() * 10000)::integer::text, 4, '0')
    );

    begin
      insert into public.orders (
        order_number,
        client_id,
        created_by_user_id,
        source,
        attributed_advisor_id,
        fulfillment,
        delivery_address,
        receiver_name,
        receiver_phone,
        status,
        total_usd,
        total_bs_snapshot,
        notes,
        extra_fields,
        is_price_locked,
        advisor_creation_idempotency_key,
        advisor_creation_request_hash
      ) values (
        v_order_number,
        p_client_id,
        v_uid,
        'advisor',
        v_uid,
        p_fulfillment,
        case when p_fulfillment = 'delivery' then nullif(btrim(coalesce(p_delivery_address, '')), '') else null end,
        nullif(btrim(coalesce(p_receiver_name, '')), ''),
        nullif(btrim(coalesce(p_receiver_phone, '')), ''),
        'created',
        round(p_total_usd, 2),
        round(p_total_bs_snapshot, 2),
        nullif(btrim(coalesce(p_notes, '')), ''),
        p_extra_fields,
        false,
        p_request_id,
        v_request_hash
      )
      returning id, created_at
      into v_order_id, v_order_created_at;

      exit;
    exception
      when unique_violation then
        v_order_id := null;
        if v_attempt = 25 then
          raise exception 'No se pudo generar un número único para la orden. Intenta nuevamente.'
            using errcode = '23505';
        end if;
    end;
  end loop;

  insert into public.order_items (
    order_id,
    product_id,
    qty,
    pricing_origin_currency,
    pricing_origin_amount,
    unit_price_usd_snapshot,
    line_total_usd,
    unit_price_bs_snapshot,
    line_total_bs_snapshot,
    sku_snapshot,
    product_name_snapshot,
    notes,
    crm_play_member_id,
    crm_play_benefit_id,
    crm_play_benefit_upgrade_id
  )
  select
    v_order_id,
    input.product_id,
    input.qty,
    input.pricing_origin_currency,
    input.pricing_origin_amount,
    input.unit_price_usd_snapshot,
    input.line_total_usd,
    input.unit_price_bs_snapshot,
    input.line_total_bs_snapshot,
    nullif(btrim(coalesce(input.sku_snapshot, '')), ''),
    nullif(btrim(coalesce(input.product_name_snapshot, '')), ''),
    nullif(input.notes, ''),
    input.crm_play_member_id,
    input.crm_play_benefit_id,
    input.crm_play_benefit_upgrade_id
  from jsonb_to_recordset(p_items) as input(
    product_id bigint,
    qty numeric,
    pricing_origin_currency text,
    pricing_origin_amount numeric,
    unit_price_usd_snapshot numeric,
    line_total_usd numeric,
    unit_price_bs_snapshot numeric,
    line_total_bs_snapshot numeric,
    sku_snapshot text,
    product_name_snapshot text,
    notes text,
    crm_play_member_id bigint,
    crm_play_benefit_id bigint,
    crm_play_benefit_upgrade_id bigint
  );

  get diagnostics v_inserted_items = row_count;
  if v_inserted_items <> jsonb_array_length(p_items) then
    raise exception 'No se pudieron guardar todos los productos de la orden.'
      using errcode = '23514';
  end if;

  v_schedule := case
    when jsonb_typeof(p_extra_fields -> 'schedule') = 'object'
      then p_extra_fields -> 'schedule'
    else '{}'::jsonb
  end;

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload,
    created_at
  ) values (
    v_order_id,
    v_order_number,
    'order_created',
    'approval',
    'Orden creada',
    'La orden fue creada y quedó pendiente de aprobación.',
    'warning',
    v_uid,
    jsonb_build_object(
      'fulfillment', p_fulfillment,
      'source', 'advisor',
      'urgent', coalesce((v_schedule ->> 'asap')::boolean, false),
      'delivery_time', nullif(
        btrim(concat_ws(' ', v_schedule ->> 'date', v_schedule ->> 'time_24')),
        ''
      ),
      'advisor_creation_idempotency_key', p_request_id
    ),
    v_order_created_at
  );

  if p_draft_id is not null then
    update public.advisor_order_drafts
    set
      status = 'converted',
      converted_order_id = v_order_id,
      converted_at = statement_timestamp()
    where id = p_draft_id
      and advisor_user_id = v_uid;

    if not found then
      raise exception 'No se pudo cerrar el borrador convertido.'
        using errcode = '23514';
    end if;
  end if;

  select order_row.total_usd, order_row.total_bs_snapshot
  into v_order_total_usd, v_order_total_bs
  from public.orders order_row
  where order_row.id = v_order_id;

  return jsonb_build_object(
    'orderId', v_order_id,
    'orderNumber', v_order_number,
    'totalUsd', v_order_total_usd,
    'totalBs', v_order_total_bs,
    'replayed', false
  );
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

