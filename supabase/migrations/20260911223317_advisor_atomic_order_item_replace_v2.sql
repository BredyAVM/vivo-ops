set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

-- Replace an advisor order's items in one database transaction. CRM benefit rows
-- are updated in place because their redemption identity is intentionally immutable.
create or replace function public.advisor_replace_order_items_v2(
  p_order_id bigint,
  p_items jsonb,
  p_expected_total_usd numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_item jsonb;
  v_item_id bigint;
  v_product_id bigint;
  v_qty numeric;
  v_member_id bigint;
  v_benefit_id bigint;
  v_upgrade_id bigint;
  v_existing public.order_items%rowtype;
  v_item_count integer := 0;
  v_total_usd numeric := 0;
begin
  if v_caller_id is null then
    raise exception 'Debes iniciar sesión para modificar la orden.' using errcode = '42501';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'La orden no es válida.' using errcode = '22023';
  end if;

  if p_items is null
    or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) < 1
    or pg_catalog.jsonb_array_length(p_items) > 200
  then
    raise exception 'La orden debe contener entre 1 y 200 ítems.' using errcode = '22023';
  end if;

  select order_row.*
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'No se encontró la orden.' using errcode = 'P0002';
  end if;

  if v_order.attributed_advisor_id is distinct from v_caller_id then
    raise exception 'No puedes modificar esta orden.' using errcode = '42501';
  end if;

  if v_order.status not in ('created'::public.order_status, 'queued'::public.order_status) then
    raise exception 'La orden ya entró a cocina y no puede modificarse.' using errcode = '55000';
  end if;

  if coalesce(v_order.is_price_locked, false) then
    raise exception 'La orden tiene el precio protegido y requiere revisión de Máster.' using errcode = '55000';
  end if;

  -- Validate the complete payload before mutating any row.
  for v_item in select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    begin
      v_item_id := nullif(v_item ->> 'order_item_id', '')::bigint;
      v_product_id := nullif(v_item ->> 'product_id', '')::bigint;
      v_qty := nullif(v_item ->> 'qty', '')::numeric;
      v_member_id := nullif(v_item ->> 'crm_play_member_id', '')::bigint;
      v_benefit_id := nullif(v_item ->> 'crm_play_benefit_id', '')::bigint;
      v_upgrade_id := nullif(v_item ->> 'crm_play_benefit_upgrade_id', '')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Uno de los ítems contiene datos inválidos.' using errcode = '22023';
    end;

    if v_product_id is null or v_product_id <= 0 or v_qty is null or v_qty <= 0 then
      raise exception 'Cada ítem debe tener un producto y una cantidad válidos.' using errcode = '22023';
    end if;

    if coalesce(v_item ->> 'source_price_currency', '') not in ('USD', 'VES')
      or coalesce((v_item ->> 'source_price_amount')::numeric, -1) < 0
      or coalesce((v_item ->> 'unit_price_usd_snapshot')::numeric, -1) < 0
      or coalesce((v_item ->> 'line_total_usd')::numeric, -1) < 0
      or coalesce((v_item ->> 'unit_price_bs_snapshot')::numeric, -1) < 0
      or coalesce((v_item ->> 'line_total_bs_snapshot')::numeric, -1) < 0
    then
      raise exception 'Uno de los ítems contiene precios inválidos.' using errcode = '22023';
    end if;

    if (v_member_id is null) <> (v_benefit_id is null) then
      raise exception 'La vinculación de la jugada está incompleta.' using errcode = '22023';
    end if;

    if v_member_id is not null and v_item_id is null then
      raise exception 'No se puede agregar un beneficio nuevo durante una corrección.' using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_items) as item(
      order_item_id bigint,
      crm_play_member_id bigint,
      crm_play_benefit_id bigint
    )
    where item.crm_play_member_id is not null
    group by item.order_item_id, item.crm_play_member_id, item.crm_play_benefit_id
    having count(*) > 1
  ) then
    raise exception 'El mismo beneficio aparece repetido en la corrección.' using errcode = '23505';
  end if;

  -- Every protected benefit already present must remain present exactly once.
  if exists (
    select 1
    from public.order_items existing
    where existing.order_id = p_order_id
      and existing.crm_play_member_id is not null
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(p_items) as incoming(
          order_item_id bigint,
          crm_play_member_id bigint,
          crm_play_benefit_id bigint,
          crm_play_benefit_upgrade_id bigint
        )
        where incoming.order_item_id = existing.id
          and incoming.crm_play_member_id = existing.crm_play_member_id
          and incoming.crm_play_benefit_id = existing.crm_play_benefit_id
          and incoming.crm_play_benefit_upgrade_id is not distinct from existing.crm_play_benefit_upgrade_id
      )
  ) then
    raise exception 'Un beneficio ya aplicado no puede quitarse de la orden.' using errcode = '55000';
  end if;

  -- Update CRM-bound rows in place. Their identity and redemption never move.
  for v_item in
    select value
    from pg_catalog.jsonb_array_elements(p_items)
    where nullif(value ->> 'crm_play_member_id', '') is not null
  loop
    v_item_id := (v_item ->> 'order_item_id')::bigint;
    v_product_id := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::numeric;
    v_member_id := (v_item ->> 'crm_play_member_id')::bigint;
    v_benefit_id := (v_item ->> 'crm_play_benefit_id')::bigint;
    v_upgrade_id := nullif(v_item ->> 'crm_play_benefit_upgrade_id', '')::bigint;

    select item.*
    into v_existing
    from public.order_items item
    join public.crm_play_redemptions redemption
      on redemption.order_item_id = item.id
     and redemption.order_id = item.order_id
     and redemption.play_member_id = item.crm_play_member_id
     and redemption.play_benefit_id = item.crm_play_benefit_id
     and redemption.status = 'redeemed'
    where item.id = v_item_id
      and item.order_id = p_order_id;

    if not found then
      raise exception 'No se encontró el canje protegido de la jugada.' using errcode = 'P0002';
    end if;

    if v_existing.product_id is distinct from v_product_id
      or pg_catalog.abs(v_existing.qty - v_qty) > 0.001
      or v_existing.crm_play_member_id is distinct from v_member_id
      or v_existing.crm_play_benefit_id is distinct from v_benefit_id
      or v_existing.crm_play_benefit_upgrade_id is distinct from v_upgrade_id
    then
      raise exception 'El beneficio ya canjeado no puede cambiar de producto, cantidad ni ampliación.' using errcode = '55000';
    end if;

    update public.order_items item
    set notes = nullif(pg_catalog.btrim(v_item ->> 'notes'), '')
    where item.id = v_item_id;
  end loop;

  -- Ordinary lines can be replaced freely; delete and insert happen inside this
  -- same function, so an error rolls the whole correction back.
  delete from public.order_items item
  where item.order_id = p_order_id
    and item.crm_play_member_id is null;

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
    p_order_id,
    item.product_id,
    item.qty,
    item.source_price_currency,
    item.source_price_amount,
    item.unit_price_usd_snapshot,
    item.line_total_usd,
    item.unit_price_bs_snapshot,
    item.line_total_bs_snapshot,
    item.sku_snapshot,
    coalesce(nullif(pg_catalog.btrim(item.product_name_snapshot), ''), 'Item'),
    nullif(pg_catalog.btrim(item.notes), ''),
    null,
    null,
    null
  from pg_catalog.jsonb_to_recordset(p_items) as item(
    order_item_id bigint,
    product_id bigint,
    qty numeric,
    source_price_currency text,
    source_price_amount numeric,
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
  )
  where item.crm_play_member_id is null;

  select count(*), pg_catalog.round(coalesce(sum(item.line_total_usd), 0), 2)
  into v_item_count, v_total_usd
  from public.order_items item
  where item.order_id = p_order_id;

  if v_item_count <> pg_catalog.jsonb_array_length(p_items) then
    raise exception 'No se guardó la cantidad esperada de ítems; se revirtió la corrección.' using errcode = 'P0001';
  end if;

  if p_expected_total_usd is not null
    and pg_catalog.abs(v_total_usd - pg_catalog.round(p_expected_total_usd, 2)) > 0.02
  then
    raise exception 'Los precios cambiaron durante el guardado; se revirtió la corrección para evitar inconsistencias.'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'item_count', v_item_count,
    'total_usd', v_total_usd
  );
