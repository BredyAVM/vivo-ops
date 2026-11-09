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

CREATE OR REPLACE FUNCTION app_private.order_crm_upgrade_difference_v1(p_order bigint, p_upgrade bigint)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when app_private.order_uses_current_usd_v1(p_order)
    then public.current_customer_difference_usd(u) else u.customer_difference_usd_snapshot end
  from public.crm_play_benefit_upgrades u where u.id=p_upgrade;
$function$
;

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
      expected_line_total_usd := coalesce(app_private.order_crm_upgrade_difference_v1(new.order_id,new.crm_play_benefit_upgrade_id), 0);
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

    if tg_op='UPDATE' and
      (to_jsonb(new)-array['notes']) is not distinct from (to_jsonb(old)-array['notes'])
      and exists(select 1 from public.crm_play_redemptions r where r.order_item_id=old.id and r.order_id=old.order_id
        and r.play_member_id=old.crm_play_member_id and r.play_benefit_id=old.crm_play_benefit_id
        and r.play_benefit_upgrade_id is not distinct from old.crm_play_benefit_upgrade_id and r.status in ('reserved','redeemed')) then
      return new;
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
    expected_line_total := case when tg_op='UPDATE' then old.customer_paid_difference_usd
      else coalesce(app_private.order_crm_upgrade_difference_v1(new.order_id,new.play_benefit_upgrade_id),0) end;
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

    if v_is_counter_direct_sale and position('@muerdeme|'in coalesce(new.notes,''))=0
      and new.admin_price_override_usd is null then
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
  if not v_is_crm_item and (not v_is_counter_direct_sale or new.admin_price_override_usd is not null)
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

