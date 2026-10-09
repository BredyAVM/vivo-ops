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

  if tg_op='UPDATE' and auth.uid() is not null
    and (public.is_master_or_admin() or public.has_role('counter'))
    and new.qty<=old.qty
    and app_private.order_item_operational_quantity_v1(to_jsonb(old),to_jsonb(new))
    and exists(select 1 from public.products p where p.id=old.product_id and not p.is_active)
    and exists(select 1 from public.orders o where o.id=old.order_id
      and o.status::text in ('created','queued','confirmed','in_kitchen','ready')
      and (public.is_master_or_admin() or o.fulfillment::text='pickup')) then
    return new;
  end if;
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

  if product_row.id is null or (
    not coalesce(product_row.is_active, false)
    and not (
      tg_op = 'UPDATE'
      and public.is_admin() is true
      and new.crm_play_member_id is null
      and new.crm_play_benefit_id is null
      and new.crm_play_benefit_upgrade_id is null
      and exists(select 1 from public.orders o where o.id = old.order_id and o.status::text = 'delivered')
      and (to_jsonb(new) - array['pricing_fx_rate_snapshot','unit_price_usd_snapshot','line_total_usd',
        'admin_price_override_usd','admin_price_override_by_user_id','admin_price_override_at','admin_price_override_reason',
        'unit_price_bs_snapshot','line_total_bs_snapshot','pricing_origin_currency','pricing_origin_amount','override_unit_price_usd','override_reason','override_approved_by','override_approved_at'])
        is not distinct from
        (to_jsonb(old) - array['pricing_fx_rate_snapshot','unit_price_usd_snapshot','line_total_usd',
        'admin_price_override_usd','admin_price_override_by_user_id','admin_price_override_at','admin_price_override_reason',
        'unit_price_bs_snapshot','line_total_bs_snapshot','pricing_origin_currency','pricing_origin_amount','override_unit_price_usd','override_reason','override_approved_by','override_approved_at'])
    )
  ) then
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
    if coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('advisor_gift', 'advisor_gift_only') then
      -- Discretionary client gifts are not CRM redemptions. Catalog metadata is
      -- administration-owned; membership and first-purchase gates do not apply.
      if caller_role <> 'service_role' and (
        caller_id is null
        or not (
          public.is_master_or_admin()
          or (public.has_role('counter') and order_row.source = 'walk_in')
          or (public.has_role('advisor') and caller_id is not distinct from order_row.attributed_advisor_id)
        )
      ) then
        raise exception 'Solo el asesor adjudicado, master o administrador pueden aplicar este obsequio.'
          using errcode = '42501';
      end if;

      -- Paid strategies retain canonical catalog pricing. Zero-price gifts stay zero.
      if coalesce(product_row.source_price_amount, product_row.base_price_usd, 0) = 0 then
      if coalesce(new.admin_price_override_usd, 0) <> 0
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
      end if;
    elsif (
        product_row.product_type = 'gambit'
        or coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('crm_only', 'gambit_disabled')
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
      if coalesce(product_row.extra_fields ->> 'catalog_access_scope', '') in ('advisor_gift_only', 'gambit_disabled', 'admin_internal') then
        raise exception 'El producto no permite uso mediante una jugada del CRM.' using errcode = '42501';
      end if;
      if (member_row.play_status <> 'active'
        or (member_row.starts_at is not null and pg_catalog.now() < member_row.starts_at)
        or (member_row.ends_at is not null and pg_catalog.now() >= member_row.ends_at)
        or (member_row.benefit_status not in ('available', 'reserved') and not exists (select 1 from public.crm_plays rp where rp.id=member_row.play_id and rp.benefit_recurrence_mode='daily')))
        and not app_private.crm_order_has_validity_exception_v1(new.order_id,new.crm_play_member_id)
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
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_play_redemption_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  member_row record;
  option_row record;
  upgrade_row record;
  order_row record;
  commercial_subtotal numeric;
  order_discount_pct numeric;
  expected_product_id bigint;
  expected_quantity numeric;
  expected_line_total numeric;
  lifecycle_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'Los registros de beneficios CRM no se eliminan; deben anularse.'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' and old.status='reserved' and new.status='reserved' and old.recurrence_mode_snapshot='daily' and new.benefit_day is distinct from old.benefit_day and (to_jsonb(new)-'benefit_day') is not distinct from (to_jsonb(old)-'benefit_day') then return new; end if;
  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.play_benefit_id is distinct from old.play_benefit_id
      or new.play_benefit_upgrade_id is distinct from old.play_benefit_upgrade_id
      or new.order_id is distinct from old.order_id
      or (
        new.order_item_id is distinct from old.order_item_id
        and not (
          new.status = 'voided'
          and new.order_item_id is null
          and old.order_item_id is not null
        )
      )
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.play_name_snapshot is distinct from old.play_name_snapshot
      or new.unit_benefit_value_usd is distinct from old.unit_benefit_value_usd
      or new.unit_advisor_cost_usd is distinct from old.unit_advisor_cost_usd
      or new.unit_company_cost_usd is distinct from old.unit_company_cost_usd
      or new.benefit_value_usd is distinct from old.benefit_value_usd
      or new.benefit_credit_usd is distinct from old.benefit_credit_usd
      or new.customer_paid_difference_usd is distinct from old.customer_paid_difference_usd
      or new.advisor_charge_usd is distinct from old.advisor_charge_usd
      or new.company_cost_usd is distinct from old.company_cost_usd
      or new.reserved_by_user_id is distinct from old.reserved_by_user_id
      or new.reserved_at is distinct from old.reserved_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'La identidad y los montos congelados del beneficio CRM son inmutables.'
        using errcode = '55000';
    end if;

    if old.status = 'reserved' and new.status = 'redeemed' then
      if old.redeemed_by_user_id is not null
        or old.redeemed_at is not null
        or new.redeemed_by_user_id is null
        or new.redeemed_at is null
        or new.voided_at is not null
        or new.void_reason is not null
      then
        raise exception 'La entrega del beneficio no tiene una auditoría válida.'
          using errcode = '22023';
      end if;
    elsif old.status in ('reserved', 'redeemed') and new.status = 'voided' then
      if new.voided_at is null or pg_catalog.btrim(coalesce(new.void_reason, '')) = '' then
        raise exception 'La anulación del beneficio requiere fecha y motivo.'
          using errcode = '22023';
      end if;
      if old.status = 'reserved' and (
        new.redeemed_by_user_id is not null or new.redeemed_at is not null
      ) then
        raise exception 'Una reserva anulada no puede figurar como entregada.'
          using errcode = '22023';
      end if;
      if old.status = 'redeemed' and (
        new.redeemed_by_user_id is distinct from old.redeemed_by_user_id
        or new.redeemed_at is distinct from old.redeemed_at
      ) then
        raise exception 'La evidencia de entrega del beneficio es inmutable.'
          using errcode = '55000';
      end if;
      return new;
    else
      raise exception 'Transición de beneficio CRM no permitida: % -> %', old.status, new.status
        using errcode = '55000';
    end if;
  else
    if new.status <> 'reserved'
      or new.reserved_by_user_id is null
      or new.reserved_at is null
      or new.redeemed_by_user_id is not null
      or new.redeemed_at is not null
      or new.voided_at is not null
      or new.void_reason is not null
    then
      raise exception 'Un beneficio nuevo debe comenzar como reserva auditada.'
        using errcode = '22023';
    end if;
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.workflow_status,
    member.benefit_status,
    play.name as play_name,
    play.status as play_status,
    play.starts_at,
    play.ends_at,
    play.purchase_requirement_mode,
    play.minimum_order_amount_usd
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = new.play_member_id;

  if member_row.id is null then
    raise exception 'La pertenencia a la jugada CRM no existe.' using errcode = 'P0002';
  end if;

  lifecycle_time := case when tg_op = 'INSERT' then new.reserved_at else new.redeemed_at end;
  if tg_op = 'INSERT' then
    if member_row.play_status <> 'active'
      or (member_row.starts_at is not null and lifecycle_time < member_row.starts_at)
      or (member_row.ends_at is not null and lifecycle_time >= member_row.ends_at)
      or (member_row.benefit_status not in ('available', 'reserved') and not exists (select 1 from public.crm_plays rp where rp.id=member_row.play_id and rp.benefit_recurrence_mode='daily'))
    then
      raise exception 'El beneficio de esta jugada ya no está disponible.' using errcode = '55000';
    end if;
  end if;

  select
    benefit.id,
    benefit.product_id,
    benefit.quantity,
    benefit.unit_benefit_value_usd,
    benefit.unit_advisor_cost_usd,
    benefit.unit_company_cost_usd
  into option_row
  from public.crm_play_benefits benefit
  join public.crm_play_member_benefit_selections selection
    on selection.play_benefit_id = benefit.id
   and selection.play_member_id = new.play_member_id
   and selection.play_id = benefit.play_id
  where benefit.id = new.play_benefit_id
    and benefit.play_id = member_row.play_id;

  if option_row.id is null then
    raise exception 'El beneficio no fue seleccionado para este cliente.' using errcode = '42501';
  end if;

  expected_product_id := option_row.product_id;
  expected_quantity := option_row.quantity;
  expected_line_total := 0;

  if new.play_benefit_upgrade_id is not null then
    select
      upgrade.id,
      upgrade.target_product_id,
      upgrade.target_quantity,
      upgrade.customer_difference_usd_snapshot
    into upgrade_row
    from public.crm_play_benefit_upgrades upgrade
    where upgrade.id = new.play_benefit_upgrade_id
      and upgrade.play_benefit_id = option_row.id
      and upgrade.play_id = member_row.play_id;

    if upgrade_row.id is null then
      raise exception 'La ampliación no pertenece al beneficio seleccionado.' using errcode = '42501';
    end if;

    expected_product_id := upgrade_row.target_product_id;
    expected_quantity := upgrade_row.target_quantity;
    expected_line_total := coalesce(upgrade_row.customer_difference_usd_snapshot, 0);
  end if;

  if new.product_id is distinct from expected_product_id
    or pg_catalog.abs(new.quantity - expected_quantity) > 0.001
  then
    raise exception 'El producto final no corresponde al beneficio o ampliación seleccionada.'
      using errcode = '22023';
  end if;

  select
    order_data.id,
    order_data.client_id,
    order_data.attributed_advisor_id,
    order_data.status::text as status,
    order_data.extra_fields
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  if order_row.id is null
    or order_row.client_id is distinct from member_row.client_id
    or order_row.attributed_advisor_id is distinct from member_row.advisor_id_snapshot
  then
    raise exception 'La orden no corresponde al cliente y asesor de esta jugada.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and order_row.status in ('delivered', 'cancelled') then
    raise exception 'No se puede reservar un beneficio en una orden cerrada.' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and order_row.status <> 'delivered' then
    raise exception 'El beneficio solo se entrega al completar la orden.' using errcode = '55000';
  end if;

  if new.order_item_id is null or not exists (
    select 1
    from public.order_items item
    where item.id = new.order_item_id
      and item.order_id = new.order_id
      and item.product_id = expected_product_id
      and item.crm_play_member_id = new.play_member_id
      and item.crm_play_benefit_id = new.play_benefit_id
      and item.crm_play_benefit_upgrade_id is not distinct from new.play_benefit_upgrade_id
      and pg_catalog.abs(item.qty - expected_quantity) <= 0.001
      and pg_catalog.abs(coalesce(item.line_total_usd, 0) - expected_line_total) <= 0.02
  ) then
    raise exception 'La orden no contiene la línea exacta y vinculada del beneficio CRM.'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' and old.status='reserved' and new.status='reserved' and old.recurrence_mode_snapshot='daily' and new.benefit_day is distinct from old.benefit_day and (to_jsonb(new)-'benefit_day') is not distinct from (to_jsonb(old)-'benefit_day') then return new; end if;
  if tg_op = 'UPDATE' then
    order_discount_pct := greatest(0, least(100, coalesce(
      nullif(order_row.extra_fields #>> '{pricing,discount_pct}', '')::numeric,
      0
    )));

    select pg_catalog.round(
      coalesce(sum(coalesce(item.line_total_usd, 0)), 0)
        * (1 - order_discount_pct / 100),
      2
    )
    into commercial_subtotal
    from public.order_items item
    where item.order_id = new.order_id
      and item.crm_play_member_id is null;

    perform app_private.crm_assert_order_minimum_v1(new.order_id);

    return new;
  end if;

  new.play_name_snapshot := member_row.play_name;
  new.unit_benefit_value_usd := option_row.unit_benefit_value_usd;
  new.unit_advisor_cost_usd := option_row.unit_advisor_cost_usd;
  new.unit_company_cost_usd := option_row.unit_company_cost_usd;
  new.benefit_value_usd := pg_catalog.round(option_row.unit_benefit_value_usd * option_row.quantity, 2);
  new.benefit_credit_usd := new.benefit_value_usd;
  new.customer_paid_difference_usd := pg_catalog.round(expected_line_total, 2);
  new.advisor_charge_usd := pg_catalog.round(option_row.unit_advisor_cost_usd * option_row.quantity, 2);
  new.company_cost_usd := pg_catalog.round(option_row.unit_company_cost_usd * option_row.quantity, 2);
  return new;
end;
$function$
;

