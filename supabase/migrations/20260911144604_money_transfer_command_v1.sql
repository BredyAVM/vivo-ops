-- Version aligned with the applied Supabase history.
begin;
set local lock_timeout='5s';
create table public.money_transfer_operations (
  request_id uuid primary key,
  source_movement_id bigint not null unique references public.money_movements(id),
  target_movement_id bigint not null unique references public.money_movements(id),
  fee_movement_id bigint unique references public.money_movements(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null,
  result jsonb not null,
  check(source_movement_id<>target_movement_id and
    (fee_movement_id is null or fee_movement_id not in (source_movement_id,target_movement_id)))
);
alter table public.money_transfer_operations enable row level security;
revoke all on public.money_transfer_operations from public,anon,authenticated,service_role;
grant select on public.money_transfer_operations to authenticated;
create policy money_transfer_operations_read on public.money_transfer_operations for select to authenticated
  using(public.is_master_or_admin());

create function app_private.create_money_transfer_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare
  v_uid uuid:=auth.uid();
  v_prior public.money_transfer_operations%rowtype;
  v_source public.money_accounts%rowtype;
  v_target public.money_accounts%rowtype;
  v_source_id bigint:=(p_input->>'sourceMoneyAccountId')::bigint;
  v_target_id bigint:=(p_input->>'targetMoneyAccountId')::bigint;
  v_amount numeric:=(p_input->>'sourceAmount')::numeric;
  v_target_amount numeric:=(p_input->>'targetAmount')::numeric;
  v_fee numeric:=coalesce((p_input->>'feeAmount')::numeric,0);
  v_rate numeric:=(p_input->>'sourceExchangeRateVesPerUsd')::numeric;
  v_target_rate numeric:=(p_input->>'targetExchangeRateVesPerUsd')::numeric;
  v_date date:=(p_input->>'movementDate')::date;
  v_description text:=coalesce(nullif(btrim(p_input->>'description'),''),'Traspaso entre cuentas');
  v_source_movement bigint;
  v_target_movement bigint;
  v_fee_movement bigint;
  v_now timestamptz:=statement_timestamp();
  v_result jsonb;
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo administración puede registrar traspasos.' using errcode='42501';
  end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object'
    or v_source_id is null or v_target_id is null or v_source_id<=0 or v_target_id<=0 or v_source_id=v_target_id
    or v_amount is null or not(v_amount>0 and v_amount<=1000000000) or round(v_amount,2)<>v_amount
    or v_target_amount is null or not(v_target_amount>0 and v_target_amount<=1000000000) or round(v_target_amount,2)<>v_target_amount
    or not(v_fee>=0 and v_fee<=1000000000) or round(v_fee,2)<>v_fee
    or v_date is null or not isfinite(v_date) then
    raise exception 'Revisa cuentas, importes y fecha del traspaso.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('money-transfer:'||p_request_id::text,0));
  select * into v_prior from public.money_transfer_operations where request_id=p_request_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input then
      raise exception 'Este envío ya se utilizó con otros datos. Revisa el traspaso antes de iniciar otro.' using errcode='22023';
    end if;
    if exists(select 1 from public.money_movements where id in (v_prior.source_movement_id,v_prior.target_movement_id,v_prior.fee_movement_id)
      and status<>'confirmed') then raise exception 'Este traspaso fue anulado; no lo reenvíes.' using errcode='22023'; end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  perform id from public.money_accounts where id in (v_source_id,v_target_id) order by id for update;
  select * into v_source from public.money_accounts where id=v_source_id;
  select * into v_target from public.money_accounts where id=v_target_id;
  if v_source.id is null or v_target.id is null or not v_source.is_active or not v_target.is_active then
    raise exception 'Ambas cuentas deben existir y estar activas.' using errcode='22023';
  end if;
  if v_source.currency_code='USD' then v_rate:=null;
  elsif v_source.currency_code<>'VES' then raise exception 'Moneda de origen no admitida.' using errcode='22023'; end if;
  if v_target.currency_code='USD' then v_target_rate:=null;
  elsif v_target.currency_code<>'VES' then raise exception 'Moneda de destino no admitida.' using errcode='22023'; end if;
  if (v_source.currency_code='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000)))
    or (v_target.currency_code='VES' and (v_target_rate is null or not(v_target_rate>0 and v_target_rate<=1000000000))) then
    raise exception 'Indica una tasa válida para cada cuenta en bolívares.' using errcode='22023';
  end if;
  if round(v_amount/coalesce(v_rate,1),2)<=0 or round(v_target_amount/coalesce(v_target_rate,1),2)<=0
    or (v_fee>0 and round(v_fee/coalesce(v_rate,1),2)<=0) then
    raise exception 'Un importe convertido es menor a 0,01 USD.' using errcode='22023';
  end if;
  insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,approval_required,
    direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
    reference_code,counterparty_name,description,notes,movement_group_id)
  values(v_date,v_uid,v_now,v_uid,'confirmed',false,'outflow','withdrawal',v_source_id,v_source.currency_code,v_amount,v_rate,
    round(v_amount/coalesce(v_rate,1),2),nullif(btrim(p_input->>'referenceCode'),''),nullif(btrim(p_input->>'counterpartyName'),''),
    'Traspaso salida · '||v_description,nullif(btrim(p_input->>'notes'),''),p_request_id) returning id into v_source_movement;
  insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,approval_required,
    direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
    reference_code,counterparty_name,description,notes,movement_group_id)
  values(v_date,v_uid,v_now,v_uid,'confirmed',false,'inflow','other_income',v_target_id,v_target.currency_code,v_target_amount,v_target_rate,
    round(v_target_amount/coalesce(v_target_rate,1),2),nullif(btrim(p_input->>'referenceCode'),''),nullif(btrim(p_input->>'counterpartyName'),''),
    'Traspaso entrada · '||v_description,nullif(btrim(p_input->>'notes'),''),p_request_id) returning id into v_target_movement;
  if v_fee>0 then
    insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,approval_required,
      direction,movement_type,money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,
      reference_code,counterparty_name,description,notes,movement_group_id)
    values(v_date,v_uid,v_now,v_uid,'confirmed',false,'outflow','fee_charge',v_source_id,v_source.currency_code,v_fee,v_rate,
      round(v_fee/coalesce(v_rate,1),2),nullif(btrim(p_input->>'referenceCode'),''),nullif(btrim(p_input->>'counterpartyName'),''),
      'Comisión · '||v_description,nullif(btrim(p_input->>'notes'),''),p_request_id) returning id into v_fee_movement;
  end if;
  v_result:=jsonb_build_object('movementGroupId',p_request_id,'sourceMovementId',v_source_movement,'targetMovementId',v_target_movement,
    'feeMovementId',v_fee_movement,'replayed',false);
  insert into public.money_transfer_operations(request_id,source_movement_id,target_movement_id,fee_movement_id,created_by,request,result)
  values(p_request_id,v_source_movement,v_target_movement,v_fee_movement,v_uid,p_input,v_result);
  return v_result;
