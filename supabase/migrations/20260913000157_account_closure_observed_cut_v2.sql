-- Version aligned with the applied Supabase migration history.
begin;
set local lock_timeout='5s';

-- Operation date governs the financial day; registration time only delimits
-- knowledge within that day. Older backdated operations belong to reconciliation,
-- not a new delta on top of a later observed bank balance.
create function app_private.account_movement_in_observed_cut_v2(
  p_date date, p_recorded_at timestamptz, p_anchor_at timestamptz, p_cut_at timestamptz
) returns boolean language sql stable security invoker set search_path=''
as $fn$
  select p_date <= (p_cut_at at time zone 'America/Caracas')::date
    and p_recorded_at <= p_cut_at
    and (p_anchor_at is null or (
      p_date >= (p_anchor_at at time zone 'America/Caracas')::date
      and p_recorded_at > p_anchor_at
    ));
$fn$;

-- Private calculator, no Data API grant. Preview and commit share this exact
-- projection; the command locks the account before invoking it.
create function app_private.account_closure_cut_v2(p_account_id bigint,p_at timestamptz)
returns jsonb language plpgsql stable security invoker set search_path=''
as $fn$
declare
  a public.money_accounts%rowtype;
  p public.money_account_closure_profiles%rowtype;
  b public.money_account_closure_baselines%rowtype;
  c public.money_account_closures%rowtype;
  anchor_at timestamptz;
  pos boolean;
  expected numeric;
  expected_usd numeric;
  movements jsonb;
begin
  if p_at is null or not isfinite(p_at) then raise exception 'Fecha y hora inválidas.' using errcode='22023'; end if;
  select * into a from public.money_accounts where id=p_account_id;
  if not found then raise exception 'Cuenta no encontrada.' using errcode='22023'; end if;
  select * into p from public.money_account_closure_profiles where money_account_id=a.id;
  select * into c from public.money_account_closures
    where money_account_id=a.id and status in ('recorded','approved')
      and coalesce(closure_at,created_at)<p_at
    order by coalesce(closure_at,created_at) desc,created_at desc,id desc limit 1;
  select * into b from public.money_account_closure_baselines
    where money_account_id=a.id and status='active' and baseline_at<p_at
    order by baseline_at desc,id desc limit 1;
  anchor_at:=coalesce(c.closure_at,c.created_at,b.baseline_at);
  pos:=a.account_kind::text='pos' or coalesce(p.closure_kind,'')='pos';
  select round(coalesce(sum(case when m.direction='inflow' then m.amount else -m.amount end),0),2),
    round(coalesce(sum(case when m.direction='inflow' then m.amount_usd_equivalent else -m.amount_usd_equivalent end),0),2),
    coalesce(jsonb_agg(jsonb_build_object('id',m.id,'direction',m.direction,'type',m.movement_type,'amount',m.amount,
      'usd',m.amount_usd_equivalent,'date',m.movement_date,'recordedAt',coalesce(m.confirmed_at,m.created_at)) order by m.id),'[]')
  into expected,expected_usd,movements from public.money_movements m
  where m.money_account_id=a.id and m.status='confirmed'
    and app_private.account_movement_in_observed_cut_v2(m.movement_date,coalesce(m.confirmed_at,m.created_at),anchor_at,p_at)
    and not(pos and m.direction='outflow' and m.movement_type='withdrawal' and exists(
      select 1 from public.money_account_closures s where s.money_account_id=a.id and s.status in ('recorded','approved')
        and coalesce(s.closure_at,s.created_at)<=p_at and m.reference_code='closure-'||s.id::text));
  if not pos then
    expected:=expected+coalesce(c.counted_amount,b.counted_amount,0);
    expected_usd:=expected_usd+coalesce(c.counted_amount_usd,b.counted_amount_usd,0);
  end if;
  return jsonb_build_object('moneyAccountId',a.id,'currencyCode',a.currency_code,'closureAt',p_at,
    'closureDate',(p_at at time zone 'America/Caracas')::date,'expectedAmount',expected,'expectedAmountUsd',expected_usd,
    'previousClosure',to_jsonb(c),'baseline',to_jsonb(b),'movements',movements);
end;
$fn$;