CREATE OR REPLACE FUNCTION public.crm_confirm_play_v1(p_play_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  member_count integer;
  benefit_count integer;
  upgrade_count integer;
  conflict_count integer;
  active_rate numeric;
  confirmed_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to confirm a CRM play'
      using errcode = '42501';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status <> 'draft' then
    raise exception 'Only a play in design can be confirmed' using errcode = '55000';
  end if;

  if nullif(play_row.selection_summary ->> 'generated_at','') is null then
    raise exception 'Vuelve a probar la lista antes de confirmar el snapshot' using errcode='55000';
  end if;

  select count(*)::integer into member_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  select count(*)::integer into benefit_count
  from public.crm_play_benefits benefit
  where benefit.play_id = p_play_id;

  select count(*)::integer into upgrade_count
  from public.crm_play_benefit_upgrades upgrade
  where upgrade.play_id = p_play_id;

  if member_count = 0 then
    raise exception 'Generate and review a client list before confirming the play';
  end if;
  if benefit_count = 0 then
    raise exception 'At least one benefit is required before confirming the play';
  end if;

  select count(*)::integer into conflict_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and app_private.crm_play_has_overlap_conflict_v1(p_play_id, member_row.client_id);

  if conflict_count > 0 then
    raise exception '% clients now conflict with another confirmed play. Run the preview again.', conflict_count
      using errcode = '40001';
  end if;


  if exists (
    select 1 from public.crm_play_members member_row
    where member_row.play_id=p_play_id and member_row.workflow_status<>'removed'
      and app_private.crm_had_excluded_offer_v1(member_row.client_id,play_row.starts_at,play_row.rules_snapshot)
  ) then
    raise exception 'Hay clientes con una jugada lanzada durante el período de descanso seleccionado. Vuelve a probar la lista antes de confirmar.' using errcode='40001';
  end if;
  active_rate := public.get_active_exchange_rate();
  if active_rate is null or active_rate <= 0 then
    raise exception 'An active exchange rate is required to freeze this play';
  end if;

  update public.crm_play_benefits benefit
  set
    product_name_snapshot = product.name,
    source_price_currency_snapshot = product.source_price_currency,
    source_price_amount_snapshot = product.source_price_amount,
    catalog_price_usd_snapshot = case
      when product.source_price_currency = 'VES'
        then pg_catalog.round(coalesce(product.source_price_amount, 0) / active_rate, 6)
      else pg_catalog.round(coalesce(product.source_price_amount, product.base_price_usd, 0), 6)
    end
  from public.products product
  where benefit.play_id = p_play_id
    and product.id = benefit.product_id;

  update public.crm_play_benefit_upgrades upgrade
  set
    target_product_name_snapshot = product.name,
    target_source_price_currency_snapshot = product.source_price_currency,
    target_source_price_amount_snapshot = product.source_price_amount,
    target_catalog_price_usd_snapshot = case
      when product.source_price_currency = 'VES'
        then pg_catalog.round(coalesce(product.source_price_amount, 0) / active_rate, 6)
      else pg_catalog.round(coalesce(product.source_price_amount, product.base_price_usd, 0), 6)
    end,
    customer_difference_usd_snapshot = pg_catalog.round(greatest(
      (
        case
          when product.source_price_currency = 'VES'
            then coalesce(product.source_price_amount, 0) / active_rate
          else coalesce(product.source_price_amount, product.base_price_usd, 0)
        end
      ) * upgrade.target_quantity
      - benefit.unit_benefit_value_usd * benefit.quantity,
      0
    ), 6)
  from public.products product, public.crm_play_benefits benefit
  where upgrade.play_id = p_play_id
    and product.id = upgrade.target_product_id
    and benefit.id = upgrade.play_benefit_id
    and benefit.play_id = upgrade.play_id;

  if exists (
    select 1
    from public.crm_play_benefit_upgrades upgrade
    where upgrade.play_id = p_play_id
      and upgrade.customer_difference_usd_snapshot is null
  ) then
    raise exception 'One of the allowed upgrades could not be priced';
  end if;

  update public.crm_plays play
  set
    status = 'frozen',
    snapshot_at = confirmed_at,
    pricing_exchange_rate_ves_per_usd = active_rate,
    pricing_snapshot_at = confirmed_at
  where play.id = p_play_id;

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'member_count', member_count,
    'benefit_count', benefit_count,
    'upgrade_count', upgrade_count,
    'snapshot_at', confirmed_at,
    'exchange_rate_ves_per_usd', active_rate
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
      app_private.crm_paid_products_subtotal_v1(o.id) as commercial
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

CREATE OR REPLACE FUNCTION public.crm_refresh_play_preview_summary_v1(p_play_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_status text;
  selection_mode text;
  play_rules jsonb;
  existing_summary jsonb;
  excluded_ids jsonb;
  generated_at timestamptz;
  planned_budget numeric;
  company_min numeric := 0;
  company_max numeric := 0;
  advisor_min numeric := 0;
  advisor_max numeric := 0;
  value_min numeric := 0;
  value_max numeric := 0;
  preview_summary jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to refresh a CRM play preview'
      using errcode = '42501';
  end if;

  select
    play.status,
    play.benefit_selection_mode,
    coalesce(play.rules_snapshot, '{}'::jsonb),
    coalesce(play.selection_summary, '{}'::jsonb),
    play.planned_budget_usd
  into play_status, selection_mode, play_rules, existing_summary, planned_budget
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_status is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_status <> 'draft' then
    raise exception 'Only a draft CRM play can refresh its preview' using errcode = '55000';
  end if;

  excluded_ids := case
    when pg_catalog.jsonb_typeof(play_rules -> 'excluded_client_ids') = 'array'
      then play_rules -> 'excluded_client_ids'
    else '[]'::jsonb
  end;
  generated_at := coalesce(
    nullif(existing_summary ->> 'generated_at', '')::timestamptz,
    pg_catalog.now()
  );

  if selection_mode = 'multiple' then
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits
    where play_id = p_play_id;
  else
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits
    where play_id = p_play_id;
  end if;

  select pg_catalog.jsonb_build_object(
    'total', pg_catalog.count(*)::integer,
    'advisor_count', pg_catalog.count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', generated_at,
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'gifted_client_count', pg_catalog.count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (select pg_catalog.count(*)::integer from public.crm_play_benefits where play_id = p_play_id),
    'benefit_selection_mode', selection_mode,
    'total_purchase_count', coalesce(pg_catalog.sum(member_row.purchase_count), 0)::bigint,
    'total_net_revenue_usd', pg_catalog.round(coalesce(pg_catalog.sum(member_row.net_revenue_usd), 0), 2),
    'company_cost_per_client_min_usd', pg_catalog.round(company_min, 2),
    'company_cost_per_client_max_usd', pg_catalog.round(company_max, 2),
    'projected_cost_min_usd', pg_catalog.round(pg_catalog.count(*) * company_min, 2),
    'projected_cost_max_usd', pg_catalog.round(pg_catalog.count(*) * company_max, 2),
    'advisor_charge_per_client_min_usd', pg_catalog.round(advisor_min, 2),
    'advisor_charge_per_client_max_usd', pg_catalog.round(advisor_max, 2),
    'projected_advisor_charge_min_usd', pg_catalog.round(pg_catalog.count(*) * advisor_min, 2),
    'projected_advisor_charge_max_usd', pg_catalog.round(pg_catalog.count(*) * advisor_max, 2),
    'benefit_value_per_client_min_usd', pg_catalog.round(value_min, 2),
    'benefit_value_per_client_max_usd', pg_catalog.round(value_max, 2),
    'budget_usd', planned_budget,
    'budget_balance_worst_case_usd', case
      when planned_budget is null then null
      else pg_catalog.round(planned_budget - (pg_catalog.count(*) * company_max), 2)
    end,
    'budget_capacity_worst_case', case
      when planned_budget is null or company_max <= 0 then null
      else pg_catalog.floor(planned_budget / company_max)::bigint
    end,
    'budget_status', case
      when planned_budget is null then 'not_defined'
      when planned_budget >= pg_catalog.count(*) * company_max then 'within'
      else 'exceeds'
    end,
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        ) order by advisor_totals.member_count desc, advisor_totals.advisor_name
      )
      from (
        select
          grouped.advisor_id_snapshot as advisor_id,
          coalesce(advisor.full_name, 'Asesor sin nombre') as advisor_name,
          pg_catalog.count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into preview_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  update public.crm_plays set selection_summary = preview_summary where id = p_play_id;
  return preview_summary;
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
      and active_redemption.order_id <> new.order_id and (active_redemption.recurrence_mode_snapshot='once' or active_redemption.benefit_day=app_private.crm_order_benefit_day_v1(new.order_id))
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
    benefit_redeemed_at = case when exists (select 1 from public.crm_plays rp where rp.id=member.play_id and rp.benefit_recurrence_mode='daily') then member.benefit_redeemed_at else null end,
    benefit_expired_at = null
  where member.id = new.crm_play_member_id;
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
    or (member_row.benefit_status not in ('available', 'reserved') and not exists (select 1 from public.crm_plays rp where rp.id=member_row.play_id and rp.benefit_recurrence_mode='daily'))
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
