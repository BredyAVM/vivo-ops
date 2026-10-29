CREATE OR REPLACE FUNCTION app_private.record_commission_payment_v1(p_request_id uuid, p_closure_id bigint, p_account_id bigint, p_amount_usd numeric, p_fee_native numeric, p_rate numeric, p_date date, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_closure public.advisor_commission_closures%rowtype;
  v_account public.money_accounts%rowtype;
  v_prior public.commission_payment_operations%rowtype;
  v_request jsonb;
  v_result jsonb;
  v_paid numeric;
  v_remaining numeric;
  v_native numeric;
  v_fee_usd numeric;
  v_payment_id bigint;
  v_fee_id bigint;
  v_period_name text;
  v_advisor_name text;
  v_description text;
  v_now timestamptz := statement_timestamp();
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Esta acción requiere administración.' using errcode='42501';
  end if;
  if p_request_id is null or p_closure_id is null or p_closure_id<=0 or p_account_id is null or p_account_id<=0
    or p_amount_usd is null or not(p_amount_usd>0 and p_amount_usd<=1000000000) or round(p_amount_usd,2)<>p_amount_usd
    or p_fee_native is null or not(p_fee_native>=0 and p_fee_native<=1000000000) or round(p_fee_native,2)<>p_fee_native
    or p_date is null or not isfinite(p_date) or p_date>(v_now at time zone 'America/Caracas')::date
    or length(coalesce(p_reference,''))>120 then
    raise exception 'Datos de abono inválidos; revisa importe, fecha y referencia.' using errcode='22023';
  end if;
  v_request := jsonb_build_object('closureId',p_closure_id,'accountId',p_account_id,'amountUsd',p_amount_usd,
    'feeNative',p_fee_native,'rate',p_rate,'date',p_date,'reference',nullif(btrim(p_reference),''));
  -- Serialize a retry key before locking its closure; same key/different input fails.
  perform pg_advisory_xact_lock(hashtextextended('commission-payment:'||p_request_id::text,0));
  select * into v_prior from public.commission_payment_operations where request_id=p_request_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>v_request then
      raise exception 'Este envío ya fue utilizado con otros datos. Actualiza la pantalla.' using errcode='22023';
    end if;
    if exists(select 1 from public.commission_payment_reversals where payment_request_id=p_request_id) then
      raise exception 'Este abono ya fue anulado. No vuelvas a enviar el mismo registro.' using errcode='22023';
    end if;
    return v_prior.result || jsonb_build_object('replayed',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-advisor:'||(select advisor_user_id::text from public.advisor_commission_closures where id=p_closure_id),0));
     select * into v_closure from public.advisor_commission_closures where id=p_closure_id for update;
  if not found then raise exception 'Liquidación no encontrada.' using errcode='22023'; end if;
  if v_closure.status not in ('closed','paid') or v_closure.snapshot#>>'{commissionWorkflow,conformity,status}' is distinct from 'confirmed'
    or v_closure.snapshot#>>'{settlement,formulaVersion}' is distinct from 'advisor-settlement-v1'
    or v_closure.snapshot#>>'{version}' is distinct from '2'
    or nullif(v_closure.snapshot#>>'{totals,payableUsd}','')::numeric is distinct from v_closure.payable_usd then
    raise exception 'La liquidación debe estar actualizada, cerrada y conformada.' using errcode='22023';
  end if;
  if v_closure.manual_deductions_usd is distinct from (select coalesce(sum(amount_usd),0)
    from public.advisor_commission_deductions where closure_id=p_closure_id and deduction_type<>'gift') then
    raise exception 'Hay una actualización de deducciones pendiente. Revisa el cálculo antes de pagar.' using errcode='22023';
  end if;
  -- Never certify historical description matches automatically or ignore them
  -- when calculating remaining funds: require evidence reconciliation first.
  if exists(select 1 from public.money_movements m where m.status='confirmed'
    and m.direction='outflow' and m.movement_type='expense_payment'
    and m.description like 'Liquidación de comisión · Cierre '||p_closure_id||' ·%'
    and not exists(select 1 from public.commission_payment_operations o where o.payment_movement_id=m.id)) then
    raise exception 'Este cierre tiene abonos históricos: verifica su vinculación antes de registrar otro.' using errcode='22023';
  end if;
  select * into v_account from public.money_accounts where id=p_account_id for share;
  if not found or not v_account.is_active then raise exception 'Selecciona una cuenta activa.' using errcode='22023'; end if;
  if v_account.currency_code='VES' then
    if p_rate is null or not(p_rate>0 and p_rate<=1000000000) then
      raise exception 'Indica una tasa válida para bolívares.' using errcode='22023';
    end if;
    v_native:=round(p_amount_usd*p_rate,2);
    v_fee_usd:=round(p_fee_native/p_rate,2);
  elsif v_account.currency_code='USD' then
    if p_rate is not null then raise exception 'La cuenta USD no requiere tasa.' using errcode='22023'; end if;
    v_native:=p_amount_usd; v_fee_usd:=p_fee_native;
  else raise exception 'Moneda no admitida.' using errcode='22023'; end if;
  if v_native<=0 or (p_fee_native>0 and v_fee_usd<=0) then
    raise exception 'El importe convertido queda por debajo del mínimo contable de 0,01 USD.' using errcode='22023';
  end if;
  select coalesce(sum(m.amount_usd_equivalent),0) into v_paid
    from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id
    where o.closure_id=p_closure_id and m.status='confirmed';
  perform 1 from public.orders where id in (select jsonb_array_elements_text(app_private.commission_collection_state_v1(p_closure_id)->'orderIds')::bigint) order by id for update;
     if exists(select 1 from public.advisor_commission_carry_transfers where source_closure_id=p_closure_id) then
       raise exception 'Este saldo se paga en el período al que fue transferido.' using errcode='22023'; end if;
     v_remaining:=(app_private.commission_collection_state_v1(p_closure_id)->>'pendingUsd')::numeric;
  if p_amount_usd>v_remaining then raise exception 'El abono supera el saldo pendiente de USD %.',v_remaining using errcode='22023'; end if;
  select name into v_period_name from public.advisor_commission_periods where id=v_closure.period_id;
  v_advisor_name:=coalesce(nullif(btrim(v_closure.snapshot#>>'{advisor,name}'),''),'Asesor');
  v_description:='Liquidación de comisión · Cierre '||p_closure_id||' · '||coalesce(v_period_name,'Periodo')||' · '||v_advisor_name;
  insert into public.money_movements (movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
    direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
    reference_code,counterparty_name,description,movement_group_id,status,approval_required)
  values(p_date,v_uid,v_now,v_uid,'outflow','expense_payment',p_account_id,v_account.currency_code,v_native,p_rate,p_amount_usd,
    nullif(btrim(p_reference),''),v_advisor_name,v_description,p_request_id,'confirmed',false) returning id into v_payment_id;
  if p_fee_native>0 then
    insert into public.money_movements (movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
      direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
      reference_code,counterparty_name,description,movement_group_id,status,approval_required)
    values(p_date,v_uid,v_now,v_uid,'outflow','fee_charge',p_account_id,v_account.currency_code,p_fee_native,p_rate,v_fee_usd,
      nullif(btrim(p_reference),''),v_advisor_name,'Comisión bancaria · '||v_description,p_request_id,'confirmed',false) returning id into v_fee_id;
  end if;
  v_remaining:=v_remaining-p_amount_usd;
  v_result:=jsonb_build_object('movementId',v_payment_id,'feeMovementId',v_fee_id,'closureId',p_closure_id,
    'advisorUserId',v_closure.advisor_user_id,'periodId',v_closure.period_id,'periodName',v_period_name,
    'amountUsd',p_amount_usd,'remainingUsd',v_remaining,'fullyPaid',v_remaining=0,'replayed',false);
  insert into public.commission_payment_operations(request_id,closure_id,payment_movement_id,fee_movement_id,created_by,request,result)
    values(p_request_id,p_closure_id,v_payment_id,v_fee_id,v_uid,v_request,v_result);
  if v_paid+p_amount_usd>=v_closure.payable_usd and v_closure.status<>'paid' then
    update public.advisor_commission_closures set status='paid',paid_at=v_now,paid_by_user_id=v_uid where id=p_closure_id;
  end if;
  return v_result;
end;
$function$

