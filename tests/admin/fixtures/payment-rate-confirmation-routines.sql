CREATE OR REPLACE FUNCTION app_private.confirm_payment_report_atomic_v1(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_master boolean;
  v_report_id bigint;
  v_report public.payment_reports%rowtype;
  v_order public.orders%rowtype;
  v_prior public.payment_confirmation_operations%rowtype;
  v_account public.money_accounts%rowtype;
  v_account_id bigint;
  v_currency public.currency_code;
  v_amount numeric;
  v_rate numeric;
  v_usd numeric;
  v_date date;
  v_handling text;
  v_notes text;
  v_changes jsonb;
  v_line jsonb;
  v_line_account bigint;
  v_line_currency public.currency_code;
  v_line_amount numeric;
  v_line_rate numeric;
  v_line_usd numeric;
  v_change_total numeric := 0;
  v_fund numeric := 0;
  v_fund_id bigint;
  v_excess numeric;
  v_before record;
  v_after record;
  v_movement_id bigint;
  v_change_id bigint;
  v_movement_ids jsonb;
  v_group uuid := gen_random_uuid();
  v_event_id bigint;
  v_adjustment_id bigint;
  v_extra jsonb;
  v_pricing jsonb;
  v_payment jsonb;
  v_total_bs numeric;
  v_fx numeric;
  v_payload jsonb;
  v_result jsonb;
  v_now timestamptz := statement_timestamp();
begin
  v_admin := exists(select 1 from public.user_roles where user_id=v_uid and role='admin');
  v_master := v_admin or exists(select 1 from public.user_roles where user_id=v_uid and role='master');
  if v_uid is null or not (v_master or public.has_role('counter')) then
    raise exception 'No tienes permiso para confirmar pagos.' using errcode='42501';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Datos de confirmación inválidos.' using errcode='22023';
  end if;
  v_report_id := (p_input->>'reportId')::bigint;
  v_account_id := (p_input->>'accountId')::bigint;
  v_currency := (p_input->>'currency')::public.currency_code;
  v_amount := (p_input->>'amount')::numeric;
  v_rate := (p_input->>'rate')::numeric;
  v_handling := p_input->>'handling';
  v_notes := nullif(btrim(p_input->>'notes'),'');
  v_changes := coalesce(p_input->'changeLines','[]'::jsonb);
  if v_report_id is null or v_report_id<=0 or v_account_id is null or v_account_id<=0
    or v_currency is null or v_currency not in ('USD','VES')
    or v_amount is null or not(v_amount>0 and v_amount<=1000000000) or round(v_amount,2)<>v_amount
    or (v_currency='USD' and v_rate is not null)
    or (v_currency='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000)))
    or (v_handling is not null and v_handling not in ('change_given','store_fund','close_difference'))
    or (p_input->>'paymentKind' is not null and p_input->>'paymentKind'<>'retention')
    or jsonb_typeof(v_changes) is distinct from 'array' then
    raise exception 'Revisa el importe, moneda, tasa y decisión sobre el excedente.' using errcode='22023';
  end if;
  if jsonb_array_length(v_changes)>12 or (jsonb_array_length(v_changes)>0 and v_handling is distinct from 'change_given') then
    raise exception 'Líneas de cambio inválidas.' using errcode='22023';
  end if;
  if v_handling='close_difference' and not v_admin then
    raise exception 'Solo admin puede cerrar excedentes por redondeo.' using errcode='42501';
  end if;
  v_usd := round(case when v_currency='VES' then v_amount/v_rate else v_amount end,2);
  if v_usd<=0 then raise exception 'El importe convertido es menor a 0,01 USD.' using errcode='22023'; end if;

  -- The report itself is the stable intent identity; no new user field is needed.
  perform pg_advisory_xact_lock(hashtextextended('payment-confirmation:'||v_report_id::text,0));
  select * into v_prior from public.payment_confirmation_operations where report_id=v_report_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input then
      raise exception 'Este pago ya fue confirmado con otros datos. Actualiza la pantalla.' using errcode='22023';
    end if;
    if not exists(select 1 from public.payment_reports where id=v_report_id and status='confirmed' and confirmed_movement_id=v_prior.movement_id)
      or exists(select 1 from jsonb_array_elements_text(v_prior.result->'movementIds') ids(value)
        left join public.money_movements m on m.id=ids.value::bigint where m.status is distinct from 'confirmed') then
      raise exception 'El pago fue anulado o modificado; no se puede reenviar.' using errcode='22023';
    end if;
    return v_prior.result || jsonb_build_object('replayed',true);
  end if;
  select * into v_report from public.payment_reports where id=v_report_id;
  if not found then raise exception 'No se encontró el reporte de pago.' using errcode='22023'; end if;
  if not v_master and (v_report.created_by_user_id<>v_uid or v_report.reported_money_account_id<>v_account_id
    or v_report.reported_currency_code<>v_currency or v_report.reported_amount<>v_amount
    or not public.is_counter_direct_money_account(v_account_id)) then
    raise exception 'No tienes permiso para confirmar este reporte.' using errcode='42501';
  end if;
  -- Same lock order as Counter: order, accounts (ascending), report, client.
  select * into v_order from public.orders where id=v_report.order_id for update;
  if not found or v_order.status='cancelled' then
    raise exception 'La orden no existe o está cancelada.' using errcode='22023';
  end if;
  if ((p_input->>'orderId')::bigint is not null and (p_input->>'orderId')::bigint<>v_order.id)
    or ((p_input->>'clientId')::bigint is not null and (p_input->>'clientId')::bigint is distinct from v_order.client_id) then
    raise exception 'El reporte, la orden y el cliente no coinciden.' using errcode='22023';
  end if;
  for v_line_account in
    select distinct id from (
      select v_account_id as id union all
      select (line->>'accountId')::bigint from jsonb_array_elements(v_changes) line
    ) ids order by id
  loop
    select * into v_account from public.money_accounts where id=v_line_account for update;
    if not found or not v_account.is_active then
      raise exception 'Selecciona cuentas activas para el pago y el cambio.' using errcode='22023';
    end if;
    if not v_master and not exists(select 1 from public.money_account_payment_rules r
      join public.user_roles ur on ur.role=r.role and ur.user_id=v_uid
      where r.money_account_id=v_line_account and r.is_active and (r.can_confirm_payment or r.auto_confirms_report)) then
      raise exception 'No tienes permiso para operar con una de estas cuentas.' using errcode='42501';
    end if;
  end loop;
  select * into v_report from public.payment_reports where id=v_report_id for update;
  if v_report.status<>'pending' or v_report.order_id<>v_order.id then
    raise exception 'Este reporte ya fue revisado o cambió de orden.' using errcode='22023';
  end if;
  if coalesce((p_input->>'overrideOperationDate')::boolean,false) then
    if not v_master then raise exception 'No puedes modificar la fecha del reporte.' using errcode='42501'; end if;
    v_date := (p_input->>'date')::date;
  else
    v_date := coalesce(v_report.operation_date,(p_input->>'date')::date,(v_now at time zone 'America/Caracas')::date);
  end if;
  if v_date is null or not isfinite(v_date) then raise exception 'Fecha de operación inválida.' using errcode='22023'; end if;
  select * into v_before from public.get_order_financial_state(v_order.id,v_date,v_rate);
  if not found then raise exception 'No se pudo calcular el saldo de la orden.' using errcode='22023'; end if;
  update public.payment_reports set operation_date=v_date where id=v_report_id;
  v_movement_id := public.confirm_payment_report(v_report_id,v_account_id,v_currency,v_amount,v_date,v_rate,
    p_input->>'reviewNotes',p_input->>'reference',p_input->>'counterparty',p_input->>'description');
  update public.money_movements set movement_group_id=v_group where id=v_movement_id;
  v_movement_ids := jsonb_build_array(v_movement_id);
  select * into v_after from public.get_order_financial_state(v_order.id,v_date,v_rate);
  -- Never assign old unresolved overpayments to this report or credit more than
  -- the amount actually confirmed (which may differ from the reported amount).
  v_excess := least(v_usd,greatest(0,round(v_after.overpaid_usd-v_before.overpaid_usd,2)));
  if v_excess>0 and v_handling is null then
    if coalesce((p_input->>'requireExplicitHandling')::boolean,false) then
      raise exception 'Debes decidir qué hacer con el excedente antes de confirmar.' using errcode='22023';
    end if;
    v_handling := 'store_fund';
  end if;
  if v_handling='change_given' then
    if v_excess<=0 or jsonb_array_length(v_changes)=0 then
      raise exception 'No hay excedente disponible o faltan las líneas de cambio.' using errcode='22023';
    end if;
    for v_line in select value from jsonb_array_elements(v_changes) loop
      v_line_account := (v_line->>'accountId')::bigint;
      v_line_currency := (v_line->>'currency')::public.currency_code;
      v_line_rate := (v_line->>'rate')::numeric;
      if v_line_currency is null or v_line_currency not in ('USD','VES')
        or not exists(select 1 from public.money_accounts where id=v_line_account and currency_code=v_line_currency)
        or (v_line_currency='USD' and v_line_rate is not null)
        or (v_line_currency='VES' and (v_line_rate is null or not(v_line_rate>0 and v_line_rate<=1000000000))) then
        raise exception 'Cuenta, moneda o tasa del cambio inválida.' using errcode='22023';
      end if;
      v_line_amount := coalesce((v_line->>'amount')::numeric,
        case when jsonb_array_length(v_changes)=1 then round(v_excess*coalesce(v_line_rate,1),2) end);
      if v_line_amount is null or not(v_line_amount>0 and v_line_amount<=1000000000) or round(v_line_amount,2)<>v_line_amount then
        raise exception 'Monto del cambio inválido.' using errcode='22023';
      end if;
      v_line_usd := round(v_line_amount/coalesce(v_line_rate,1),2);
      if v_line_usd<=0 then raise exception 'Monto convertido del cambio inválido.' using errcode='22023'; end if;
      v_change_total := v_change_total+v_line_usd;
      if v_change_total>v_excess and (not(v_admin or v_master) or p_input->>'paymentKind'='retention' or not(p_input ? 'expectedChangeDebtUsd')) then
        raise exception 'El cambio supera el excedente disponible de USD %.',v_excess using errcode='22023';
      end if;
      insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,
        direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
        reference_code,counterparty_name,description,notes,order_id,movement_group_id)
      values(v_date,v_uid,v_now,v_uid,'confirmed','outflow',
        case when p_input->>'paymentKind'='retention' then 'withdrawal'::public.movement_type else 'change_given'::public.movement_type end,
        v_line_account,v_line_currency,v_line_amount,v_line_rate,v_line_usd,p_input->>'reference',p_input->>'counterparty',
        case when p_input->>'paymentKind'='retention' then 'Devolución de retención' else 'Cambio entregado' end
          ||' · orden '||v_order.id||' · reporte '||v_report_id,
        coalesce(nullif(btrim(v_line->>'notes'),''),v_notes),v_order.id,v_group) returning id into v_change_id;
      v_movement_ids := v_movement_ids || jsonb_build_array(v_change_id);
    end loop;
    if coalesce((p_input->>'requireExactChange')::boolean,false) and v_change_total<v_excess-0.01 then
      raise exception 'El cambio debe coincidir con el excedente calculado.' using errcode='22023';
    end if;
    if p_input ? 'expectedChangeDebtUsd' and
      coalesce((p_input->>'expectedChangeDebtUsd')::numeric,-1) is distinct from greatest(0,round(v_change_total-v_excess,2)) then
      raise exception 'El cambio o saldo cambió. Actualiza y confirma la diferencia por cobrar.' using errcode='22023';
    end if;
    if v_change_total-v_excess>v_after.confirmed_paid_usd-v_excess then
      raise exception 'El cambio adicional supera lo abonado a la orden.' using errcode='22023';
    end if;
    v_fund := greatest(0,v_excess-v_change_total);
  elsif v_handling='store_fund' then v_fund := v_excess;
  end if;
  if v_fund>0 then
    if v_order.client_id is null then raise exception 'La orden necesita un cliente para guardar el saldo a favor.' using errcode='22023'; end if;
    update public.clients set fund_balance_usd=round(fund_balance_usd+v_fund,2) where id=v_order.client_id;
    if not found then raise exception 'No se pudo guardar el saldo a favor.' using errcode='22023'; end if;
    insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,money_account_id,
      order_id,payment_report_id,reason_code,notes,created_by_user_id,movement_group_id)
    values(v_order.client_id,'credit',v_currency::text,round(v_fund*coalesce(v_rate,1),2),v_fund,v_account_id,
      v_order.id,v_report_id,case when p_input->>'paymentKind'='retention' then 'retention_overage_stored' else 'payment_overage_stored' end,
      v_notes,v_uid,v_group) returning id into v_fund_id;
  end if;
  if v_handling='close_difference' and v_excess>0 then
    if v_after.overpaid_usd>1 then raise exception 'Solo se pueden cerrar diferencias de hasta 1,00 USD.' using errcode='22023'; end if;
    v_extra := case when jsonb_typeof(v_order.extra_fields)='object' then v_order.extra_fields else '{}'::jsonb end;
    v_pricing := case when jsonb_typeof(v_extra->'pricing')='object' then v_extra->'pricing' else '{}'::jsonb end;
    v_payment := case when jsonb_typeof(v_extra->'payment')='object' then v_extra->'payment' else '{}'::jsonb end;
    v_fx := coalesce(nullif(v_pricing->>'fx_rate','')::numeric,0);
    v_total_bs := case when v_fx>0 then round(v_after.confirmed_paid_usd*v_fx,2)
      when v_after.total_usd>0 then round(v_after.total_bs/v_after.total_usd*v_after.confirmed_paid_usd,2) else v_after.total_bs end;
    v_pricing := v_pricing || jsonb_build_object('total_usd',v_after.confirmed_paid_usd,'total_bs',v_total_bs,
      'rounding_gain_closed_usd',v_after.overpaid_usd,'rounding_gain_close_applied_at',v_now,'rounding_gain_close_applied_by',v_uid);
    v_payment := v_payment || jsonb_build_object('rounding_gain_close',jsonb_build_object('closed_balance_usd',v_after.overpaid_usd,
      'previous_total_usd',v_after.total_usd,'next_total_usd',v_after.confirmed_paid_usd,'applied_at',v_now,'applied_by',v_uid,'notes',v_notes));
    update public.orders set total_usd=v_after.confirmed_paid_usd,total_bs_snapshot=v_total_bs,
      extra_fields=v_extra || jsonb_build_object('pricing',v_pricing,'payment',v_payment),last_modified_at=v_now,last_modified_by=v_uid where id=v_order.id;
    insert into public.order_admin_adjustments(order_id,adjustment_type,reason,notes,payload,created_by_user_id)
    values(v_order.id,'other','Cierre de excedente por redondeo',v_notes,jsonb_build_object('kind','rounding_gain_close',
      'delta_usd',v_after.overpaid_usd,'original_unit_price_usd',v_after.total_usd,'override_unit_price_usd',v_after.confirmed_paid_usd,
      'product_name','Cierre por redondeo','qty',1,'closed_balance_usd',v_after.overpaid_usd,
      'previous_total_usd',v_after.total_usd,'previous_total_bs',v_after.total_bs,'confirmed_paid_usd',v_after.confirmed_paid_usd,
      'next_total_usd',v_after.confirmed_paid_usd,'next_total_bs',v_total_bs,'payment_report_id',v_report_id,
      'previous_pricing',v_extra->'pricing','previous_payment',v_extra->'payment'),v_uid) returning id into v_adjustment_id;
  end if;
  v_payload := jsonb_build_object('report_id',v_report_id,'confirmed_money_account_id',v_account_id,'confirmed_currency',v_currency,
    'confirmed_amount',v_amount,'movement_date',v_date,'exchange_rate_ves_per_usd',v_rate,'movement_group_id',v_group,
    'movement_ids',v_movement_ids,'change_usd',v_change_total,'change_receivable_usd',greatest(0,v_change_total-v_excess),'fund_credit_usd',v_fund,'fund_movement_id',v_fund_id,
    'adjustment_id',v_adjustment_id,'handling',v_handling,'atomic_version',1);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
  values(v_order.id,v_order.order_number,'payment_confirmed','payment','Pago confirmado','El pago reportado fue confirmado.',
    'info',v_uid,v_payload) returning id into v_event_id;
  v_result := jsonb_build_object('orderId',v_order.id,'eventId',v_event_id,'movementId',v_movement_id,'movementIds',v_movement_ids,
    'movementGroupId',v_group,'payload',v_payload,'replayed',false);
  insert into public.payment_confirmation_operations(report_id,order_id,movement_id,movement_group_id,fund_movement_id,
    adjustment_id,event_id,created_by,request,result)
  values(v_report_id,v_order.id,v_movement_id,v_group,v_fund_id,v_adjustment_id,v_event_id,v_uid,p_input,v_result);
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_payment_report(p_report_id bigint, p_confirmed_money_account_id bigint, p_confirmed_currency currency_code, p_confirmed_amount numeric, p_movement_date date, p_confirmed_exchange_rate_ves_per_usd numeric DEFAULT NULL::numeric, p_review_notes text DEFAULT NULL::text, p_reference_code text DEFAULT NULL::text, p_counterparty_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_equiv numeric(12,2);
  v_order_id bigint;
  v_status public.payment_report_status;
  v_created_by_user_id uuid;
  v_reported_money_account_id bigint;
  v_reported_currency public.currency_code;
  v_reported_amount numeric(12,2);
  v_movement_id bigint;
  v_duplicate record;
  v_is_master_or_admin boolean;
  v_is_counter boolean;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_is_master_or_admin := public.is_master_or_admin();
  v_is_counter := public.has_role('counter');

  if not v_is_master_or_admin and not v_is_counter then
    raise exception 'Insufficient role to confirm payment reports';
  end if;

  if p_movement_date is null then
    raise exception 'movement_date is required';
  end if;

  if p_confirmed_amount is null or p_confirmed_amount <= 0 then
    raise exception 'confirmed_amount must be > 0';
  end if;

  perform o.id from public.orders o join public.payment_reports r on r.order_id=o.id
  where r.id=p_report_id for update of o;

  select
    report.order_id,
    report.status,
    report.created_by_user_id,
    report.reported_money_account_id,
    report.reported_currency_code,
    report.reported_amount
  into
    v_order_id,
    v_status,
    v_created_by_user_id,
    v_reported_money_account_id,
    v_reported_currency,
    v_reported_amount
  from public.payment_reports report
  where report.id = p_report_id
  for update;

  if not found then
    raise exception 'Payment report not found';
  end if;

  if v_status <> 'pending' then
    raise exception 'Only pending reports can be confirmed (current status: %)', v_status;
  end if;

  if not v_is_master_or_admin then
    if v_created_by_user_id <> v_uid
       or v_reported_money_account_id <> p_confirmed_money_account_id
       or v_reported_currency <> p_confirmed_currency
       or v_reported_amount <> round(p_confirmed_amount, 2)
       or not public.is_counter_direct_money_account(p_confirmed_money_account_id) then
      raise exception 'Counter can only auto-confirm its own unchanged report on a direct account';
    end if;
  end if;

  select exists (
    select 1
    from public.money_accounts account
    where account.id = p_confirmed_money_account_id
      and account.is_active = true
      and account.currency_code = p_confirmed_currency
  ) into v_is_counter;

  if not v_is_counter then
    raise exception 'Confirmed account is inactive, missing, or uses another currency';
  end if;

  if p_confirmed_currency = 'USD' then
    if p_confirmed_exchange_rate_ves_per_usd is not null then
      raise exception 'exchange_rate must be NULL when currency=USD';
    end if;
    v_equiv := round(p_confirmed_amount, 2);
  else
    if p_confirmed_exchange_rate_ves_per_usd is null
       or p_confirmed_exchange_rate_ves_per_usd <= 0 then
      raise exception 'exchange_rate_ves_per_usd is required and must be > 0 when currency=VES';
    end if;
    v_equiv := round(p_confirmed_amount / p_confirmed_exchange_rate_ves_per_usd, 2);
  end if;

  select *
  into v_duplicate
  from public.find_active_payment_duplicate(
    p_confirmed_money_account_id,
    p_movement_date,
    p_confirmed_currency,
    round(p_confirmed_amount, 2),
    p_reference_code,
    p_report_id
  )
  limit 1;

  if found then
    raise exception
      'Posible pago duplicado: ya existe un pago activo con la misma cuenta, fecha, monto y referencia en la orden % (%).',
      coalesce(v_duplicate.order_number, '#' || v_duplicate.order_id::text),
      coalesce(v_duplicate.client_name, 'cliente sin nombre');
  end if;

  insert into public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
    direction,
    movement_type,
    money_account_id,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    reference_code,
    counterparty_name,
    description,
    payment_report_id,
    order_id,
    status
  ) values (
    p_movement_date,
    v_uid,
    now(),
    v_uid,
    'inflow',
    'order_payment',
    p_confirmed_money_account_id,
    p_confirmed_currency,
    round(p_confirmed_amount, 2),
    p_confirmed_exchange_rate_ves_per_usd,
    v_equiv,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_counterparty_name), ''),
    nullif(btrim(p_description), ''),
    p_report_id,
    v_order_id,
    'confirmed'
  )
  returning id into v_movement_id;

  update public.payment_reports
  set
    status = 'confirmed',
    operation_date = coalesce(operation_date, p_movement_date),
    reviewed_at = now(),
    reviewed_by_user_id = v_uid,
    review_notes = nullif(btrim(p_review_notes), ''),
    confirmed_movement_id = v_movement_id
  where id = p_report_id;

  return v_movement_id;
end;
$function$;
