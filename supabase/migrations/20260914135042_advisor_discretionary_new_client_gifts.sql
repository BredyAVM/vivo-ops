-- New-client Dondy gifts are optional advisor tools, not campaign-only benefits.
-- Preserve existing SKUs, inventory mappings and advisor gift commission costs.
-- No historical orders, money movements or stock balances are changed here.
set local lock_timeout = '5s';

update public.products
set extra_fields = coalesce(extra_fields, '{}'::jsonb)
  || '{"catalog_access_scope":"advisor_gift"}'::jsonb
where sku in ('GAMBIT_DONDY_1_CN', 'GAMBIT_DONDYS_3')
  and type::text = 'gambit';

CREATE OR REPLACE FUNCTION app_private.crm_order_item_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  product_row record;
  order_row record;
  member_row record;
  benefit_row record;
  upgrade_row record;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total_usd numeric := 0;
  expected_unit_price_usd numeric := 0;
  is_crm_item boolean;
  is_existing_redemption boolean := false;
begin
  select
    product.id,
    product.type::text as product_type,
    product.extra_fields,
    product.base_price_usd,
    product.source_price_amount,
    product.is_active
  into product_row
  from public.products product
  where product.id = new.product_id;

  if product_row.id is null or not coalesce(product_row.is_active, false) then
    raise exception 'El producto ya no está disponible en el catálogo.' using errcode = '22023';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.source::text as source,
    nullif(order_data.extra_fields #>> '{pricing,fx_rate}', '')::numeric as fx_rate
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null then
    raise exception 'La orden no existe.' using errcode = 'P0002';
  end if;

  is_crm_item := new.crm_play_member_id is not null
    or new.crm_play_benefit_id is not null
    or new.crm_play_benefit_upgrade_id is not null;

  if not is_crm_item then
    if coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') = 'advisor_gift' then
      -- Discretionary client gifts are not CRM redemptions. Catalog metadata is
      -- administration-owned; membership and first-purchase gates do not apply.
      if caller_role <> 'service_role' and (
        caller_id is null
        or not (
          public.is_master_or_admin()
          or (public.has_role('advisor') and caller_id is not distinct from order_row.attributed_advisor_id)
        )
      ) then
        raise exception 'Solo el asesor adjudicado, master o administrador pueden aplicar este obsequio.'
          using errcode = '42501';
      end if;

      if coalesce(product_row.base_price_usd, 0) <> 0
        or coalesce(product_row.source_price_amount, 0) <> 0
        or coalesce(new.admin_price_override_usd, 0) <> 0
        or coalesce(new.override_unit_price_usd, 0) <> 0
      then
        raise exception 'El obsequio debe conservar precio cero; use el producto de venta para cobrarlo.'
          using errcode = '22023';
      end if;
      if coalesce(new.qty, 0) <= 0 then
        raise exception 'La cantidad del obsequio debe ser mayor que cero.' using errcode = '22023';
      end if;

      new.pricing_origin_currency := 'USD';
      new.pricing_origin_amount := 0;
      new.unit_price_usd_snapshot := 0;
      new.line_total_usd := 0;
      new.unit_price_bs_snapshot := 0;
      new.line_total_bs_snapshot := 0;
    elsif order_row.source = 'advisor'
      and (
        product_row.product_type = 'gambit'
        or coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') = 'crm_only'
      )
    then
      raise exception 'Este beneficio solo puede cargarse desde una jugada activa del cliente.'
        using errcode = '42501';
    end if;
  else
    if new.crm_play_member_id is null or new.crm_play_benefit_id is null then
      raise exception 'La vinculación CRM del producto está incompleta.' using errcode = '22023';
    end if;

    select
      member.id,
      member.play_id,
      member.client_id,
      member.advisor_id_snapshot,
      member.benefit_status,
      play.status as play_status,
      play.starts_at,
      play.ends_at
    into member_row
    from public.crm_play_members member
    join public.crm_plays play on play.id = member.play_id
    where member.id = new.crm_play_member_id;

    if member_row.id is null
      or member_row.client_id is distinct from order_row.client_id
      or member_row.advisor_id_snapshot is distinct from order_row.attributed_advisor_id
    then
      raise exception 'La jugada no corresponde al cliente y asesor de esta orden.' using errcode = '42501';
    end if;

    if caller_id is not null
      and caller_role <> 'service_role'
      and caller_id is distinct from order_row.attributed_advisor_id
      and not public.is_master_or_admin()
    then
      raise exception 'Solo el asesor adjudicado, master o administrador pueden aplicar este beneficio.' using errcode = '42501';
    end if;

    select
      benefit.id,
      benefit.product_id,
      benefit.quantity
    into benefit_row
    from public.crm_play_benefits benefit
    join public.crm_play_member_benefit_selections selection
      on selection.play_member_id = member_row.id
     and selection.play_benefit_id = benefit.id
     and selection.play_id = benefit.play_id
    where benefit.id = new.crm_play_benefit_id
      and benefit.play_id = member_row.play_id;

    if benefit_row.id is null then
      raise exception 'El beneficio no está seleccionado para este cliente.' using errcode = '42501';
    end if;

    expected_product_id := benefit_row.product_id;
    expected_quantity := benefit_row.quantity;
    expected_line_total_usd := 0;

    if new.crm_play_benefit_upgrade_id is not null then
      select
        upgrade.id,
        upgrade.target_product_id,
        upgrade.target_quantity,
        upgrade.customer_difference_usd_snapshot
      into upgrade_row
      from public.crm_play_benefit_upgrades upgrade
      where upgrade.id = new.crm_play_benefit_upgrade_id
        and upgrade.play_benefit_id = benefit_row.id
        and upgrade.play_id = member_row.play_id;

      if upgrade_row.id is null then
        raise exception 'La ampliación no pertenece al beneficio seleccionado.' using errcode = '42501';
      end if;

      expected_product_id := upgrade_row.target_product_id;
      expected_quantity := upgrade_row.target_quantity;
      expected_line_total_usd := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);
    end if;

    if new.product_id is distinct from expected_product_id
      or pg_catalog.abs(coalesce(new.qty, 0) - expected_quantity) > 0.001
    then
      raise exception 'El producto final no corresponde al beneficio o ampliación seleccionada.'
        using errcode = '22023';
    end if;

    select exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = member_row.id
        and redemption.play_benefit_id = benefit_row.id
        and redemption.order_id = new.order_id
        and redemption.status = 'redeemed'
    ) into is_existing_redemption;

    if not is_existing_redemption then
      if member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or member_row.benefit_status not in ('available', 'reserved')
      then
        raise exception 'El beneficio de esta jugada ya no está disponible.' using errcode = '55000';
      end if;
    end if;

    expected_line_total_usd := pg_catalog.round(greatest(0, expected_line_total_usd), 2);
    expected_unit_price_usd := case
      when expected_quantity > 0 then pg_catalog.round(expected_line_total_usd / expected_quantity, 2)
      else 0
    end;

    new.pricing_origin_currency := 'USD';
    new.pricing_origin_amount := expected_unit_price_usd;
    new.unit_price_usd_snapshot := expected_unit_price_usd;
    new.line_total_usd := expected_line_total_usd;

    if order_row.fx_rate is not null and order_row.fx_rate > 0 then
      new.unit_price_bs_snapshot := pg_catalog.round(expected_unit_price_usd * order_row.fx_rate, 2);
      new.line_total_bs_snapshot := pg_catalog.round(expected_line_total_usd * order_row.fx_rate, 2);
    end if;
  end if;

  select nullif(pg_catalog.string_agg(clean_line, E'\n' order by line_number), '')
  into new.notes
  from (
    select pg_catalog.btrim(part.line) as clean_line, part.line_number
    from pg_catalog.regexp_split_to_table(coalesce(new.notes, ''), E'\\r?\\n')
      with ordinality as part(line, line_number)
    where pg_catalog.btrim(part.line) <> ''
      and pg_catalog.lower(pg_catalog.btrim(part.line)) not like '@crm|%'
  ) visible_lines;

  return new;
end;
$function$;

-- CREATE OR REPLACE retains the existing trigger and privileges.
