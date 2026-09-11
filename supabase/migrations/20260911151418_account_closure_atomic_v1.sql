-- Version aligned with the applied Supabase history.
begin;
set local lock_timeout='5s';
create table public.account_closure_operations (
  request_id uuid primary key,
  closure_id bigint not null unique references public.money_account_closures(id),
  reconciliation_item_id bigint unique references public.money_account_reconciliation_items(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  request jsonb not null,
  snapshot jsonb not null,
  result jsonb not null
);
alter table public.account_closure_operations enable row level security;
revoke all on public.account_closure_operations from public,anon,authenticated,service_role;
grant select on public.account_closure_operations to authenticated;
create policy account_closure_operations_read on public.account_closure_operations for select to authenticated using(public.is_master_or_admin());
create table public.account_closure_reversals (
  closure_id bigint primary key references public.money_account_closures(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reason text not null,
  snapshot jsonb not null
);
alter table public.account_closure_reversals enable row level security;
revoke all on public.account_closure_reversals from public,anon,authenticated,service_role;
grant select on public.account_closure_reversals to authenticated;
create policy account_closure_reversals_read on public.account_closure_reversals for select to authenticated using(public.is_master_or_admin());

create function app_private.create_account_closure_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare
  v_uid uuid:=auth.uid();
  v_account_id bigint:=(p_input->>'moneyAccountId')::bigint;
  v_date date:=(p_input->>'closureDate')::date;
  v_time text:=coalesce(nullif(btrim(p_input->>'closureTime'),''),'23:59');
  v_at timestamptz;
  v_counted numeric:=(p_input->>'countedAmount')::numeric;
  v_rate numeric:=(p_input->>'exchangeRateVesPerUsd')::numeric;
  v_account public.money_accounts%rowtype;
  v_profile public.money_account_closure_profiles%rowtype;
  v_baseline public.money_account_closure_baselines%rowtype;
  v_previous public.money_account_closures%rowtype;
  v_prior public.account_closure_operations%rowtype;
  v_daily boolean;
  v_pos boolean;
  v_expected numeric;
  v_expected_usd numeric;
  v_counted_usd numeric;
  v_difference numeric;
  v_difference_usd numeric;
  v_movements jsonb;
  v_closure_id bigint;
  v_item_id bigint;
  v_result jsonb;
begin
  if v_uid is null or not public.is_master_or_admin() then
    raise exception 'Solo Master o Admin puede registrar cierres.' using errcode='42501';
  end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object' or v_account_id is null or v_account_id<=0
    or v_date is null or not isfinite(v_date) or v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or v_counted is null or not(v_counted>=0 and v_counted<=1000000000) or round(v_counted,2)<>v_counted then
    raise exception 'Revisa cuenta, fecha, hora e importe contado.' using errcode='22023';
  end if;
  v_at:=(v_date::text||' '||v_time||':00')::timestamp at time zone 'America/Caracas';
  perform pg_advisory_xact_lock(hashtextextended('account-closure:'||p_request_id::text,0));
  select * into v_prior from public.account_closure_operations where request_id=p_request_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input then
      raise exception 'Este envío ya se utilizó con otros datos; revisa el cierre antes de iniciar otro.' using errcode='22023';
    end if;
    if not exists(select 1 from public.money_account_closures where id=v_prior.closure_id and status in ('recorded','approved')) then
      raise exception 'Este cierre fue anulado; no lo reenvíes.' using errcode='22023';
    end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  select * into v_account from public.money_accounts where id=v_account_id for update;
  if not found then raise exception 'Cuenta no encontrada.' using errcode='22023'; end if;
  if v_account.currency_code='USD' then v_rate:=null;
  elsif v_account.currency_code<>'VES' then raise exception 'Moneda de cuenta no admitida.' using errcode='22023'; end if;
  if v_account.currency_code='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000)) then
    raise exception 'Indica una tasa válida para el cierre en bolívares.' using errcode='22023';
  end if;
  select * into v_profile from public.money_account_closure_profiles where money_account_id=v_account_id for share;
  v_daily:=not(v_account.account_kind::text in ('cash','pos') or coalesce(v_profile.closure_kind,'') in ('cash','pos'));
  v_pos:=v_account.account_kind::text='pos' or coalesce(v_profile.closure_kind,'')='pos';
  if exists(select 1 from public.money_account_closures where money_account_id=v_account_id and status in ('recorded','approved')
    and ((v_daily and closure_date=v_date) or (not v_daily and closure_at=v_at))) then
    raise exception 'Ya existe un cierre activo para este corte. Actualiza la pantalla.' using errcode='22023';
  end if;
  if exists(select 1 from public.money_account_closures where money_account_id=v_account_id and status in ('recorded','approved') and closure_at>v_at) then
    raise exception 'Existen cierres posteriores; revisa su secuencia antes de insertar uno anterior.' using errcode='22023';
  end if;
  select * into v_baseline from public.money_account_closure_baselines where money_account_id=v_account_id and status='active' for share;
  if v_baseline.id is not null and v_baseline.baseline_at>=v_at then
    raise exception 'El cierre debe ser posterior a la línea base vigente.' using errcode='22023';
  end if;
  select * into v_previous from public.money_account_closures where money_account_id=v_account_id and status in ('recorded','approved')
    and ((v_daily and closure_date<v_date) or (not v_daily and closure_at<v_at))
    order by case when v_daily then closure_date end desc,closure_at desc,created_at desc limit 1 for share;
  -- Preserve the existing daily vs intraday/POS cut rules, including exclusion
  -- of recognized POS settlement outflows. Do not silently redefine valuation.
  select round(coalesce(sum(case when m.direction='inflow' then m.amount else -m.amount end),0),2),
    round(coalesce(sum(case when m.direction='inflow' then m.amount_usd_equivalent else -m.amount_usd_equivalent end),0),2),
    coalesce(jsonb_agg(jsonb_build_object('id',m.id,'direction',m.direction,'type',m.movement_type,'amount',m.amount,
      'usd',m.amount_usd_equivalent,'date',m.movement_date,'recordedAt',coalesce(m.confirmed_at,m.created_at)) order by m.id),'[]')
  into v_expected,v_expected_usd,v_movements from public.money_movements m
  where m.money_account_id=v_account_id and m.status='confirmed' and m.movement_date<=v_date
    and (v_daily or m.movement_date<v_date or coalesce(m.confirmed_at,m.created_at)<=v_at)
    and (case when v_previous.id is not null then
      m.movement_date>v_previous.closure_date or (not v_daily and m.movement_date=v_previous.closure_date and coalesce(m.confirmed_at,m.created_at)>v_previous.closure_at)
      when v_baseline.id is not null then m.movement_date>v_baseline.baseline_date else true end)
    and not(v_pos and m.direction='outflow' and m.movement_type='withdrawal' and exists(
      select 1 from public.money_account_closures c where c.money_account_id=v_account_id and c.status in ('recorded','approved')
        and m.reference_code='closure-'||c.id::text));
  if not v_pos then
    v_expected:=v_expected+coalesce(v_previous.counted_amount,v_baseline.counted_amount,0);
    v_expected_usd:=v_expected_usd+coalesce(v_previous.counted_amount_usd,v_baseline.counted_amount_usd,0);
  end if;
  v_counted_usd:=round(v_counted/coalesce(v_rate,1),2);
  v_difference:=round(v_counted-v_expected,2);
  v_difference_usd:=round(v_counted_usd-v_expected_usd,2);
  if coalesce(v_profile.requires_zero_difference,false) and abs(v_difference)>0.009 then
    raise exception 'Esta cuenta debe cerrar con diferencia cero.' using errcode='22023';
  end if;
  insert into public.money_account_closures(money_account_id,closure_date,closure_at,expected_amount,counted_amount,difference_amount,
    expected_amount_usd,counted_amount_usd,difference_amount_usd,currency_code,exchange_rate_ves_per_usd,reason,notes,status,created_by_user_id)
  values(v_account_id,v_date,v_at,v_expected,v_counted,v_difference,v_expected_usd,v_counted_usd,v_difference_usd,v_account.currency_code,v_rate,
    nullif(btrim(p_input->>'reason'),''),nullif(btrim(p_input->>'notes'),''),'recorded',v_uid) returning id into v_closure_id;
  if coalesce(v_profile.allows_classified_difference,false) and abs(v_difference)>0.009 then
    insert into public.money_account_reconciliation_items(money_account_id,source_kind,source_id,item_type,direction,currency_code,
      amount,amount_usd_equivalent,operation_date,reference_code,description,status,created_by_user_id)
    values(v_account_id,'closure',v_closure_id,'other_pending',case when v_difference>0 then 'surplus' else 'shortage' end,
      v_account.currency_code::text,abs(v_difference),abs(v_difference_usd),v_date,'closure-'||v_closure_id,
      case when v_difference>0 then 'Pendiente por identificar en cierre de ' else 'Faltante pendiente por explicar en cierre de ' end||v_account.name,
      'open',v_uid) returning id into v_item_id;
  end if;
  v_result:=jsonb_build_object('closureId',v_closure_id,'reconciliationItemId',v_item_id,'expectedAmount',v_expected,
    'expectedAmountUsd',v_expected_usd,'differenceAmount',v_difference,'replayed',false);
  insert into public.account_closure_operations(request_id,closure_id,reconciliation_item_id,created_by,request,snapshot,result)
  values(p_request_id,v_closure_id,v_item_id,v_uid,p_input,jsonb_build_object('version',1,'accountId',v_account_id,'currency',v_account.currency_code,
    'closureAt',v_at,'daily',v_daily,'pos',v_pos,'profile',to_jsonb(v_profile),'previousClosure',to_jsonb(v_previous),
    'baseline',to_jsonb(v_baseline),'movements',v_movements),v_result);
  return v_result;
end;
$fn$;

create function app_private.void_account_closure_v1(p_closure_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare v_uid uuid:=auth.uid(); v_closure public.money_account_closures%rowtype; v_now timestamptz:=statement_timestamp(); v_ids bigint[]; v_item_ids bigint[];
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo Admin puede anular cierres.' using errcode='42501';
  end if;
  p_reason:=btrim(regexp_replace(coalesce(p_reason,''),'\s+',' ','g'));
  if length(p_reason) not between 6 and 500 then raise exception 'Indica un motivo claro para anular el cierre.' using errcode='22023'; end if;
  select * into v_closure from public.money_account_closures where id=p_closure_id;
  if not found then raise exception 'Cierre no encontrado.' using errcode='22023'; end if;
  perform id from public.money_accounts where id=v_closure.money_account_id or id in
    (select money_account_id from public.money_movements where reference_code='closure-'||p_closure_id) order by id for update;
  select * into v_closure from public.money_account_closures where id=p_closure_id for update;
  if exists(select 1 from public.account_closure_reversals where closure_id=p_closure_id) and v_closure.status='rejected' then
    return jsonb_build_object('closureId',p_closure_id,'replayed',true);
  end if;
  if v_closure.status not in ('recorded','approved') then raise exception 'El cierre ya no está activo.' using errcode='22023'; end if;
  if exists(select 1 from public.money_account_closures where money_account_id=v_closure.money_account_id
    and status in ('recorded','approved') and closure_at>v_closure.closure_at) then
    raise exception 'Hay cierres posteriores que dependen de este saldo. Revisa primero el último cierre.' using errcode='22023';
  end if;
  perform id from public.money_account_reconciliation_items where source_kind='closure' and source_id=p_closure_id order by id for update;
  if exists(select 1 from public.money_account_reconciliation_items where source_kind='closure' and source_id=p_closure_id and status='resolved') then
    raise exception 'Este cierre tiene una diferencia ya resuelta; revisa su resolución antes de anularlo.' using errcode='22023';
  end if;
  -- Legacy close transfers retain the existing exact reference convention. This
  -- does not certify description-based historical links as new evidence.
  with changed as (update public.money_movements set status='voided',reviewed_at=v_now,reviewed_by_user_id=v_uid,
    voided_at=v_now,voided_by_user_id=v_uid,void_reason='Cierre anulado: '||p_reason
    where reference_code='closure-'||p_closure_id and status<>'voided' returning id)
  select array_agg(id order by id) into v_ids from changed;
  with changed as (update public.money_account_reconciliation_items set status='voided',voided_at=v_now,voided_by_user_id=v_uid,void_reason=p_reason
    where source_kind='closure' and source_id=p_closure_id and status='open' returning id)
  select array_agg(id order by id) into v_item_ids from changed;
  update public.money_account_closures set status='rejected',reviewed_at=v_now,reviewed_by_user_id=v_uid,
    notes=concat_ws(E'\n',nullif(btrim(notes),''),'Anulado: '||p_reason) where id=p_closure_id;
  insert into public.account_closure_reversals(closure_id,created_by,reason,snapshot)
  values(p_closure_id,v_uid,p_reason,jsonb_build_object('previous',to_jsonb(v_closure),'movementIds',coalesce(v_ids,'{}'::bigint[]),
    'reconciliationItemIds',coalesce(v_item_ids,'{}'::bigint[])));
  return jsonb_build_object('closureId',p_closure_id,'replayed',false);
end;
$fn$;
create function public.create_account_closure_v1(p_request_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $fn$ select app_private.create_account_closure_v1(p_request_id,p_input); $fn$;
create function public.void_account_closure_v1(p_closure_id bigint,p_reason text) returns jsonb
language sql security invoker set search_path='' as $fn$ select app_private.void_account_closure_v1(p_closure_id,p_reason); $fn$;
revoke all on function app_private.create_account_closure_v1(uuid,jsonb),public.create_account_closure_v1(uuid,jsonb),
  app_private.void_account_closure_v1(bigint,text),public.void_account_closure_v1(bigint,text) from public,anon,service_role;
grant execute on function app_private.create_account_closure_v1(uuid,jsonb),public.create_account_closure_v1(uuid,jsonb),
  app_private.void_account_closure_v1(bigint,text),public.void_account_closure_v1(bigint,text) to authenticated;
commit;