create function app_private.preview_account_closure_v2(p_account_id bigint,p_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=''
as $fn$
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo Master o Admin puede consultar cierres.' using errcode='42501';
  end if;
  return app_private.account_closure_cut_v2(p_account_id,p_at)-'previousClosure'-'baseline'-'movements';
end;
$fn$;
create function public.preview_account_closure_v2(p_account_id bigint,p_at timestamptz)
returns jsonb language sql stable security invoker set search_path=''
as $fn$ select app_private.preview_account_closure_v2(p_account_id,p_at); $fn$;
create or replace function app_private.create_account_closure_v1(p_request_id uuid,p_input jsonb)
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
  v_cut jsonb;
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
    or v_date is null or not isfinite(v_date) or v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
    or v_counted is null or not(v_counted>=0 and v_counted<=1000000000) or round(v_counted,2)<>v_counted then
    raise exception 'Revisa cuenta, fecha, hora e importe contado.' using errcode='22023';
  end if;
  v_at:=(v_date::text||' '||v_time)::timestamp at time zone 'America/Caracas';
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
  if not v_account.is_active then raise exception 'La cuenta no está activa.' using errcode='22023'; end if;
  if v_account.currency_code='USD' then v_rate:=null;
  elsif v_account.currency_code<>'VES' then raise exception 'Moneda de cuenta no admitida.' using errcode='22023'; end if;
  if v_account.currency_code='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000)) then
    raise exception 'Indica una tasa válida para el cierre en bolívares.' using errcode='22023';
  end if;
  select * into v_profile from public.money_account_closure_profiles where money_account_id=v_account_id for share;
  v_pos:=v_account.account_kind::text='pos' or coalesce(v_profile.closure_kind,'')='pos';
  if exists(select 1 from public.money_account_closures where money_account_id=v_account_id and status in ('recorded','approved')
    and closure_at=v_at) then
    raise exception 'Ya existe un cierre activo para este corte. Actualiza la pantalla.' using errcode='22023';
  end if;
  if exists(select 1 from public.money_account_closures where money_account_id=v_account_id and status in ('recorded','approved') and closure_at>v_at) then
    raise exception 'Existen cierres posteriores; revisa su secuencia antes de insertar uno anterior.' using errcode='22023';
  end if;
  select * into v_baseline from public.money_account_closure_baselines where money_account_id=v_account_id and status='active' for share;
  if v_baseline.id is not null and v_baseline.baseline_at>=v_at then
    raise exception 'El cierre debe ser posterior a la línea base vigente.' using errcode='22023';
  end if;
  v_cut:=app_private.account_closure_cut_v2(v_account_id,v_at);
  select * into v_previous from jsonb_populate_record(null::public.money_account_closures,v_cut->'previousClosure');
  v_expected:=(v_cut->>'expectedAmount')::numeric;
  v_expected_usd:=(v_cut->>'expectedAmountUsd')::numeric;
  v_movements:=v_cut->'movements';
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
  values(p_request_id,v_closure_id,v_item_id,v_uid,p_input,jsonb_build_object('version',2,'accountId',v_account_id,'currency',v_account.currency_code,
    'closureAt',v_at,'daily',false,'pos',v_pos,'profile',to_jsonb(v_profile),'previousClosure',to_jsonb(v_previous),
    'baseline',v_cut->'baseline','movements',v_movements,'cutPolicy','observed_moment_v2'),v_result);
  return v_result;
end;
$fn$;

create or replace function app_private.admin_finance_account_snapshots_v2(
  p_as_of timestamptz default pg_catalog.statement_timestamp()
)
returns table (
  account_id bigint,
  account_name text,
  currency_code text,
  account_kind text,
  institution_name text,
  owner_name text,
  is_active boolean,
  closure_kind text,
  baseline_required boolean,
  balance_native numeric,
  ledger_value_usd numeric,
  current_value_usd numeric,
  anchor_kind text,
  anchor_id bigint,
  anchor_date date,
  anchor_at timestamptz,
  anchor_amount numeric,
  latest_closure_id bigint,
  latest_closure_date date,
  latest_closure_at timestamptz,
  latest_closure_status text,
  latest_closure_difference numeric,
  latest_closure_difference_usd numeric,
  open_reconciliations integer,
  open_reconciliation_native numeric,
  open_reconciliation_usd numeric,
  orphaned_reconciliations integer,
  pending_movement_operations integer,
  pending_movement_native numeric,
  pending_movement_usd numeric,
  quality text,
  active_rate_bs_per_usd numeric,
  active_rate_effective_at timestamptz,
  calculated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with cutoff as (
    select
      coalesce(p_as_of, pg_catalog.statement_timestamp()) as as_of,
      (
        coalesce(p_as_of, pg_catalog.statement_timestamp())
          at time zone 'America/Caracas'
      )::date as local_date
  ),
  active_rate_candidates as (
    select
      rate.id,
      rate.rate_bs_per_usd,
      rate.effective_at,
      rate.created_at
    from public.exchange_rates rate
    cross join cutoff
    where rate.is_active = true
      and rate.effective_at <= cutoff.as_of
      and rate.created_at <= cutoff.as_of
  ),
  active_rate_state as (
    select pg_catalog.count(*)::integer as active_rate_count
    from active_rate_candidates
  ),
  rate_at_cutoff as (
    select rate.rate_bs_per_usd, rate.effective_at
    from active_rate_candidates rate
    order by rate.effective_at desc, rate.created_at desc, rate.id desc
    limit 1
  ),
  account_meta as (
    select
      account.id,
      account.name,
      account.currency_code::text as currency_code,
      account.account_kind::text as account_kind,
      account.institution_name,
      account.owner_name,
      account.is_active,
      profile.closure_kind,
      coalesce(profile.baseline_required, false) as baseline_required
    from public.money_accounts account
    left join public.money_account_closure_profiles profile
      on profile.money_account_id = account.id
  ),
  account_anchors as (
    select
      account.*,
      case
        when valid_closure.id is not null then 'closure'
        when valid_baseline.id is not null then 'baseline'
        else 'none'
      end as anchor_kind,
      coalesce(valid_closure.id, valid_baseline.id) as anchor_id,
      coalesce(valid_closure.closure_date, valid_baseline.baseline_date) as anchor_date,
      coalesce(valid_closure.closure_at, valid_baseline.baseline_at) as anchor_at,
      case
        when account.account_kind = 'pos' or account.closure_kind = 'pos' then 0::numeric
        else coalesce(valid_closure.counted_amount, valid_baseline.counted_amount, 0)
      end as anchor_amount,
      case
        when account.account_kind = 'pos' or account.closure_kind = 'pos' then 0::numeric
        else coalesce(valid_closure.counted_amount_usd, valid_baseline.counted_amount_usd, 0)
      end as anchor_amount_usd
    from account_meta account
    cross join cutoff
    left join lateral (
      select
        closure.id,
        closure.closure_date,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        closure.counted_amount,
        closure.counted_amount_usd
      from public.money_account_closures closure
      where closure.money_account_id = account.id
        and closure.status in ('recorded', 'approved')
        and coalesce(closure.closure_at, closure.created_at) <= cutoff.as_of
      order by
        coalesce(closure.closure_at, closure.created_at) desc,
        closure.created_at desc,
        closure.id desc
      limit 1
    ) valid_closure on true
    left join lateral (
      select
        baseline.id,
        baseline.baseline_date,
        baseline.baseline_at,
        baseline.counted_amount,
        baseline.counted_amount_usd
      from public.money_account_closure_baselines baseline
      where baseline.money_account_id = account.id
        and baseline.status = 'active'
        and baseline.baseline_at <= cutoff.as_of
      order by baseline.baseline_at desc, baseline.id desc
      limit 1
    ) valid_baseline on valid_closure.id is null
  ),
  account_position as (
    select
      account.*,
      latest_closure.id as latest_closure_id,
      latest_closure.closure_date as latest_closure_date,
      latest_closure.closure_at as latest_closure_at,
      latest_closure.status as latest_closure_status,
      latest_closure.difference_amount as latest_closure_difference,
      latest_closure.difference_amount_usd as latest_closure_difference_usd,
      pg_catalog.round(
        account.anchor_amount + coalesce(movement_delta.native_delta, 0),
        2
      ) as balance_native,
      pg_catalog.round(
        account.anchor_amount_usd + coalesce(movement_delta.usd_delta, 0),
        2
      ) as ledger_value_usd,
      coalesce(reconciliation.open_count, 0)::integer as open_reconciliations,
      pg_catalog.round(coalesce(reconciliation.native_amount, 0), 2) as open_reconciliation_native,
      pg_catalog.round(coalesce(reconciliation.usd_amount, 0), 2) as open_reconciliation_usd,
      coalesce(reconciliation.orphaned_count, 0)::integer as orphaned_reconciliations,
      coalesce(pending.pending_operations, 0)::integer as pending_movement_operations,
      pg_catalog.round(coalesce(pending.native_amount, 0), 2) as pending_movement_native,
      pg_catalog.round(coalesce(pending.usd_amount, 0), 2) as pending_movement_usd
    from account_anchors account
    cross join cutoff
    left join lateral (
      select
        closure.id,
        closure.closure_date,
        coalesce(closure.closure_at, closure.created_at) as closure_at,
        closure.status,
        closure.difference_amount,
        closure.difference_amount_usd
      from public.money_account_closures closure
      where closure.money_account_id = account.id
        and coalesce(closure.closure_at, closure.created_at) <= cutoff.as_of
      order by
        coalesce(closure.closure_at, closure.created_at) desc,
        closure.created_at desc,
        closure.id desc
      limit 1
    ) latest_closure on true
    left join lateral (
      select
        coalesce(pg_catalog.sum(case
          when movement.direction = 'inflow' then movement.amount
          when movement.direction = 'outflow' then -movement.amount
          else 0
        end), 0) as native_delta,
        coalesce(pg_catalog.sum(case
          when movement.direction = 'inflow' then movement.amount_usd_equivalent
          when movement.direction = 'outflow' then -movement.amount_usd_equivalent
          else 0
        end), 0) as usd_delta
      from public.money_movements movement
      where movement.money_account_id = account.id
        and movement.status = 'confirmed'
        and app_private.account_movement_in_observed_cut_v2(
          movement.movement_date, coalesce(movement.confirmed_at, movement.created_at),
          account.anchor_at, cutoff.as_of
        )
        and not (
          (account.account_kind = 'pos' or account.closure_kind = 'pos')
          and movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          and movement.reference_code ~ '^closure-[0-9]+$'
          and exists (
            select 1
            from public.money_account_closures settled_closure
            where settled_closure.id = substring(
              movement.reference_code from '^closure-([0-9]+)$'
            )::bigint
              and settled_closure.money_account_id = account.id
              and settled_closure.status in ('recorded', 'approved')
              and coalesce(settled_closure.closure_at, settled_closure.created_at) <= cutoff.as_of
          )
        )
    ) movement_delta on true
    left join lateral (
      select
        pg_catalog.count(*)::integer as open_count,
        coalesce(pg_catalog.sum(pg_catalog.abs(item.amount)), 0) as native_amount,
        coalesce(pg_catalog.sum(pg_catalog.abs(item.amount_usd_equivalent)), 0) as usd_amount,
        pg_catalog.count(*) filter (
          where (
            item.source_kind = 'closure'
            and not exists (
              select 1
              from public.money_account_closures source_closure
              where source_closure.id = item.source_id
                and source_closure.money_account_id = account.id
                and source_closure.status in ('recorded', 'approved')
                and coalesce(source_closure.closure_at, source_closure.created_at) <= cutoff.as_of
            )
          ) or (
            item.source_kind = 'baseline'
            and not exists (
              select 1
              from public.money_account_closure_baselines source_baseline
              where source_baseline.id = item.source_id
                and source_baseline.money_account_id = account.id
                and source_baseline.status = 'active'
                and source_baseline.baseline_at <= cutoff.as_of
            )
          )
        )::integer as orphaned_count
      from public.money_account_reconciliation_items item
      where item.money_account_id = account.id
        and item.created_at <= cutoff.as_of
        and (item.resolved_at is null or item.resolved_at > cutoff.as_of)
        and (item.voided_at is null or item.voided_at > cutoff.as_of)
    ) reconciliation on true
    left join lateral (
      select
        pg_catalog.count(distinct coalesce(
          movement.movement_group_id::text,
          'movement:' || movement.id::text
        ))::integer as pending_operations,
        coalesce(pg_catalog.sum(pg_catalog.abs(movement.amount)), 0) as native_amount,
        coalesce(pg_catalog.sum(pg_catalog.abs(movement.amount_usd_equivalent)), 0) as usd_amount
      from public.money_movements movement
      where movement.money_account_id = account.id
        and movement.created_at <= cutoff.as_of
        and (movement.confirmed_at is null or movement.confirmed_at > cutoff.as_of)
        and (movement.rejected_at is null or movement.rejected_at > cutoff.as_of)
        and (movement.voided_at is null or movement.voided_at > cutoff.as_of)
    ) pending on true
  )
  select
    account.id as account_id,
    account.name as account_name,
    account.currency_code,
    account.account_kind,
    account.institution_name,
    account.owner_name,
    account.is_active,
    account.closure_kind,
    account.baseline_required,
    account.balance_native,
    account.ledger_value_usd,
    case
      when account.currency_code = 'USD' then account.balance_native
      when rate_state.active_rate_count = 1 and rate.rate_bs_per_usd > 0 then pg_catalog.round(
        account.balance_native / rate.rate_bs_per_usd,
        2
      )
      else null
    end as current_value_usd,
    account.anchor_kind,
    account.anchor_id,
    account.anchor_date,
    account.anchor_at,
    pg_catalog.round(account.anchor_amount, 2) as anchor_amount,
    account.latest_closure_id,
    account.latest_closure_date,
    account.latest_closure_at,
    account.latest_closure_status,
    account.latest_closure_difference,
    account.latest_closure_difference_usd,
    account.open_reconciliations,
    account.open_reconciliation_native,
    account.open_reconciliation_usd,
    account.orphaned_reconciliations,
    account.pending_movement_operations,
    account.pending_movement_native,
    account.pending_movement_usd,
    case
      when account.currency_code = 'VES' and rate_state.active_rate_count <> 1 then 'Q4_blocked'
      when account.anchor_kind = 'none' then 'Q3_incomplete'
      when account.account_kind = 'pos' or account.closure_kind = 'pos' then 'Q2_derived'
      else 'Q1_exact'
    end as quality,
    rate.rate_bs_per_usd as active_rate_bs_per_usd,
    rate.effective_at as active_rate_effective_at,
    cutoff.as_of as calculated_at
  from account_position account
  cross join cutoff
  cross join active_rate_state rate_state
  left join rate_at_cutoff rate on true;
$function$;

revoke all on function app_private.admin_finance_account_snapshots_v2(timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.admin_finance_account_snapshots_v2(timestamptz)
  is 'Current account positions with canonical timestamp-ordered closure anchors, baseline fallback, strict active-rate valuation, and operational exceptions kept separate from confirmed balance.';


-- Session-scoped bridge for the existing Master panel: same balance as Admin.
create function app_private.account_balance_snapshots_v2(p_account_ids bigint[])
returns jsonb language plpgsql stable security definer set search_path=''
as $fn$
begin
  if auth.uid() is null or not public.is_master_or_admin() then
    raise exception 'Solo Master o Admin puede consultar saldos.' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'moneyAccountId',s.account_id,'currencyCode',s.currency_code,'balanceNative',s.balance_native,
    'balanceUsd',s.ledger_value_usd,'anchorKind',s.anchor_kind,'anchorDate',s.anchor_date,
    'anchorAt',s.anchor_at,'anchorAmount',s.anchor_amount,'calculatedAt',s.calculated_at) order by s.account_id)
    from app_private.admin_finance_account_snapshots_v2(statement_timestamp()) s
    where p_account_ids is null or s.account_id=any(p_account_ids)), '[]'::jsonb);
end;
$fn$;
create function public.account_balance_snapshots_v2(p_account_ids bigint[] default null)
returns jsonb language sql stable security invoker set search_path=''
as $fn$ select app_private.account_balance_snapshots_v2(p_account_ids); $fn$;

revoke all on function app_private.account_movement_in_observed_cut_v2(date,timestamptz,timestamptz,timestamptz),
  app_private.account_closure_cut_v2(bigint,timestamptz) from public,anon,authenticated,service_role;
revoke all on function app_private.preview_account_closure_v2(bigint,timestamptz),public.preview_account_closure_v2(bigint,timestamptz),
  app_private.account_balance_snapshots_v2(bigint[]),public.account_balance_snapshots_v2(bigint[]) from public,anon,service_role;
grant execute on function app_private.preview_account_closure_v2(bigint,timestamptz),public.preview_account_closure_v2(bigint,timestamptz),
  app_private.account_balance_snapshots_v2(bigint[]),public.account_balance_snapshots_v2(bigint[]) to authenticated;
-- Existing create command retains its restricted grants; no historical DML.
commit;
