-- Migration version aligned with the applied Supabase history.
begin;
set local lock_timeout = '5s';

-- Append-only evidence. Clients can read authorized rows but cannot manufacture
-- a payment link. The private command owns the atomic money/state/link boundary.
create table public.commission_payment_operations (
  request_id uuid primary key,
  closure_id bigint not null references public.advisor_commission_closures(id),
  payment_movement_id bigint not null unique references public.money_movements(id),
  fee_movement_id bigint unique references public.money_movements(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null,
  result jsonb not null,
  check (fee_movement_id is null or fee_movement_id <> payment_movement_id)
);
create index commission_payment_operations_closure_idx on public.commission_payment_operations(closure_id);
alter table public.commission_payment_operations enable row level security;
revoke all on public.commission_payment_operations from public, anon, authenticated, service_role;
grant select on public.commission_payment_operations to authenticated;
create policy commission_payment_operations_admin_read on public.commission_payment_operations
  for select to authenticated using (exists (
    select 1 from public.user_roles r where r.user_id=(select auth.uid()) and r.role in ('admin','master')
  ));

create table public.commission_payment_reversals (
  request_id uuid primary key,
  payment_request_id uuid not null unique references public.commission_payment_operations(request_id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reason text not null check(length(btrim(reason)) between 3 and 500)
);
alter table public.commission_payment_reversals enable row level security;
revoke all on public.commission_payment_reversals from public,anon,authenticated,service_role;
grant select on public.commission_payment_reversals to authenticated;
create policy commission_payment_reversals_admin_read on public.commission_payment_reversals
  for select to authenticated using (exists(select 1 from public.user_roles r where r.user_id=(select auth.uid()) and r.role in ('admin','master')));

create function app_private.record_commission_payment_v1(
  p_request_id uuid, p_closure_id bigint, p_account_id bigint, p_amount_usd numeric,
  p_fee_native numeric, p_rate numeric, p_date date, p_reference text
) returns jsonb language plpgsql security definer set search_path=''
as $fn$
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
  select * into v_closure from public.advisor_commission_closures where id=p_closure_id for update;
  if not found then raise exception 'Liquidación no encontrada.' using errcode='22023'; end if;
  if v_closure.status<>'closed' or v_closure.snapshot#>>'{commissionWorkflow,conformity,status}' is distinct from 'confirmed'
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
  v_remaining:=round(v_closure.payable_usd-v_paid,2);
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
  if v_remaining=0 then
    update public.advisor_commission_closures set status='paid',paid_at=v_now,paid_by_user_id=v_uid where id=p_closure_id;
  end if;
  return v_result;
end;
$fn$;
revoke all on function app_private.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text) from public,anon,authenticated,service_role;
grant usage on schema app_private to authenticated;
grant execute on function app_private.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text) to authenticated;
create function public.record_commission_payment_v1(p_request_id uuid,p_closure_id bigint,p_account_id bigint,
  p_amount_usd numeric,p_fee_native numeric,p_rate numeric,p_date date,p_reference text)
returns jsonb language sql security invoker set search_path='' as $fn$
  select app_private.record_commission_payment_v1(p_request_id,p_closure_id,p_account_id,p_amount_usd,p_fee_native,p_rate,p_date,p_reference);
$fn$;
revoke all on function public.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text) from public,anon,authenticated,service_role;
grant execute on function public.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text) to authenticated;

-- Preserve evidence after a payment: legacy editing/voiding cannot silently
-- detach money from an immutable receipt. Reversal needs its own atomic command.
create function app_private.guard_commission_payment_evidence_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
  if tg_table_name='money_movements' then
    if exists(select 1 from public.commission_payment_operations where payment_movement_id=old.id or fee_movement_id=old.id) then
      if tg_op='UPDATE' and old.status='confirmed' and new.status='voided'
        and (to_jsonb(new)-array['status','voided_at','voided_by_user_id','void_reason'])=
            (to_jsonb(old)-array['status','voided_at','voided_by_user_id','void_reason'])
        and exists(select 1 from public.commission_payment_operations o join public.commission_payment_reversals r on r.payment_request_id=o.request_id
          where (o.payment_movement_id=old.id or o.fee_movement_id=old.id) and new.voided_by_user_id=r.created_by
            and new.void_reason=r.reason and new.voided_at=r.created_at) then return new; end if;
      raise exception 'Este movimiento pertenece a un abono de comisión vinculado; no puede alterarse aisladamente.' using errcode='23514';
    end if;
  elsif tg_table_name='advisor_commission_closures' then
    if exists(select 1 from public.commission_payment_operations where closure_id=old.id) then
      if tg_op='DELETE' then raise exception 'La liquidación tiene pagos vinculados.' using errcode='23514'; end if;
      if (to_jsonb(new)-array['updated_at','status','paid_at','paid_by_user_id']) is distinct from
         (to_jsonb(old)-array['updated_at','status','paid_at','paid_by_user_id']) or new.status not in ('closed','paid') then
        raise exception 'No se puede recalcular o reabrir una liquidación con pagos vinculados.' using errcode='23514';
      end if;
      if (new.status='paid') is distinct from (new.payable_usd=(select coalesce(sum(m.amount_usd_equivalent),0)
        from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id
        where o.closure_id=old.id and m.status='confirmed')) then
        raise exception 'El estado debe coincidir con los abonos vinculados.' using errcode='23514';
      end if;
    end if;
  else
    -- Deductions lock the same parent as payments before checking evidence.
    perform 1 from public.advisor_commission_closures where id=coalesce(new.closure_id,old.closure_id) for update;
    if exists(select 1 from public.commission_payment_operations where closure_id=coalesce(new.closure_id,old.closure_id))
      or (tg_op='UPDATE' and exists(select 1 from public.commission_payment_operations where closure_id=old.closure_id)) then
      raise exception 'No se pueden cambiar deducciones de una liquidación con pagos vinculados.' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$fn$;
