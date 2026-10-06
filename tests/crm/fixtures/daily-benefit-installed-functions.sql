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
        or member_row.benefit_status not in ('available', 'reserved'))
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
      or member_row.benefit_status not in ('available', 'reserved')
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

CREATE OR REPLACE FUNCTION app_private.crm_reserve_order_item_benefit_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor_id uuid;
  member_row record;
  order_row record;
begin
  if new.crm_play_member_id is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat('crm-play-member:', new.crm_play_member_id), 0)
  );

  select member.id, member.benefit_status
  into member_row
  from public.crm_play_members member
  where member.id = new.crm_play_member_id
  for update;

  select order_data.id, order_data.attributed_advisor_id, order_data.status::text as status
  into order_row
  from public.orders order_data
  where order_data.id = new.order_id;

  actor_id := coalesce(auth.uid(), order_row.attributed_advisor_id);
  if actor_id is null or not exists (
    select 1 from public.profiles profile where profile.id = actor_id
  ) then
    raise exception 'No se pudo identificar al responsable de reservar el beneficio.'
      using errcode = '42501';
  end if;

  if order_row.status in ('delivered', 'cancelled') then
    raise exception 'No se puede reservar un beneficio en una orden cerrada.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.crm_play_redemptions active_redemption
    where active_redemption.play_member_id = new.crm_play_member_id
      and active_redemption.status in ('reserved', 'redeemed')
      and active_redemption.order_id <> new.order_id
  ) then
    raise exception 'Este beneficio ya está reservado o entregado en otra orden.'
      using errcode = '23505';
  end if;

  insert into public.crm_play_redemptions (
    play_member_id,
    play_benefit_id,
    play_benefit_upgrade_id,
    order_id,
    order_item_id,
    product_id,
    quantity,
    status,
    reserved_by_user_id,
    reserved_at,
    redeemed_by_user_id,
    redeemed_at
  ) values (
    new.crm_play_member_id,
    new.crm_play_benefit_id,
    new.crm_play_benefit_upgrade_id,
    new.order_id,
    new.id,
    new.product_id,
    new.qty,
    'reserved',
    actor_id,
    pg_catalog.now(),
    null,
    null
  );

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = 'reserved',
    benefit_reserved_at = coalesce(member.benefit_reserved_at, pg_catalog.now()),
    benefit_redeemed_at = null,
    benefit_expired_at = null
  where member.id = new.crm_play_member_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_finalize_order_benefits_on_delivery_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor_id uuid;
  member_ids bigint[];
begin
  if new.status <> 'delivered' or old.status = 'delivered' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat('crm-order-delivery:', new.id), 0)
  );

  actor_id := coalesce(auth.uid(), new.last_modified_by, new.attributed_advisor_id);
  if actor_id is null or not exists (
    select 1 from public.profiles profile where profile.id = actor_id
  ) then
    raise exception 'No se pudo identificar al responsable de entregar los beneficios.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.order_items item
    where item.order_id = new.id
      and item.crm_play_member_id is not null
      and not exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.order_item_id = item.id
          and redemption.order_id = new.id
          and redemption.play_member_id = item.crm_play_member_id
          and redemption.play_benefit_id = item.crm_play_benefit_id
          and redemption.play_benefit_upgrade_id is not distinct from item.crm_play_benefit_upgrade_id
          and redemption.status in ('reserved', 'redeemed')
      )
  ) then
    raise exception 'La orden contiene un beneficio CRM sin reserva válida.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.crm_play_redemptions redemption
    left join public.order_items item
      on item.id = redemption.order_item_id
     and item.order_id = redemption.order_id
     and item.crm_play_member_id = redemption.play_member_id
     and item.crm_play_benefit_id = redemption.play_benefit_id
     and item.crm_play_benefit_upgrade_id is not distinct from redemption.play_benefit_upgrade_id
    where redemption.order_id = new.id
      and redemption.status = 'reserved'
      and item.id is null
  ) then
    raise exception 'La orden tiene una reserva CRM sin producto correspondiente.' using errcode = '55000';
  end if;

  select pg_catalog.array_agg(distinct redemption.play_member_id order by redemption.play_member_id)
  into member_ids
  from public.crm_play_redemptions redemption
  where redemption.order_id = new.id
    and redemption.status = 'reserved';

  if coalesce(pg_catalog.array_length(member_ids, 1), 0) = 0 then
    return new;
  end if;

  perform app_private.crm_assert_order_validity_v1(new.id);
  update public.crm_play_redemptions redemption
  set
    status = 'redeemed',
    redeemed_by_user_id = actor_id,
    redeemed_at = pg_catalog.now()
  where redemption.order_id = new.id
    and redemption.status = 'reserved';

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = 'redeemed',
    benefit_redeemed_at = pg_catalog.now(),
    benefit_expired_at = null
  where member.id = any(member_ids);
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  insert into public.crm_play_member_events (
    play_member_id,
    event_type,
    from_status,
    to_status,
    note,
    actor_user_id,
    created_at
  )
  select
    member.id,
    'benefit_redeemed',
    member.workflow_status,
    member.workflow_status,
    pg_catalog.concat('Obsequio entregado en la orden ', coalesce(new.order_number, new.id::text)),
    actor_id,
    pg_catalog.now()
  from public.crm_play_members member
  where member.id = any(member_ids);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_release_order_item_reservation_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  lifecycle_row record;
