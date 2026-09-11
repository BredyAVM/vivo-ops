set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

-- One transactional authority for the order header, customer fund and item set.
-- Existing CRM redemption rows keep their immutable order_item identity.
create or replace function app_private.update_order_core_atomic_v1(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_order_patch jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  -- Ordinary rows are rebuilt inside this transaction. If any later validation
  -- fails, PostgreSQL rolls the complete header and item set back together.
  delete from public.order_items item
  where item.order_id = p_order_id
    and item.crm_play_member_id is null;

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
$$;

create or replace function public.update_order_core_atomic_v1(
  p_order_id bigint,
  p_expected_last_modified_at timestamptz,
  p_order_patch jsonb,
  p_items jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app_private.update_order_core_atomic_v1(
    p_order_id,
    p_expected_last_modified_at,
    p_order_patch,
    p_items
  )
$$;

revoke all on function app_private.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb)
  to authenticated;

revoke all on function public.advisor_replace_order_items_v2(bigint, jsonb, numeric)
  from public, anon, authenticated, service_role;

comment on function public.update_order_core_atomic_v1(bigint, timestamptz, jsonb, jsonb) is
  'Atomically saves an editable order header, fund usage and complete item set while preserving redeemed CRM item identity.';

-- Repair order 2542 from the explicitly confirmed commercial content:
-- one Bs 11,000 mixed service, one Bs 1,100 malt and one Bs 1,100 Pepsi can,
-- while preserving the
-- already redeemed CRM benefit as immutable audit evidence.
do $$
declare
  v_order_id bigint;
  v_ordinary_count integer;
  v_redeemed_count integer;
  v_catalog_count integer;
  v_fx_rate numeric;
  v_mix_notes text;
  v_removed_ids bigint[];
  v_kept_ids bigint[];
  v_total_usd numeric;
  v_total_bs numeric;
begin
  select order_row.id
  into v_order_id
  from public.orders order_row
  where order_row.order_number = 'VO-20260911-9281'
  for update;

  if v_order_id is null then
    return;
  end if;

  select count(*)::integer
  into v_ordinary_count
  from public.order_items item
  where item.order_id = v_order_id
    and item.crm_play_member_id is null;

  select count(*)::integer
  into v_redeemed_count
  from public.crm_play_redemptions redemption
  where redemption.order_id = v_order_id
    and redemption.status = 'redeemed';

  select count(*)::integer
  into v_catalog_count
  from public.products product
  where product.sku in ('MIX_MTEQ_EMP_F_22', 'MALTA_LAT', 'PEPSI_LAT')
    and product.is_active;

  select nullif(item.notes, '')
  into v_mix_notes
  from public.order_items item
  join public.products product on product.id = item.product_id
  where item.order_id = v_order_id
    and item.crm_play_member_id is null
    and product.sku = 'MIX_MTEQ_EMP_F_22'
  order by item.created_at, item.id
  limit 1;

  v_fx_rate := nullif((select order_row.extra_fields #>> '{pricing,fx_rate}'
    from public.orders order_row where order_row.id = v_order_id), '')::numeric;

  if v_ordinary_count <> 6 or v_redeemed_count <> 1 or v_catalog_count <> 3
    or v_fx_rate is null or v_fx_rate <= 0
    or coalesce((select order_row.extra_fields #>> '{pricing,discount_pct}'
      from public.orders order_row where order_row.id = v_order_id), '0')::numeric <> 0
    or coalesce((select order_row.extra_fields #>> '{pricing,invoice_tax_pct}'
      from public.orders order_row where order_row.id = v_order_id), '0')::numeric <> 0
  then
    return;
  end if;

  with removed as (
    delete from public.order_items item
    where item.order_id = v_order_id
      and item.crm_play_member_id is null
    returning item.id
  )
  select pg_catalog.array_agg(removed.id order by removed.id)
  into v_removed_ids
  from removed;

  if coalesce(pg_catalog.array_length(v_removed_ids, 1), 0) <> 6 then
    raise exception 'La reparación de la orden 2542 encontró una forma de datos distinta a la auditada.';
  end if;

  insert into public.order_items (
    order_id, product_id, qty, pricing_origin_currency, pricing_origin_amount,
    unit_price_usd_snapshot, line_total_usd, unit_price_bs_snapshot,
    line_total_bs_snapshot, sku_snapshot, product_name_snapshot, notes
  )
  select
    v_order_id,
    product.id,
    1,
    product.source_price_currency::text,
    product.source_price_amount,
    product.base_price_usd,
    product.base_price_usd,
    case when product.source_price_currency::text = 'VES'
      then product.source_price_amount else pg_catalog.round(product.base_price_usd * v_fx_rate, 2) end,
    case when product.source_price_currency::text = 'VES'
      then product.source_price_amount else pg_catalog.round(product.base_price_usd * v_fx_rate, 2) end,
    product.sku,
    product.name,
    case when product.sku = 'MIX_MTEQ_EMP_F_22' then v_mix_notes else null end
  from public.products product
  where product.sku in ('MIX_MTEQ_EMP_F_22', 'MALTA_LAT', 'PEPSI_LAT')
    and product.is_active
  order by case product.sku
    when 'MIX_MTEQ_EMP_F_22' then 1
    when 'MALTA_LAT' then 2
    else 3
  end;

  select
    pg_catalog.round(coalesce(pg_catalog.sum(item.line_total_usd), 0), 2),
    pg_catalog.round(coalesce(pg_catalog.sum(item.line_total_bs_snapshot), 0), 2)
  into v_total_usd, v_total_bs
  from public.order_items item
  where item.order_id = v_order_id;

  update public.orders order_row
  set total_usd = v_total_usd,
      total_bs_snapshot = v_total_bs,
      extra_fields = pg_catalog.jsonb_set(
        coalesce(order_row.extra_fields, '{}'::jsonb),
        '{pricing}',
        coalesce(order_row.extra_fields -> 'pricing', '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'subtotal_usd', v_total_usd,
            'subtotal_bs', v_total_bs,
            'subtotal_after_discount_usd', v_total_usd,
            'subtotal_after_discount_bs', v_total_bs,
            'discount_amount_usd', 0,
            'discount_amount_bs', 0,
            'invoice_tax_amount_usd', 0,
            'invoice_tax_amount_bs', 0,
            'total_usd', v_total_usd,
            'total_bs', v_total_bs
          ),
        true
      ),
      last_modified_at = pg_catalog.clock_timestamp()
  where order_row.id = v_order_id;

  select pg_catalog.array_agg(item.id order by item.id)
  into v_kept_ids
  from public.order_items item
  where item.order_id = v_order_id;

  insert into public.order_events (
    order_id, order_number, event_type, event_group, title, message, severity, payload
  )
  select
    order_row.id,
    order_row.order_number,
    'system_correction',
    'order_items',
    'Guardados parciales retirados',
    'Se reconstruyeron las tres líneas comerciales confirmadas y se conservó el beneficio CRM aplicado.',
    'info',
    pg_catalog.jsonb_build_object(
      'migration', 'order_edit_atomic_core_v1',
      'removed_item_ids', pg_catalog.to_jsonb(v_removed_ids),
      'kept_item_ids', pg_catalog.to_jsonb(v_kept_ids),
      'repair', 'restored_confirmed_mix_malt_and_pepsi_order'
    )
  from public.orders order_row
  where order_row.id = v_order_id;
end;
$$;

commit;