end;
$$;

revoke all on function public.advisor_replace_order_items_v2(bigint, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function public.advisor_replace_order_items_v2(bigint, jsonb, numeric)
  to authenticated;

comment on function public.advisor_replace_order_items_v2(bigint, jsonb, numeric) is
  'Atomically replaces advisor-editable order items while preserving redeemed CRM item identity.';

-- Repair the single order affected by the former multi-request replacement flow.
-- The guard makes this idempotent and refuses to guess if the data shape changed.
do $$
declare
  v_order_id bigint;
  v_redeemed_count integer;
  v_mix_count integer;
  v_malta_count integer;
  v_removed_ids bigint[];
begin
  select order_row.id
  into v_order_id
  from public.orders order_row
  where order_row.order_number = 'VO-20260911-9281';

  if v_order_id is null then
    return;
  end if;

  select count(*)
  into v_redeemed_count
  from public.crm_play_redemptions redemption
  where redemption.order_id = v_order_id
    and redemption.status = 'redeemed';

  select
    count(*) filter (where product.sku = 'MIX_MTEQ_EMP_F_22'),
    count(*) filter (where product.sku = 'MALTA_LAT')
  into v_mix_count, v_malta_count
  from public.order_items item
  join public.products product on product.id = item.product_id
  where item.order_id = v_order_id
    and item.crm_play_member_id is null;

  if v_redeemed_count <> 1 then
    raise exception 'La reparación de la orden 2542 encontró un canje inesperado.';
  end if;

  if v_mix_count = 1 and v_malta_count = 1 then
    return;
  end if;

  if v_mix_count <> 2 or v_malta_count <> 2 then
    raise exception 'La reparación de la orden 2542 encontró líneas distintas a la auditoría.';
  end if;

  with ranked as (
    select
      item.id,
      pg_catalog.row_number() over (
        partition by item.product_id, item.qty, item.unit_price_usd_snapshot,
          item.line_total_usd, coalesce(item.notes, '')
        order by item.id
      ) as duplicate_rank
    from public.order_items item
    join public.products product on product.id = item.product_id
    where item.order_id = v_order_id
      and item.crm_play_member_id is null
      and product.sku in ('MIX_MTEQ_EMP_F_22', 'MALTA_LAT')
  ), deleted as (
    delete from public.order_items item
    using ranked
    where item.id = ranked.id
      and ranked.duplicate_rank > 1
    returning item.id
  )
  select pg_catalog.array_agg(deleted.id order by deleted.id)
  into v_removed_ids
  from deleted;

  if coalesce(pg_catalog.array_length(v_removed_ids, 1), 0) <> 2 then
    raise exception 'La reparación de la orden 2542 no identificó exactamente dos duplicados.';
  end if;

  insert into public.order_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    payload
  )
  select
    order_row.id,
    order_row.order_number,
    'system_correction',
    'order_items',
    'Líneas duplicadas corregidas',
    'Se retiraron dos líneas repetidas creadas por un guardado parcial. El pedido y el beneficio CRM válidos se conservaron.',
    'info',
    pg_catalog.jsonb_build_object(
      'migration', 'advisor_atomic_order_item_replace_v2',
      'removed_item_ids', pg_catalog.to_jsonb(v_removed_ids),
      'repair', 'removed_partial_replace_duplicates'
    )
  from public.orders order_row
  where order_row.id = v_order_id
    and not exists (
      select 1
      from public.order_events existing_event
      where existing_event.order_id = v_order_id
        and existing_event.payload ->> 'migration' = 'advisor_atomic_order_item_replace_v2'
    );
end;
$$;

commit;