revoke all on function app_private.guard_commission_payment_evidence_v1() from public,anon,authenticated,service_role;
create trigger guard_commission_payment_money_v1 before update or delete on public.money_movements
  for each row execute function app_private.guard_commission_payment_evidence_v1();
create trigger guard_commission_payment_closure_v1 before update or delete on public.advisor_commission_closures
  for each row execute function app_private.guard_commission_payment_evidence_v1();
create trigger guard_commission_payment_deduction_v1 before insert or update or delete on public.advisor_commission_deductions
  for each row execute function app_private.guard_commission_payment_evidence_v1();

-- A still-open old UI must not add unlinked money after canonical payments start.
-- Deferred until the receipt has been inserted by the new atomic command.
create function app_private.guard_commission_unlinked_insert_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_id_text text; v_id bigint;
begin
  if new.status<>'confirmed' or new.direction<>'outflow' or new.movement_type<>'expense_payment' then return new; end if;
  v_id_text:=(regexp_match(new.description,'^Liquidación de comisión · Cierre ([0-9]{1,18}) ·'))[1];
  if v_id_text is null then return new; end if;
  v_id:=v_id_text::bigint;
  perform 1 from public.advisor_commission_closures where id=v_id for update;
  if exists(select 1 from public.commission_payment_operations where closure_id=v_id)
    and not exists(select 1 from public.commission_payment_operations where closure_id=v_id and payment_movement_id=new.id) then
    raise exception 'Este cierre usa pagos vinculados. Actualiza la pantalla y registra el abono desde Comisiones.' using errcode='23514';
  end if;
  return new;
end;
$fn$;
revoke all on function app_private.guard_commission_unlinked_insert_v1() from public,anon,authenticated,service_role;
create constraint trigger guard_commission_unlinked_insert_v1 after insert on public.money_movements
deferrable initially deferred for each row execute function app_private.guard_commission_unlinked_insert_v1();

create function app_private.reverse_commission_payment_v1(p_request_id uuid,p_payment_request_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_uid uuid:=auth.uid(); v_op public.commission_payment_operations%rowtype;
  v_prior public.commission_payment_reversals%rowtype; v_now timestamptz:=now(); v_count integer;
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Esta acción requiere administración.' using errcode='42501';
  end if;
  if p_request_id is null or p_payment_request_id is null or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'Indica el abono y un motivo de anulación válido.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-reversal:'||p_request_id::text,0));
  select * into v_prior from public.commission_payment_reversals where request_id=p_request_id;
  if found then
    if v_prior.payment_request_id<>p_payment_request_id or v_prior.created_by<>v_uid or v_prior.reason<>btrim(p_reason) then
      raise exception 'El envío de anulación ya fue utilizado con otros datos.' using errcode='22023';
    end if;
    return jsonb_build_object('replayed',true);
  end if;
  select * into v_op from public.commission_payment_operations where request_id=p_payment_request_id;
  if not found then raise exception 'Abono vinculado no encontrado.' using errcode='22023'; end if;
  perform 1 from public.advisor_commission_closures where id=v_op.closure_id for update;
  if exists(select 1 from public.commission_payment_reversals where payment_request_id=p_payment_request_id) then
    raise exception 'El abono ya está anulado.' using errcode='22023';
  end if;
  insert into public.commission_payment_reversals(request_id,payment_request_id,created_by,created_at,reason)
    values(p_request_id,p_payment_request_id,v_uid,v_now,btrim(p_reason));
  update public.money_movements set status='voided',voided_at=v_now,voided_by_user_id=v_uid,void_reason=btrim(p_reason)
    where id in (v_op.payment_movement_id,v_op.fee_movement_id) and status='confirmed';
  get diagnostics v_count=row_count;
  if v_count<>(case when v_op.fee_movement_id is null then 1 else 2 end) then
    raise exception 'El abono y su comisión bancaria no están íntegros; no se anuló nada.' using errcode='23514';
  end if;
  update public.advisor_commission_closures set status='closed',paid_at=null,paid_by_user_id=null where id=v_op.closure_id;
  return jsonb_build_object('replayed',false);
end;
$fn$;
revoke all on function app_private.reverse_commission_payment_v1(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function app_private.reverse_commission_payment_v1(uuid,uuid,text) to authenticated;
create function public.reverse_commission_payment_v1(p_request_id uuid,p_payment_request_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path='' as $fn$
  select app_private.reverse_commission_payment_v1(p_request_id,p_payment_request_id,p_reason);
$fn$;
revoke all on function public.reverse_commission_payment_v1(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.reverse_commission_payment_v1(uuid,uuid,text) to authenticated;
create function public.admin_finance_commissions_read_v2() returns jsonb
language plpgsql stable security invoker set search_path='' as $fn$
declare v_result jsonb;
begin
  -- Reuses the exact protected snapshot reader; no historical backfill.
  v_result:=public.admin_finance_commissions_read_v1();
  return v_result || jsonb_build_object('definitionVersion','admin-finance-commissions-v2',
    'paymentLinkBasis','structural_with_legacy_references','linkedPayments',coalesce((
      select jsonb_agg(jsonb_build_object('movementId',o.payment_movement_id,'closureId',o.closure_id) order by o.payment_movement_id)
      from public.commission_payment_operations o join public.money_movements m on m.id=o.payment_movement_id
      where m.status='confirmed'
    ),'[]'::jsonb));
end;
$fn$;
revoke all on function public.admin_finance_commissions_read_v2() from public,anon,authenticated,service_role;
grant execute on function public.admin_finance_commissions_read_v2() to authenticated;
commit;