end;
$fn$;
create function public.create_money_transfer_v1(p_request_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path=''
as $fn$ select app_private.create_money_transfer_v1(p_request_id,p_input); $fn$;
revoke all on function app_private.create_money_transfer_v1(uuid,jsonb),public.create_money_transfer_v1(uuid,jsonb) from public,anon,service_role;
grant execute on function app_private.create_money_transfer_v1(uuid,jsonb),public.create_money_transfer_v1(uuid,jsonb) to authenticated;

-- New certified transfers cannot be altered into unrelated money or partially
-- voided, including through an older administrative action or service client.
create function app_private.guard_money_transfer_evidence_v1()
returns trigger language plpgsql security definer set search_path=''
as $fn$
declare v_op public.money_transfer_operations%rowtype;
begin
  select * into v_op from public.money_transfer_operations
    where request_id=old.movement_group_id or old.id in (source_movement_id,target_movement_id,fee_movement_id);
  if not found then return case when tg_op='DELETE' then old else new end; end if;
  if tg_op='DELETE' then raise exception 'Un traspaso certificado se anula, no se elimina.' using errcode='22023'; end if;
  if (to_jsonb(new)-array['status','voided_at','voided_by_user_id','void_reason','reviewed_at','reviewed_by_user_id'])
    is distinct from (to_jsonb(old)-array['status','voided_at','voided_by_user_id','void_reason','reviewed_at','reviewed_by_user_id'])
    or old.status<>'confirmed' or new.status<>'voided' or new.voided_at is null
    or new.voided_by_user_id is distinct from auth.uid() or length(btrim(coalesce(new.void_reason,'')))<6
    or not exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin') then
    raise exception 'Solo se permite anular el traspaso completo con motivo y autorización.' using errcode='42501';
  end if;
  return new;
end;
$fn$;
create trigger guard_money_transfer_evidence_v1 before update or delete on public.money_movements
for each row execute function app_private.guard_money_transfer_evidence_v1();
create function app_private.check_money_transfer_complete_v1()
returns trigger language plpgsql security definer set search_path=''
as $fn$
declare v_op public.money_transfer_operations%rowtype; v_count integer; v_states integer;
begin
  select * into v_op from public.money_transfer_operations where request_id=new.movement_group_id;
  if not found then return new; end if;
  select count(*),count(distinct status) into v_count,v_states from public.money_movements where movement_group_id=v_op.request_id;
  if v_count<>(case when v_op.fee_movement_id is null then 2 else 3 end) or v_states<>1
    or exists(select 1 from public.money_movements where movement_group_id=v_op.request_id
      and id not in (v_op.source_movement_id,v_op.target_movement_id,coalesce(v_op.fee_movement_id,-1))) then
    raise exception 'Origen, destino y comisión deben conservarse y anularse juntos.' using errcode='23514';
  end if;
  return new;
end;
$fn$;
create constraint trigger check_money_transfer_complete_v1 after insert or update on public.money_movements
deferrable initially deferred for each row execute function app_private.check_money_transfer_complete_v1();
revoke all on function app_private.guard_money_transfer_evidence_v1(),app_private.check_money_transfer_complete_v1() from public,anon,authenticated,service_role;
commit;