begin
  if old.crm_play_member_id is null then
    return old;
  end if;

  select redemption.id, redemption.play_member_id, redemption.status
  into lifecycle_row
  from public.crm_play_redemptions redemption
  where redemption.order_item_id = old.id
    and redemption.status in ('reserved', 'redeemed')
  for update;

  if lifecycle_row.id is null then
    raise exception 'La línea CRM no tiene una reserva auditable asociada.' using errcode = '55000';
  end if;
  if lifecycle_row.status = 'redeemed' then
    raise exception 'Un beneficio entregado no puede retirarse desde una modificación ordinaria.'
      using errcode = '55000';
  end if;

  update public.crm_play_redemptions redemption
  set
    status = 'voided',
    order_item_id = null,
    voided_at = pg_catalog.now(),
    void_reason = pg_catalog.concat(
      'Reserva liberada al retirar el producto del pedido ', old.order_id, '.'
    )
  where redemption.id = lifecycle_row.id;

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = case
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'redeemed'
      ) then 'redeemed'
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'reserved'
      ) then 'reserved'
      when play.status in ('active', 'paused')
        and (play.starts_at is null or pg_catalog.now() >= play.starts_at)
        and (play.ends_at is null or pg_catalog.now() < play.ends_at)
        then 'available'
      else 'expired'
    end,
    benefit_reserved_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status in ('reserved', 'redeemed')
    ) then member.benefit_reserved_at else null end,
    benefit_redeemed_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status = 'redeemed'
    ) then member.benefit_redeemed_at else null end
  from public.crm_plays play
  where member.id = lifecycle_row.play_member_id
    and play.id = member.play_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return old;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_void_play_redemptions_on_order_cancel_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  member_ids bigint[];
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  select pg_catalog.array_agg(distinct redemption.play_member_id order by redemption.play_member_id)
  into member_ids
  from public.crm_play_redemptions redemption
  where redemption.order_id = new.id
    and redemption.status in ('reserved', 'redeemed');

  if coalesce(pg_catalog.array_length(member_ids, 1), 0) = 0 then
    return new;
  end if;

  update public.crm_play_redemptions redemption
  set
    status = 'voided',
    voided_at = pg_catalog.now(),
    void_reason = pg_catalog.concat(
      case when redemption.status = 'reserved' then 'Reserva liberada' else 'Entrega anulada' end,
      ' automáticamente al cancelar el pedido ',
      coalesce(new.order_number, new.id::text),
      '.'
    )
  where redemption.order_id = new.id
    and redemption.status in ('reserved', 'redeemed');

  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'on', true);
  update public.crm_play_members member
  set
    benefit_status = case
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'redeemed'
      ) then 'redeemed'
      when exists (
        select 1 from public.crm_play_redemptions remaining
        where remaining.play_member_id = member.id and remaining.status = 'reserved'
      ) then 'reserved'
      when play.status in ('active', 'paused')
        and (play.starts_at is null or pg_catalog.now() >= play.starts_at)
        and (play.ends_at is null or pg_catalog.now() < play.ends_at)
        then 'available'
      else 'expired'
    end,
    benefit_reserved_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status in ('reserved', 'redeemed')
    ) then member.benefit_reserved_at else null end,
    benefit_redeemed_at = case when exists (
      select 1 from public.crm_play_redemptions remaining
      where remaining.play_member_id = member.id and remaining.status = 'redeemed'
    ) then member.benefit_redeemed_at else null end
  from public.crm_plays play
  where member.id = any(member_ids)
    and play.id = member.play_id;
  perform pg_catalog.set_config('app.crm_benefit_lifecycle_context', 'off', true);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.crm_set_play_benefits_v2(p_play_member_id bigint, p_play_benefit_ids bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  member_row record;
  requested_ids bigint[];
  current_ids bigint[];
  selection_time timestamptz := pg_catalog.now();
  option_names text;
begin
  if caller_id is null then
    raise exception 'Authentication is required to select CRM benefits'
      using errcode = '42501';
  end if;

  if p_play_member_id is null or p_play_member_id <= 0 then
    raise exception 'A valid CRM play member is required'
      using errcode = '22023';
  end if;

  select
    member.id,
    member.client_id,
    member.play_id,
    member.advisor_id_snapshot,
    member.workflow_status,
    member.benefit_status,
    play.status as play_status,
    play.starts_at,
    play.ends_at,
    play.benefit_selection_mode
  into member_row
  from public.crm_play_members member
  join public.crm_plays play on play.id = member.play_id
  where member.id = p_play_member_id
  for update of member;

  if member_row.id is null then
    raise exception 'CRM play member does not exist'
      using errcode = 'P0002';
  end if;

  if not (member_row.advisor_id_snapshot = caller_id or public.is_master_or_admin()) then
    raise exception 'This CRM benefit belongs to another advisor'
      using errcode = '42501';
  end if;

  if member_row.play_status <> 'active'
    or (member_row.starts_at is not null and selection_time < member_row.starts_at)
    or (member_row.ends_at is not null and selection_time >= member_row.ends_at)
  then
    raise exception 'The CRM play is not active for benefit selection'
      using errcode = '55000';
  end if;

  if member_row.workflow_status = 'removed'
    or member_row.benefit_status not in ('available', 'reserved')
  then
    raise exception 'This CRM play member cannot select a benefit'
      using errcode = '55000';
  end if;

  select pg_catalog.array_agg(option_id order by sort_order, option_id)
  into requested_ids
  from (
    select distinct option_row.id as option_id, option_row.sort_order
    from public.crm_play_benefits option_row
    where option_row.play_id = member_row.play_id
      and option_row.id = any(coalesce(p_play_benefit_ids, '{}'::bigint[]))
  ) valid_options;

  if requested_ids is null
    or pg_catalog.cardinality(requested_ids) <> pg_catalog.cardinality(coalesce(p_play_benefit_ids, '{}'::bigint[]))
  then
    raise exception 'Every selected benefit must belong to this CRM play'
      using errcode = '22023';
  end if;

  if member_row.benefit_selection_mode = 'single'
    and pg_catalog.cardinality(requested_ids) <> 1
  then
    raise exception 'This CRM play requires exactly one benefit'
      using errcode = '22023';
  end if;

  if member_row.benefit_selection_mode = 'multiple'
    and pg_catalog.cardinality(requested_ids) < 1
  then
    raise exception 'Select at least one benefit for this CRM play'
      using errcode = '22023';
  end if;

  select pg_catalog.array_agg(selection.play_benefit_id order by option_row.sort_order, selection.play_benefit_id)
  into current_ids
  from public.crm_play_member_benefit_selections selection
  join public.crm_play_benefits option_row on option_row.id = selection.play_benefit_id
  where selection.play_member_id = p_play_member_id;

  if coalesce(current_ids, '{}'::bigint[]) is distinct from requested_ids then
    delete from public.crm_play_member_benefit_selections selection
    where selection.play_member_id = p_play_member_id;

    insert into public.crm_play_member_benefit_selections (
      play_member_id,
      play_benefit_id,
      play_id,
      selected_by_user_id,
      selected_at
    )
    select
      p_play_member_id,
      option_row.id,
      member_row.play_id,
      caller_id,
      selection_time
    from public.crm_play_benefits option_row
    where option_row.id = any(requested_ids)
    order by option_row.sort_order, option_row.id;

    update public.crm_play_members member
    set
      selected_play_benefit_id = requested_ids[1],
      selected_benefit_at = selection_time,
      selected_benefit_by_user_id = caller_id
    where member.id = p_play_member_id;

    select pg_catalog.string_agg(
      pg_catalog.concat(option_row.quantity, ' × ', product.name),
      ', '
      order by option_row.sort_order, option_row.id
    )
    into option_names
    from public.crm_play_benefits option_row
    join public.products product on product.id = option_row.product_id
    where option_row.id = any(requested_ids);

    insert into public.crm_play_member_events (
      play_member_id,
      event_type,
      from_status,
      to_status,
      note,
      actor_user_id,
      created_at
    ) values (
      p_play_member_id,
      'benefit_selected',
      member_row.workflow_status,
      member_row.workflow_status,
      pg_catalog.concat('Beneficio seleccionado: ', option_names),
      caller_id,
      selection_time
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'play_member_id', p_play_member_id,
    'play_id', member_row.play_id,
    'client_id', member_row.client_id,
    'selection_mode', member_row.benefit_selection_mode,
    'selected_play_benefit_ids', requested_ids,
    'selected_benefit_at', selection_time
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_order_minimum_state_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with basket as (
    select o.id, o.client_id, o.attributed_advisor_id,
      round(coalesce(sum(i.line_total_usd) filter (where i.crm_play_member_id is null), 0)
        * (1 - greatest(0, least(100, coalesce(
          nullif(o.extra_fields #>> '{pricing,discount_pct}', '')::numeric, 0))) / 100), 2) as commercial
    from public.orders o left join public.order_items i on i.order_id = o.id
    where o.id = p_order_id
    group by o.id
  ), benefits as (
    select m.id as member_id, p.name, p.minimum_order_amount_usd as required,
      b.commercial,
      md5(jsonb_build_array(b.client_id, b.attributed_advisor_id, m.id,
        p.minimum_order_amount_usd,
        jsonb_agg(jsonb_build_array(i.id, i.product_id, i.qty, i.crm_play_benefit_id,
          i.crm_play_benefit_upgrade_id) order by i.id))::text) as fingerprint
    from basket b
    join public.order_items i on i.order_id = b.id
    join public.crm_play_members m on m.id = i.crm_play_member_id
    join public.crm_plays p on p.id = m.play_id
    where p.purchase_requirement_mode = 'minimum_order'
    group by b.client_id, b.attributed_advisor_id, b.commercial, m.id, p.name, p.minimum_order_amount_usd
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberId', b.member_id, 'playName', b.name, 'requiredUsd', b.required,
    'commercialUsd', b.commercial, 'fingerprint', b.fingerprint,
    'authorizedFloorUsd', e.minimum_authorized_usd, 'reason', e.reason,
    'approvedAt', e.approved_at,
    'approvedBy', (select full_name from public.profiles where id = e.approved_by),
    'eligible', b.commercial + 0.005 >= coalesce(e.minimum_authorized_usd, b.required)
  ) order by b.member_id), '[]'::jsonb)
  from benefits b left join lateral (
    select exception.* from app_private.crm_order_minimum_exceptions exception
    where exception.order_id = p_order_id and exception.play_member_id = b.member_id
      and exception.benefit_fingerprint = b.fingerprint
    order by exception.minimum_authorized_usd, exception.approved_at desc limit 1
  ) e on true;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_assert_order_minimum_v1(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_status text; v_benefit jsonb;
begin
  -- Serialize all financial/product edits and exception approvals on the same order.
  select status::text into v_status from public.orders where id = p_order_id for update;
  if not found or v_status = 'cancelled' then return; end if;
  for v_benefit in select value from jsonb_array_elements(app_private.crm_order_minimum_state_v1(p_order_id)) loop
    if not (v_benefit ->> 'eligible')::boolean then
      raise exception 'El beneficio de esta jugada («%») requiere una compra de al menos $% sin contar regalos. La compra quedó en $%. Completa el mínimo, retira el obsequio o solicita una excepción al administrador.',
        v_benefit ->> 'playName',
        coalesce(v_benefit ->> 'authorizedFloorUsd', v_benefit ->> 'requiredUsd'),
        v_benefit ->> 'commercialUsd'
        using errcode = '23514';
    end if;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_order_validity_state_v1(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with benefits as (
    select o.id, o.status::text order_status, o.client_id, o.attributed_advisor_id,
      nullif(o.extra_fields #>> '{schedule,date}', '')::date scheduled_on,
      m.id member_id, m.client_id member_client_id, m.advisor_id_snapshot,
      m.workflow_status, m.benefit_status, p.name, p.status play_status, p.starts_at, p.ends_at,
      md5(jsonb_build_array(o.client_id, o.attributed_advisor_id, m.id, p.starts_at, p.ends_at,
        jsonb_agg(jsonb_build_array(i.id,i.product_id,i.qty,i.crm_play_benefit_id,
          i.crm_play_benefit_upgrade_id) order by i.id))::text) fingerprint
    from public.orders o
    join public.order_items i on i.order_id = o.id
    join public.crm_play_members m on m.id = i.crm_play_member_id
    join public.crm_plays p on p.id = m.play_id
    where o.id = p_order_id
    group by o.id, o.status, o.client_id, o.attributed_advisor_id, o.extra_fields,
      m.id, m.client_id, m.advisor_id_snapshot, m.workflow_status, m.benefit_status,
      p.name, p.status, p.starts_at, p.ends_at
  ), rules as (
    select b.*, e.authorized_through, e.reason, e.approved_at, e.approved_by,
      (b.client_id = b.member_client_id and b.attributed_advisor_id = b.advisor_id_snapshot
        and b.workflow_status not in ('removed','not_applicable')
        and b.benefit_status in ('available','reserved','expired')
        and b.play_status in ('active','closed')
        and (b.starts_at is null or now() >= b.starts_at)
        and not exists (select 1 from public.crm_play_redemptions r
          where r.play_member_id = b.member_id and r.status in ('reserved','redeemed')
            and (r.order_id <> b.id or r.status = 'redeemed'))) as can_use,
      (b.play_status = 'active' and b.benefit_status in ('available','reserved')
        and (b.starts_at is null or coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
          >= (b.starts_at at time zone 'America/Caracas')::date)
        and (b.ends_at is null or (now() < b.ends_at and
          coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
            <= (b.ends_at at time zone 'America/Caracas')::date))) as ordinary_valid,
      (e.id is not null and (now() at time zone 'America/Caracas')::date <= e.authorized_through
        and coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date) <= e.authorized_through
        and (b.starts_at is null or coalesce(b.scheduled_on, (now() at time zone 'America/Caracas')::date)
          >= (b.starts_at at time zone 'America/Caracas')::date)) as exception_valid
    from benefits b left join lateral (
      select x.* from app_private.crm_order_validity_exceptions x
      where x.order_id = b.id and x.play_member_id = b.member_id and x.benefit_fingerprint = b.fingerprint
      order by x.approved_at desc, x.id desc limit 1
    ) e on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberId',member_id,'playName',name,'playStatus',play_status,'scheduledOn',scheduled_on,
    'endsOn',(ends_at at time zone 'America/Caracas')::date,'fingerprint',fingerprint,
    'authorizedThrough',authorized_through,'reason',reason,'approvedAt',approved_at,
    'approvedBy',(select full_name from public.profiles where id = r.approved_by),
    'canAuthorize',coalesce(can_use and order_status not in ('delivered','cancelled'),false),
    'exceptionValid',coalesce(can_use and exception_valid,false),
    'eligible',coalesce(can_use and (ordinary_valid or exception_valid),false)
  ) order by member_id),'[]'::jsonb) from rules r;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_catalog_gift_candidates_v1(p_client_id bigint, p_advisor_id uuid, p_product_id bigint)
 RETURNS TABLE(play_member_id bigint, play_benefit_id bigint, play_benefit_upgrade_id bigint, play_name text, benefit_status text, target_product_id bigint, quantity numeric, customer_difference_usd numeric, purchase_requirement_mode text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with options as (
    select b.id benefit_id,b.play_id,b.product_id target_id,b.quantity qty,
      null::bigint upgrade_id,0::numeric difference
    from public.crm_play_benefits b
    where b.product_id=p_product_id or exists(
      select 1 from public.crm_play_catalog_aliases a
      where a.play_benefit_id=b.id and a.source_product_id=p_product_id and a.play_benefit_upgrade_id is null)
    union
    select b.id,b.play_id,u.target_product_id,u.target_quantity,u.id,u.customer_difference_usd_snapshot
    from public.crm_play_benefits b join public.crm_play_benefit_upgrades u on u.play_benefit_id=b.id
    where u.target_product_id=p_product_id or exists(
      select 1 from public.crm_play_catalog_aliases a
      where a.play_benefit_id=b.id and a.source_product_id=p_product_id and a.play_benefit_upgrade_id=u.id)
  )
  select m.id,o.benefit_id,o.upgrade_id,p.name,m.benefit_status,o.target_id,o.qty,o.difference,p.purchase_requirement_mode
  from options o join public.crm_plays p on p.id=o.play_id
  join public.crm_play_members m on m.play_id=p.id and m.client_id=p_client_id and m.advisor_id_snapshot=p_advisor_id
  join public.products source on source.id=p_product_id
  join public.products target on target.id=o.target_id
  where source.type::text='gambit' and source.is_active
    and source.extra_fields->>'catalog_access_scope'='advisor_gift'
    and target.is_active
    and coalesce(target.extra_fields->>'catalog_access_scope','') not in ('advisor_gift_only','gambit_disabled','admin_internal')
    and m.workflow_status not in ('removed','not_applicable')
    and m.benefit_status in ('available','reserved','redeemed')
    and p.status='active' and (p.starts_at is null or now()>=p.starts_at) and (p.ends_at is null or now()<p.ends_at)
  order by m.id,o.benefit_id,o.upgrade_id;
$function$
;

CREATE OR REPLACE FUNCTION app_private.crm_play_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  amendment_context text := coalesce(
    pg_catalog.current_setting('app.crm_play_amendment_context', true),
    ''
  );
begin
  if old.status <> 'draft' and (
    new.series_key is distinct from old.series_key
    or new.version is distinct from old.version
    or new.supersedes_play_id is distinct from old.supersedes_play_id
    or new.copied_from_play_id is distinct from old.copied_from_play_id
    or new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.rules_snapshot is distinct from old.rules_snapshot
    or new.metric_window is distinct from old.metric_window
    or new.gift_product_id is distinct from old.gift_product_id
    or new.gift_quantity is distinct from old.gift_quantity
    or new.planned_budget_usd is distinct from old.planned_budget_usd
    or new.benefit_selection_mode is distinct from old.benefit_selection_mode
    or new.purchase_requirement_mode is distinct from old.purchase_requirement_mode
    or new.minimum_order_amount_usd is distinct from old.minimum_order_amount_usd
    or new.overlap_policy is distinct from old.overlap_policy
    or new.benefit_stack_policy is distinct from old.benefit_stack_policy
    or new.evaluation_window_days is distinct from old.evaluation_window_days
    or new.pricing_exchange_rate_ves_per_usd is distinct from old.pricing_exchange_rate_ves_per_usd
    or new.pricing_snapshot_at is distinct from old.pricing_snapshot_at
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.snapshot_at is distinct from old.snapshot_at
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'A frozen CRM play definition is immutable';
  end if;

  if old.status <> 'draft'
    and new.selection_summary is distinct from old.selection_summary
    and amendment_context <> 'published_summary'
  then
    raise exception 'A published CRM play summary can only change through an audited amendment';
  end if;

  if old.status <> 'draft'
    and (
      new.advisor_guidance is distinct from old.advisor_guidance
      or new.message_template is distinct from old.message_template
    )
    and amendment_context <> 'message'
  then
    raise exception 'Published CRM play copy can only change through an audited amendment';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('frozen', 'cancelled'))
    or (old.status = 'frozen' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('paused', 'closed', 'cancelled'))
    or (old.status = 'paused' and new.status in ('active', 'closed', 'cancelled'))
  ) then
    raise exception 'Invalid CRM play status transition: % -> %', old.status, new.status;
  end if;

  if new.status is not distinct from old.status
    and old.status <> 'draft'
    and (
      new.activated_at is distinct from old.activated_at
      or new.activated_by_user_id is distinct from old.activated_by_user_id
      or new.closed_at is distinct from old.closed_at
    )
  then
    raise exception 'CRM play lifecycle timestamps can only change with a status transition';
  end if;

  if new.status = 'frozen' and (
    new.activated_at is not null
    or new.activated_by_user_id is not null
    or new.closed_at is not null
  ) then
    raise exception 'A frozen CRM play cannot contain activation or closure timestamps';
  end if;

  if new.status = 'active' and old.status = 'frozen' and (
    new.activated_at is null or new.activated_by_user_id is null
  ) then
    raise exception 'CRM play activation requires actor and timestamp';
  end if;

  if new.status = 'closed' and new.closed_at is null then
    raise exception 'Closing a CRM play requires closed_at';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.crm_clone_play_v3(p_source_play_id bigint, p_name text DEFAULT NULL::text, p_shift_months integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  source_play public.crm_plays%rowtype;
  clone_result jsonb;
  cloned_play_id bigint;
  cloned_name text;
  cloned_starts_at timestamptz;
  cloned_ends_at timestamptz;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to copy a CRM play'
      using errcode = '42501';
  end if;

  if p_shift_months < 0 or p_shift_months > 24 then
    raise exception 'CRM play month shift must be between 0 and 24'
      using errcode = '22023';
  end if;

  select play.* into source_play
  from public.crm_plays play
  where play.id = p_source_play_id;

  if source_play.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  cloned_name := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  if cloned_name is null and p_shift_months > 0 then
    cloned_name := left(source_play.name || ' · siguiente período', 120);
  end if;

  clone_result := public.crm_clone_play_v2(p_source_play_id, cloned_name);
  cloned_play_id := (clone_result ->> 'play_id')::bigint;

  if p_shift_months > 0 then
    update public.crm_plays play
    set
      starts_at = case
        when source_play.starts_at is null then null
        else source_play.starts_at + pg_catalog.make_interval(months => p_shift_months)
      end,
      ends_at = case
        when source_play.ends_at is null then null
        else source_play.ends_at + pg_catalog.make_interval(months => p_shift_months)
      end
    where play.id = cloned_play_id
      and play.status = 'draft'
    returning play.starts_at, play.ends_at
    into cloned_starts_at, cloned_ends_at;
  else
    select play.starts_at, play.ends_at
    into cloned_starts_at, cloned_ends_at
    from public.crm_plays play
    where play.id = cloned_play_id;
  end if;

  return clone_result || pg_catalog.jsonb_build_object(
    'shift_months', p_shift_months,
    'starts_at', cloned_starts_at,
    'ends_at', cloned_ends_at
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION app_private.crm_assert_order_validity_v1(p_order_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_status text; v_rule jsonb;
begin
  select status::text into v_status from public.orders where id = p_order_id for update;
  if not found or v_status = 'cancelled' then return; end if;
  for v_rule in select value from jsonb_array_elements(app_private.crm_order_validity_state_v1(p_order_id)) loop
    if not (v_rule->>'eligible')::boolean then
      raise exception 'El beneficio de esta jugada («%») no está habilitado para esta fecha. Solicita una excepción de vigencia al administrador, cambia la fecha o retira el obsequio.', v_rule->>'playName'
        using errcode = '23514';
    end if;
  end loop;
end;
$function$
;
