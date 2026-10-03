-- Admin price-only amendment: retain item identity, physical delivery and all payments.
-- Existing CRM guard also accepts monetary snapshots of inactive delivered products;
-- only ADMIN and only an otherwise identical, non-CRM item can use that exception.
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
$function$;

create or replace function public.save_delivered_order_prices_v1(
  p_order_id bigint, p_expected_last_modified_at timestamptz,
  p_operation_id uuid, p_changes jsonb, p_reason text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_after public.order_items%rowtype;
  v_change jsonb; v_previous jsonb; v_retry jsonb;
  v_before jsonb := '[]'; v_items jsonb := '[]';
  v_seen bigint[] := '{}'; v_closures jsonb := '[]';
  v_date date; v_period record; v_closure record;
  v_now timestamptz := clock_timestamp();
  v_fx numeric; v_price numeric; v_sub_usd numeric; v_sub_bs numeric;
  v_discount_pct numeric; v_tax_pct numeric; v_discount_usd numeric; v_discount_bs numeric;
  v_net_usd numeric; v_net_bs numeric; v_tax_usd numeric; v_tax_bs numeric;
  v_pricing jsonb; v_total_usd numeric; v_total_bs numeric;
  v_price_columns text[] := array['pricing_origin_currency','pricing_origin_amount','pricing_fx_rate_snapshot','unit_price_usd_snapshot','line_total_usd',
    'unit_price_bs_snapshot','line_total_bs_snapshot','admin_price_override_usd','admin_price_override_reason',
    'admin_price_override_by_user_id','admin_price_override_at','override_unit_price_usd','override_reason',
    'override_approved_by','override_approved_at'];
begin
  if auth.uid() is null or public.has_role('admin') is not true then
    raise exception 'Esta acción requiere permisos de administración.';
  end if;
  if p_operation_id is null or nullif(btrim(p_reason),'') is null or length(btrim(p_reason)) > 500 then
    raise exception 'Indica un motivo de hasta 500 caracteres y una operación válida.';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Los precios deben ser una lista.'; end if;
  if jsonb_array_length(p_changes) not between 1 and 200 then raise exception 'Selecciona entre 1 y 200 precios.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  -- One locked order, one audit entry per operation: a network retry never bills twice.
  select payload into v_retry from public.order_admin_adjustments
    where order_id=p_order_id and payload->>'kind'='delivered_order_prices'
      and payload->>'operation_id'=p_operation_id::text order by id desc limit 1;
  if v_retry is not null then
    if v_retry->'changes' is distinct from p_changes or v_retry->>'reason' is distinct from btrim(p_reason) then
      raise exception 'Esta operación ya se utilizó con otro ajuste.';
    end if;
    return v_retry->'result';
  end if;
  if v_order.status::text <> 'delivered' then raise exception 'Este ajuste solo está disponible para pedidos entregados.'; end if;
  if v_order.last_modified_at is distinct from p_expected_last_modified_at then raise exception 'El pedido cambió. Recarga sus precios antes de guardar.'; end if;
  if v_order.extra_fields->'event_extension' is not null then raise exception 'Rectifica el presupuesto autorizado de esta ampliación antes de ajustar su precio.'; end if;
  v_pricing := coalesce(v_order.extra_fields->'pricing','{}');
  v_fx := nullif(v_pricing->>'fx_rate','')::numeric;
  if v_fx is null or v_fx <= 0 or v_fx::text in ('NaN','Infinity','-Infinity') then raise exception 'El pedido no tiene una tasa guardada válida.'; end if;
  v_discount_pct := case when coalesce((v_pricing->>'discount_enabled')::boolean,false)
    then coalesce((v_pricing->>'discount_pct')::numeric,0) else 0 end;
  v_tax_pct := coalesce((v_pricing->>'invoice_tax_pct')::numeric,0);
  if v_discount_pct not between 0 and 100 or v_tax_pct not between 0 and 100 then raise exception 'Revisa el descuento o impuesto guardado en la orden.'; end if;
  select f.delivery_reference_date into v_date from public.get_order_financial_state(p_order_id,null,null) f;
  v_date := coalesce(v_date,(v_order.created_at at time zone 'America/Caracas')::date);
  -- Lock the containing periods and closure rows while validating and appending.
  -- Snapshot membership also protects orders later reassigned to another advisor.
  for v_period in
    select p.id, p.status from public.advisor_commission_periods p
    where v_date between p.date_from and p.date_to
       or exists (select 1 from public.advisor_commission_closures c
          where c.period_id = p.id and c.snapshot->'orders' @> jsonb_build_array(jsonb_build_object('orderId', p_order_id)))
    order by p.id for update
  loop
    if v_period.status <> 'open' then
      raise exception 'El período está cerrado. Rectifica la liquidación antes de ajustar estos precios.';
    end if;
    for v_closure in
      select c.* from public.advisor_commission_closures c
      where c.period_id = v_period.id and
        (c.advisor_user_id = v_order.attributed_advisor_id
          or c.snapshot->'orders' @> jsonb_build_array(jsonb_build_object('orderId', p_order_id)))
      order by c.id for update
    loop
      if v_closure.status <> 'preliminary' or v_closure.closed_at is not null or v_closure.paid_at is not null
         or v_closure.snapshot #>> '{commissionWorkflow,conformity,status}' = 'confirmed'
         or exists (select 1 from public.money_movements m where m.status = 'confirmed'
           and m.direction = 'outflow' and m.movement_type = 'expense_payment'
           and m.description like 'Liquidación de comisión · Cierre ' || v_closure.id || ' ·%') then
        raise exception 'La liquidación está confirmada o tiene pagos. Rectifícala antes de ajustar estos precios.';
      end if;
      v_closures := v_closures || jsonb_build_array(jsonb_build_object('id', v_closure.id, 'periodId', v_period.id));
    end loop;
  end loop;


  perform 1 from public.order_items where order_id=p_order_id order by id for update;
  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change->'itemId') is distinct from 'number' or (v_change->>'itemId') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_change->'unitPriceUsd') is distinct from 'number' then raise exception 'El producto o precio no es válido.'; end if;
    select * into v_item from public.order_items where id=(v_change->>'itemId')::bigint and order_id=p_order_id;
    if not found or v_item.id=any(v_seen) then raise exception 'El producto no pertenece al pedido o está repetido.'; end if;
    v_seen := array_append(v_seen,v_item.id);
    if v_item.crm_play_member_id is not null or v_item.crm_play_benefit_id is not null or v_item.crm_play_benefit_upgrade_id is not null then
      raise exception 'El beneficio de jugada conserva su precio autorizado.';
    end if;
    if exists(select 1 from public.products p where p.id=v_item.product_id
      and p.extra_fields->>'catalog_access_scope' in ('advisor_gift','advisor_gift_only')
      and coalesce(p.source_price_amount,p.base_price_usd,0)=0) then raise exception 'El obsequio debe conservar precio cero.'; end if;
    v_price := (v_change->>'unitPriceUsd')::numeric;
    if v_price < 0 or v_price > 9999999999.99 or v_price <> round(v_price,2)
      or v_price::text in ('NaN','Infinity','-Infinity') or v_item.qty is null or v_item.qty <= 0 then
      raise exception 'Indica un precio unitario USD válido, con hasta dos decimales.';
    end if;
    v_before := v_before || jsonb_build_array(to_jsonb(v_item));
    update public.order_items set
      pricing_origin_currency='USD', pricing_origin_amount=v_price,
      unit_price_usd_snapshot=v_price, line_total_usd=round(v_price*v_item.qty,2),
      unit_price_bs_snapshot=round(v_price*v_fx,2), line_total_bs_snapshot=round(round(v_price*v_item.qty,2)*v_fx,2),
      pricing_fx_rate_snapshot=v_fx, admin_price_override_usd=v_price, admin_price_override_reason=btrim(p_reason),
      admin_price_override_by_user_id=auth.uid(), admin_price_override_at=v_now,
      override_unit_price_usd=null, override_reason=null, override_approved_by=null, override_approved_at=null
      where id=v_item.id returning * into v_after;
    if not found or (to_jsonb(v_after)-v_price_columns) is distinct from (to_jsonb(v_item)-v_price_columns)
      or v_after.line_total_usd is distinct from round(v_price*v_item.qty,2)
      or v_after.line_total_bs_snapshot is distinct from round(round(v_price*v_item.qty,2)*v_fx,2) then
      raise exception 'El producto tiene reglas especiales que requieren revisión. No se guardó ningún cambio.';
    end if;
    v_items := v_items || jsonb_build_array(to_jsonb(v_after));
  end loop;
  if exists(select 1 from public.order_items where order_id=p_order_id and
    (line_total_usd is null or line_total_bs_snapshot is null)) then raise exception 'Completa los importes históricos de la orden antes de ajustar precios.'; end if;
  select round(sum(line_total_usd),2),round(sum(line_total_bs_snapshot),2) into v_sub_usd,v_sub_bs from public.order_items where order_id=p_order_id;
  v_discount_usd := round(v_sub_usd*v_discount_pct/100,2); v_discount_bs := round(v_sub_bs*v_discount_pct/100,2);
  v_net_usd := greatest(0,v_sub_usd-v_discount_usd); v_net_bs := greatest(0,v_sub_bs-v_discount_bs);
  v_tax_usd := round(v_net_usd*v_tax_pct/100,2); v_tax_bs := round(v_net_bs*v_tax_pct/100,2);
  v_total_usd := round(v_net_usd+v_tax_usd,2); v_total_bs := round(v_net_bs+v_tax_bs,2);
  v_pricing := v_pricing || jsonb_build_object('subtotal_usd',v_sub_usd,'subtotal_bs',v_sub_bs,
    'discount_amount_usd',v_discount_usd,'discount_amount_bs',v_discount_bs,
    'subtotal_after_discount_usd',v_net_usd,'subtotal_after_discount_bs',v_net_bs,
    'invoice_tax_amount_usd',v_tax_usd,'invoice_tax_amount_bs',v_tax_bs,'total_usd',v_total_usd,'total_bs',v_total_bs);
  update public.orders set total_usd=v_total_usd,total_bs_snapshot=v_total_bs,
    extra_fields=jsonb_set(coalesce(extra_fields,'{}'),'{pricing}',v_pricing,true),
    last_modified_at=v_now,last_modified_by=auth.uid() where id=p_order_id;
  v_retry := jsonb_build_object('orderId',p_order_id,'totalUsd',v_total_usd,'totalBs',v_total_bs,'closures',v_closures);
  insert into public.order_admin_adjustments(order_id,adjustment_type,reason,payload,created_by_user_id,created_at)
    values(p_order_id,'other',btrim(p_reason),jsonb_build_object('kind','delivered_order_prices','schema_version',1,
      'operation_id',p_operation_id,'changes',p_changes,'reason',btrim(p_reason),
      'before',jsonb_build_object('items',v_before,'pricing',v_order.extra_fields->'pricing',
        'total_usd',v_order.total_usd,'total_bs',v_order.total_bs_snapshot),
      'after',jsonb_build_object('items',v_items,'pricing',v_pricing,'total_usd',v_total_usd,'total_bs',v_total_bs),
      'result',v_retry),auth.uid(),v_now);
  return v_retry;
end;
$$;
revoke all on function public.save_delivered_order_prices_v1(bigint,timestamptz,uuid,jsonb,text) from public,anon;
grant execute on function public.save_delivered_order_prices_v1(bigint,timestamptz,uuid,jsonb,text) to authenticated;
