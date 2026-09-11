-- Version aligned with applied Supabase migration history.
begin;
set local lock_timeout='5s';

create table public.client_fund_payout_operations (
  request_id uuid primary key,
  order_id bigint not null references public.orders(id),
  client_id bigint not null references public.clients(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  paid_usd numeric not null check(paid_usd>0 and paid_usd<=1000000000),
  fund_debit_usd numeric not null check(fund_debit_usd>0),
  difference_usd numeric not null check(difference_usd>=0),
  request jsonb not null,
  result jsonb not null,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  check(paid_usd=fund_debit_usd+difference_usd)
);
create index client_fund_payout_order_idx on public.client_fund_payout_operations(order_id);
create index client_fund_payout_client_idx on public.client_fund_payout_operations(client_id);
alter table public.client_fund_payout_operations enable row level security;
revoke all on public.client_fund_payout_operations from public,anon,authenticated,service_role;
grant select on public.client_fund_payout_operations to authenticated;
create policy client_fund_payout_read on public.client_fund_payout_operations for select to authenticated
  using(exists(select 1 from public.orders o where o.id=order_id));

create function app_private.settle_client_fund_payout_v1(p_request_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_uid uuid:=auth.uid(); v_now timestamptz:=statement_timestamp();
  v_order public.orders%rowtype; v_prior public.client_fund_payout_operations%rowtype;
  v_line jsonb; v_lines jsonb:=p_input->'lines'; v_ids jsonb:='[]';
  v_account bigint; v_currency public.currency_code; v_amount numeric; v_rate numeric; v_usd numeric;
  v_total numeric:=0; v_balance numeric; v_fund numeric; v_difference numeric; v_expected numeric;
  v_remaining numeric; v_part numeric; v_id bigint; v_event bigint; v_payload jsonb; v_result jsonb; v_state record;
begin
  if v_uid is null or not public.is_master_or_admin() then raise exception 'Solo administración puede entregar el fondo.' using errcode='42501'; end if;
  if p_request_id is null or jsonb_typeof(p_input) is distinct from 'object'
    or jsonb_typeof(v_lines) is distinct from 'array' then raise exception 'Solicitud inválida.' using errcode='22023'; end if;
  if jsonb_array_length(v_lines) not between 1 and 12 then raise exception 'Agrega entre 1 y 12 líneas.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fund-payout:'||p_request_id::text,0));
  select * into v_prior from public.client_fund_payout_operations where request_id=p_request_id;
  if found then
    if v_prior.created_by<>v_uid or v_prior.request<>p_input or v_prior.voided_at is not null then
      raise exception 'Esta solicitud ya fue utilizada con otros datos o anulada.' using errcode='22023'; end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  select * into v_order from public.orders where id=(p_input->>'orderId')::bigint for update;
  if not found or v_order.client_id is null or v_order.status='cancelled' then raise exception 'Se necesita una orden vigente con cliente.' using errcode='22023'; end if;
  perform id from public.money_accounts where id in (select (value->>'moneyAccountId')::bigint from jsonb_array_elements(v_lines)) order by id for update;
  select fund_balance_usd into v_balance from public.clients where id=v_order.client_id for update;
  if not found or coalesce(v_balance,0)<=0 then raise exception 'El cliente no tiene saldo a favor para devolver.' using errcode='22023'; end if;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_account:=(v_line->>'moneyAccountId')::bigint; v_currency:=(v_line->>'currencyCode')::public.currency_code;
    v_amount:=(v_line->>'amount')::numeric; v_rate:=(v_line->>'exchangeRateVesPerUsd')::numeric;
    if v_currency is null or v_currency not in ('USD','VES') or not exists(select 1 from public.money_accounts where id=v_account and is_active and currency_code=v_currency)
      or v_amount is null or not(v_amount>0 and v_amount<=1000000000) or round(v_amount,2)<>v_amount
      or (v_currency='USD' and v_rate is not null)
      or (v_currency='VES' and (v_rate is null or not(v_rate>0 and v_rate<=1000000000))) then
      raise exception 'Cuenta, moneda, monto o tasa inválidos.' using errcode='22023'; end if;
    v_usd:=round(v_amount/coalesce(v_rate,1),2);
    if not(v_usd>0 and v_usd<=1000000000) then raise exception 'Monto convertido inválido.' using errcode='22023'; end if;
    v_total:=v_total+v_usd;
  end loop;
  if v_total>1000000000 then raise exception 'Monto total inválido.' using errcode='22023'; end if;
  v_fund:=least(v_balance,v_total); v_difference:=round(v_total-v_fund,2);
  v_expected:=coalesce((p_input->>'expectedDifferenceUsd')::numeric,0);
  if v_expected is distinct from v_difference then
    raise exception 'El saldo cambió. Actualiza la orden y confirma la diferencia por cobrar de USD %.',v_difference using errcode='22023'; end if;
  select * into v_state from public.get_order_financial_state(v_order.id);
  if v_difference>v_state.confirmed_paid_usd then raise exception 'El cambio adicional supera lo abonado a esta orden.' using errcode='22023'; end if;
  update public.clients set fund_balance_usd=round(fund_balance_usd-v_fund,2) where id=v_order.client_id;
  v_remaining:=v_fund;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_account:=(v_line->>'moneyAccountId')::bigint; v_currency:=(v_line->>'currencyCode')::public.currency_code;
    v_amount:=(v_line->>'amount')::numeric; v_rate:=(v_line->>'exchangeRateVesPerUsd')::numeric;
    v_usd:=round(v_amount/coalesce(v_rate,1),2); v_part:=least(v_remaining,v_usd); v_remaining:=v_remaining-v_part;
    insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,status,direction,movement_type,
      money_account_id,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,description,notes,order_id,movement_group_id)
    values((v_now at time zone 'America/Caracas')::date,v_uid,v_now,v_uid,'confirmed','outflow','withdrawal',v_account,v_currency,v_amount,v_rate,v_usd,
      'Entrega de fondo y cambio · orden '||v_order.id,coalesce(v_line->>'notes',p_input->>'notes'),v_order.id,p_request_id) returning id into v_id;
    v_ids:=v_ids||jsonb_build_array(v_id);
    if v_part>0 then
      insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,money_account_id,order_id,reason_code,notes,created_by_user_id,movement_group_id)
      values(v_order.client_id,'debit',v_currency::text,round(v_part*coalesce(v_rate,1),2),v_part,v_account,v_order.id,'client_fund_payout',p_input->>'notes',v_uid,p_request_id);
    end if;
  end loop;
  v_payload:=jsonb_build_object('movement_group_id',p_request_id,'movement_ids',v_ids,'paid_usd',v_total,'fund_debit_usd',v_fund,
    'difference_usd',v_difference,'pending_before_usd',v_state.pending_usd,'pending_after_usd',greatest(0,v_state.pending_usd+v_difference-v_state.overpaid_usd));
  insert into public.order_events(order_id,event_type,event_group,title,message,actor_user_id,payload)
  values(v_order.id,'client_fund_payout','payment','Cambio entregado','Entregado USD '||v_total||'; diferencia por cobrar USD '||v_difference,v_uid,v_payload);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,actor_user_id,payload)
  values(v_order.id,v_order.order_number,'client_fund_payout','payment','Cambio entregado','Entregado USD '||v_total||'; diferencia por cobrar USD '||v_difference,v_uid,v_payload) returning id into v_event;
  v_result:=jsonb_build_object('groupId',p_request_id,'orderId',v_order.id,'movementIds',v_ids,'differenceUsd',v_difference,'eventId',v_event,'replayed',false);
  insert into public.client_fund_payout_operations(request_id,order_id,client_id,created_by,paid_usd,fund_debit_usd,difference_usd,request,result)
    values(p_request_id,v_order.id,v_order.client_id,v_uid,v_total,v_fund,v_difference,p_input,v_result);
  return v_result;
end $fn$;
create function public.settle_client_fund_payout_v1(p_request_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$select app_private.settle_client_fund_payout_v1(p_request_id,p_input)$$;
revoke all on function app_private.settle_client_fund_payout_v1(uuid,jsonb),public.settle_client_fund_payout_v1(uuid,jsonb) from public,anon,service_role;
grant execute on function app_private.settle_client_fund_payout_v1(uuid,jsonb),public.settle_client_fund_payout_v1(uuid,jsonb) to authenticated;

create function app_private.void_client_fund_payout_v1(p_group_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_op public.client_fund_payout_operations%rowtype; v_uid uuid:=auth.uid(); v_now timestamptz:=statement_timestamp(); v_result jsonb;
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then raise exception 'Solo admin puede anular.' using errcode='42501'; end if;
  select * into v_op from public.client_fund_payout_operations where request_id=p_group_id;
  if not found then return null; end if;
  if length(btrim(coalesce(p_reason,''))) not between 6 and 500 then raise exception 'Indica un motivo claro.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fund-payout:'||p_group_id::text,0));
  perform id from public.orders where id=v_op.order_id for update;
  perform id from public.money_accounts where id in(select money_account_id from public.money_movements where movement_group_id=p_group_id) order by id for update;
  perform id from public.money_movements where movement_group_id=p_group_id order by id for update;
  perform id from public.clients where id=v_op.client_id for update;
  select * into v_op from public.client_fund_payout_operations where request_id=p_group_id for update;
  v_result:=jsonb_build_object('movementIds',v_op.result->'movementIds','paymentReportIds','[]'::jsonb);
  if v_op.voided_at is not null then return v_result||jsonb_build_object('replayed',true); end if;
  update public.client_fund_payout_operations set voided_at=v_now,voided_by=v_uid,void_reason=p_reason where request_id=p_group_id;
  update public.money_movements set status='voided',voided_at=v_now,voided_by_user_id=v_uid,void_reason=p_reason where movement_group_id=p_group_id;
  update public.clients set fund_balance_usd=round(fund_balance_usd+v_op.fund_debit_usd,2) where id=v_op.client_id;
  insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,notes,created_by_user_id,movement_group_id)
    values(v_op.client_id,'credit','USD',v_op.fund_debit_usd,v_op.fund_debit_usd,v_op.order_id,'client_fund_payout_reversal',p_reason,v_uid,p_group_id);
  insert into public.order_events(order_id,event_type,event_group,title,message,actor_user_id,payload)
    values(v_op.order_id,'client_fund_payout_voided','payment','Cambio anulado',p_reason,v_uid,v_op.result);
  insert into public.order_timeline_events(order_id,event_type,event_group,title,message,actor_user_id,payload)
    values(v_op.order_id,'client_fund_payout_voided','payment','Cambio anulado',p_reason,v_uid,v_op.result);
  return v_result||jsonb_build_object('replayed',false);
end $fn$;
revoke all on function app_private.void_client_fund_payout_v1(uuid,text) from public,anon,authenticated,service_role;

create function app_private.guard_client_fund_payout_money_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_op public.client_fund_payout_operations%rowtype;
begin
  select * into v_op from public.client_fund_payout_operations where request_id=old.movement_group_id;
  if found then
    if tg_op='DELETE' then raise exception 'La entrega certificada no se puede eliminar.' using errcode='23514'; end if;
    if (to_jsonb(new)-array['status','voided_at','voided_by_user_id','void_reason']) is distinct from
       (to_jsonb(old)-array['status','voided_at','voided_by_user_id','void_reason'])
       or new.status<>'voided' or v_op.voided_at is null or new.voided_by_user_id is distinct from v_op.voided_by
       or new.voided_at is distinct from v_op.voided_at or new.void_reason is distinct from v_op.void_reason then
      raise exception 'Anula la entrega completa; no se pueden modificar sus movimientos.' using errcode='23514'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $fn$;
create trigger guard_client_fund_payout_money before update or delete on public.money_movements for each row execute function app_private.guard_client_fund_payout_money_v1();
revoke all on function app_private.guard_client_fund_payout_money_v1() from public,anon,authenticated,service_role;

-- Updated canonical readers and payment confirmation follow below.
create function app_private.check_client_fund_payout_group_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_group uuid; v_op public.client_fund_payout_operations%rowtype; v_ids jsonb;
begin
  for v_group in select distinct g from unnest(array[case when tg_op<>'INSERT' then old.movement_group_id end,
    case when tg_op<>'DELETE' then new.movement_group_id end]) g where g is not null loop
    select * into v_op from public.client_fund_payout_operations where request_id=v_group;
    if found then
      select jsonb_agg(id order by id) into v_ids from public.money_movements where movement_group_id=v_group;
      if v_ids is distinct from v_op.result->'movementIds' or exists(select 1 from public.money_movements where movement_group_id=v_group and
        status::text<>case when v_op.voided_at is null then 'confirmed' else 'voided' end) then
        raise exception 'La entrega debe conservar todos sus movimientos y un estado único.' using errcode='23514'; end if;
    end if;
  end loop;
  return null;
end $fn$;
create constraint trigger check_client_fund_payout_group after insert or update or delete on public.money_movements
  deferrable initially deferred for each row execute function app_private.check_client_fund_payout_group_v1();
revoke all on function app_private.check_client_fund_payout_group_v1() from public,anon,authenticated,service_role;

-- Authorized order owners may read confirmation evidence used by their financial state.
create policy client_fund_movements_advisor_read on public.client_fund_movements for select to authenticated
using(public.has_role('advisor') and exists(select 1 from public.orders o where o.id=client_fund_movements.order_id and o.attributed_advisor_id=auth.uid()));
create policy payment_confirmation_advisor_read on public.payment_confirmation_operations for select to authenticated
using(public.has_role('advisor') and exists(select 1 from public.orders o where o.id=payment_confirmation_operations.order_id and o.attributed_advisor_id=auth.uid()));
CREATE OR REPLACE FUNCTION public.get_order_financial_state_block3(p_order_id bigint, p_operation_date date DEFAULT NULL::date, p_active_bs_rate numeric DEFAULT NULL::numeric)
 RETURNS TABLE(order_id bigint, order_number text, order_status text, total_usd numeric, total_bs numeric, snapshot_rate_bs_per_usd numeric, confirmed_paid_usd numeric, confirmed_paid_bs_snapshot numeric, pending_reports_usd numeric, pending_reports_bs_snapshot numeric, rejected_reports_usd numeric, voided_movements_count integer, rejected_reports_count integer, pending_reports_count integer, confirmed_reports_count integer, client_fund_used_usd numeric, pending_usd numeric, pending_bs numeric, overpaid_usd numeric, collection_mode text, payment_status text, delivery_reference_date date, effective_operation_date date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with confirmed_report_input as (
  -- Preserve reported evidence; only new certified confirmations substitute the
  -- actual movement for snapshot coverage. Historical reports are not revalued.
  select r.order_id,r.status,r.operation_date,r.created_at,
    coalesce(m.currency_code,r.reported_currency_code) as reported_currency_code,
    coalesce(m.amount,r.reported_amount) as reported_amount,
    coalesce(m.amount_usd_equivalent,r.reported_amount_usd_equivalent) as reported_amount_usd_equivalent
  from public.payment_reports r
  left join public.payment_confirmation_operations op on op.report_id=r.id
  left join public.money_movements m on m.id=op.movement_id
    and r.status='confirmed' and m.status='confirmed'
),
base_order_raw as (
  select
    order_row.id,
    order_row.order_number,
    order_row.status,
    order_row.extra_fields,
    round(coalesce(
      nullif(order_row.extra_fields->'pricing'->>'total_usd', '')::numeric,
      order_row.total_usd,
      0
    ), 2) as effective_total_usd,
    round(coalesce(
      nullif(order_row.extra_fields->'pricing'->>'total_bs', '')::numeric,
      order_row.total_bs_snapshot,
      0
    ), 2) as effective_total_bs,
    nullif(order_row.extra_fields->'pricing'->>'fx_rate', '')::numeric
      as stored_snapshot_rate,
    round(coalesce(
      nullif(order_row.extra_fields->'payment'->>'client_fund_used_usd', '')::numeric,
      0
    ), 2) as stored_client_fund_used_usd,
    case
      when order_row.extra_fields->'delivery'->>'completed_at' is not null
        and btrim(order_row.extra_fields->'delivery'->>'completed_at') <> ''
        then (
          (order_row.extra_fields->'delivery'->>'completed_at')::timestamptz
          at time zone 'America/Caracas'
        )::date
      when order_row.extra_fields->'schedule'->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
        then (order_row.extra_fields->'schedule'->>'date')::date
      else null
    end as delivery_reference_date
  from public.orders order_row
  where order_row.id = p_order_id
),
base_order as (
  select
    raw.*,
    case
      when coalesce(raw.stored_snapshot_rate, 0) > 0
        then round(raw.stored_snapshot_rate, 6)
      when raw.effective_total_usd > 0 and raw.effective_total_bs > 0
        then round(raw.effective_total_bs / raw.effective_total_usd, 6)
      else 0
    end as effective_snapshot_rate
  from base_order_raw raw
),
effective_dates as (
  select
    base.*,
    coalesce(
      p_operation_date,
      (now() at time zone 'America/Caracas')::date
    ) as effective_operation_date
  from base_order base
),
movement_totals as (
  select
    movement.order_id,
    round(sum(
      case
        when movement.status = 'confirmed' and movement.direction = 'inflow'
          then coalesce(movement.amount_usd_equivalent, 0)
        when movement.status = 'confirmed'
          and movement.direction = 'outflow'
          and movement.movement_type = 'change_given'
          then -coalesce(movement.amount_usd_equivalent, 0)
        else 0
      end
    )::numeric, 2) as confirmed_paid_usd,
    count(*) filter (where movement.status = 'voided')::integer
      as voided_movements_count
  from public.money_movements movement
  where movement.order_id = p_order_id
  group by movement.order_id
),
report_totals as (
  select
    report.order_id,
    round(coalesce(sum(
      coalesce(report.reported_amount_usd_equivalent, 0)
    ) filter (where report.status = 'pending'), 0)::numeric, 2)
      as pending_reports_usd,
    round(coalesce(sum(
      coalesce(report.reported_amount_usd_equivalent, 0)
    ) filter (where report.status = 'rejected'), 0)::numeric, 2)
      as rejected_reports_usd,
    count(*) filter (where report.status = 'pending')::integer
      as pending_reports_count,
    count(*) filter (where report.status = 'confirmed')::integer
      as confirmed_reports_count,
    count(*) filter (where report.status = 'rejected')::integer
      as rejected_reports_count
  from confirmed_report_input report
  where report.order_id = p_order_id
  group by report.order_id
),
confirmed_report_bs as (
  select
    report.order_id,
    round(sum(
      case
        when report.status <> 'confirmed' then 0
        when upper(coalesce(report.reported_currency_code::text, '')) = 'VES'
          then coalesce(report.reported_amount, 0)
        when dates.effective_snapshot_rate > 0
          then coalesce(report.reported_amount_usd_equivalent, 0)
            * dates.effective_snapshot_rate
        else 0
      end
    )::numeric, 2) as confirmed_report_paid_bs_snapshot,
    round(sum(
      case
        when report.status <> 'confirmed' then 0
        else coalesce(report.reported_amount_usd_equivalent, 0)
      end
    )::numeric, 2) as confirmed_report_paid_usd
  from confirmed_report_input report
  join effective_dates dates on dates.id = report.order_id
  where report.order_id = p_order_id
  group by report.order_id
),
pending_report_bs as (
  select
    report.order_id,
    round(sum(
      case
        when report.status <> 'pending' then 0
        when upper(coalesce(report.reported_currency_code::text, '')) = 'VES'
          then coalesce(report.reported_amount, 0)
        when dates.effective_snapshot_rate > 0
          then coalesce(report.reported_amount_usd_equivalent, 0)
            * dates.effective_snapshot_rate
        else 0
      end
    )::numeric, 2) as pending_reports_bs_snapshot
  from confirmed_report_input report
  join effective_dates dates on dates.id = report.order_id
  where report.order_id = p_order_id
  group by report.order_id
),
fund_ledger_for_order as (
  select
    fund.order_id,
    round(sum(
      case
        when fund.movement_type = 'debit'
          and coalesce(fund.reason_code, '') = 'order_fund_applied'
          then coalesce(fund.amount_usd, 0)
        when fund.movement_type = 'credit'
          and coalesce(fund.reason_code, '') = 'order_fund_restore'
          then -coalesce(fund.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_used_usd_from_ledger,
    round(sum(
      case
        when fund.movement_type = 'credit'
          and coalesce(fund.reason_code, '') in (
            'payment_overage_stored',
            'retention_overage_stored'
          )
          then coalesce(fund.amount_usd, 0)
        when fund.movement_type = 'debit'
          and coalesce(fund.reason_code, '') = 'payment_void_fund_reversal'
          then -coalesce(fund.amount_usd, 0)
        else 0
      end
    )::numeric, 2) as fund_stored_usd_from_ledger
  from public.client_fund_movements fund
  where fund.order_id = p_order_id
  group by fund.order_id
),
change_accounting as (
  select
    coalesce((select sum(op.difference_usd) from public.client_fund_payout_operations op
      where op.order_id=p_order_id and op.voided_at is null),0) as payout_difference_usd,
    coalesce((select sum(m.amount_usd_equivalent)
      from public.payment_confirmation_operations op
      join public.money_movements m on m.movement_group_id=op.movement_group_id
      where op.order_id=p_order_id and op.request ? 'expectedChangeDebtUsd'
        and m.direction='outflow' and m.movement_type='change_given' and m.status='confirmed'),0) as certified_change_usd
),
calculated as (
  select
    dates.id as order_id,
    dates.order_number,
    dates.status as order_status,
    dates.effective_total_usd as total_usd,
    dates.effective_total_bs as total_bs,
    dates.effective_snapshot_rate as snapshot_rate_bs_per_usd,
    coalesce(movement.confirmed_paid_usd, 0) - (select payout_difference_usd from change_accounting) as confirmed_money_usd,
    (select payout_difference_usd+certified_change_usd from change_accounting) as snapshot_change_usd,
    coalesce(confirmed.confirmed_report_paid_usd, 0)
      as confirmed_report_paid_usd,
    coalesce(confirmed.confirmed_report_paid_bs_snapshot, 0)
      as confirmed_report_paid_bs_snapshot,
    coalesce(
      fund.fund_used_usd_from_ledger,
      dates.stored_client_fund_used_usd,
      0
    ) as client_fund_used_usd,
    coalesce(fund.fund_stored_usd_from_ledger, 0) as fund_stored_usd,
    coalesce(reports.pending_reports_usd, 0) as pending_reports_usd,
    coalesce(pending.pending_reports_bs_snapshot, 0)
      as pending_reports_bs_snapshot,
    coalesce(reports.rejected_reports_usd, 0) as rejected_reports_usd,
    coalesce(movement.voided_movements_count, 0) as voided_movements_count,
    coalesce(reports.rejected_reports_count, 0) as rejected_reports_count,
    coalesce(reports.pending_reports_count, 0) as pending_reports_count,
    coalesce(reports.confirmed_reports_count, 0) as confirmed_reports_count,
    dates.delivery_reference_date,
    dates.effective_operation_date
  from effective_dates dates
  left join movement_totals movement on movement.order_id = dates.id
  left join report_totals reports on reports.order_id = dates.id
  left join confirmed_report_bs confirmed on confirmed.order_id = dates.id
  left join pending_report_bs pending on pending.order_id = dates.id
  left join fund_ledger_for_order fund on fund.order_id = dates.id
),
balances as (
  select
    calculated.*,
    greatest(0, round((
      calculated.confirmed_money_usd
      - calculated.fund_stored_usd
      + calculated.client_fund_used_usd
    )::numeric, 2)) as applied_paid_usd,
    greatest(0, round((
      calculated.total_usd
      - (
        calculated.confirmed_money_usd
        - calculated.fund_stored_usd
        + calculated.client_fund_used_usd
      )
    )::numeric, 2)) as pending_usd,
    greatest(0, round((
      (
        calculated.confirmed_money_usd
        - calculated.fund_stored_usd
        + calculated.client_fund_used_usd
      )
      - calculated.total_usd
    )::numeric, 2)) as overpaid_usd,
    greatest(0, round((
      calculated.confirmed_report_paid_bs_snapshot
      + greatest(
        0,
        calculated.confirmed_money_usd
          - calculated.confirmed_report_paid_usd
          + calculated.snapshot_change_usd
      ) * calculated.snapshot_rate_bs_per_usd
      - calculated.snapshot_change_usd * calculated.snapshot_rate_bs_per_usd
      + calculated.client_fund_used_usd
        * calculated.snapshot_rate_bs_per_usd
      - calculated.fund_stored_usd
        * calculated.snapshot_rate_bs_per_usd
    )::numeric, 2)) as confirmed_paid_bs_snapshot
  from calculated
)
select
  balances.order_id,
  balances.order_number::text,
  balances.order_status::text,
  balances.total_usd,
  balances.total_bs,
  balances.snapshot_rate_bs_per_usd,
  balances.applied_paid_usd as confirmed_paid_usd,
  balances.confirmed_paid_bs_snapshot,
  balances.pending_reports_usd,
  balances.pending_reports_bs_snapshot,
  balances.rejected_reports_usd,
  balances.voided_movements_count,
  balances.rejected_reports_count,
  balances.pending_reports_count,
  balances.confirmed_reports_count,
  balances.client_fund_used_usd,
  balances.pending_usd,
  case
    when balances.pending_usd <= 0.005 then 0
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round(balances.pending_usd * p_active_bs_rate, 2)
    when balances.total_bs > 0
      then greatest(
        0,
        round(balances.total_bs - balances.confirmed_paid_bs_snapshot, 2)
      )
    when coalesce(p_active_bs_rate, 0) > 0
      then round(balances.pending_usd * p_active_bs_rate, 2)
    else 0
  end as pending_bs,
  balances.overpaid_usd,
  case
    when balances.pending_usd <= 0.005 then 'closed'
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end as collection_mode,
  case
    when balances.order_status = 'cancelled' then 'cancelled'
    when balances.overpaid_usd > 0.005 then 'overpaid'
    when balances.pending_reports_count > 0 then 'pending_review'
    when balances.pending_usd <= 0.005 then 'paid'
    when balances.applied_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end as payment_status,
  balances.delivery_reference_date,
  balances.effective_operation_date
from balances;
$function$;
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
CREATE OR REPLACE FUNCTION app_private.void_financial_movement_v1(p_movement_id bigint, p_group_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid:=auth.uid();
  v_now timestamptz:=statement_timestamp();
  v_first public.money_movements%rowtype;
  v_prior public.financial_void_operations%rowtype;
  v_order public.orders%rowtype;
  v_ids bigint[];
  v_locked_ids bigint[];
  v_order_ids bigint[];
  v_report_ids bigint[];
  v_root bigint;
  v_group uuid;
  v_fund record;
  v_round record;
  v_key text;
  v_pricing jsonb;
  v_payment jsonb;
  v_before_pricing jsonb;
  v_before_payment jsonb;
  v_id bigint;
  v_event_ids jsonb:='[]';
  v_fund_ids jsonb:='[]';
  v_result jsonb;
  v_transfer jsonb;
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo admin puede anular movimientos financieros.' using errcode='42501';
  end if;
  p_reason:=btrim(regexp_replace(coalesce(p_reason,''),'\s+',' ','g'));
  if length(p_reason) not between 6 and 500 then raise exception 'Indica un motivo claro para anular.' using errcode='22023'; end if;
  select * into v_first from public.money_movements
    where id=p_movement_id or (coalesce(p_movement_id,0)<=0 and movement_group_id=p_group_id) order by id limit 1;
  if not found then raise exception 'No se encontró el movimiento.' using errcode='22023'; end if;
  v_group:=v_first.movement_group_id;
  if p_group_id is not null and p_group_id is distinct from v_group then
    raise exception 'El movimiento no pertenece al grupo seleccionado.' using errcode='22023';
  end if;
  v_transfer:=app_private.void_client_fund_payout_v1(v_group,p_reason);
  if v_transfer is not null then return v_transfer; end if;
  v_transfer:=app_private.void_money_transfer_v1(v_first.id,v_group,p_reason);
  if v_transfer is not null then return v_transfer||jsonb_build_object('paymentReportIds','[]'::jsonb); end if;
  perform pg_advisory_xact_lock(hashtextextended('financial-void:'||coalesce(v_group::text,v_first.id::text),0));
  select array_agg(id order by id),min(id),array_agg(distinct order_id) filter(where order_id is not null),
    array_agg(distinct payment_report_id) filter(where payment_report_id is not null)
  into v_ids,v_root,v_order_ids,v_report_ids from public.money_movements
  where (v_group is not null and movement_group_id=v_group) or (v_group is null and id=v_first.id);
  select * into v_prior from public.financial_void_operations where root_movement_id=v_root;
  if found then
    if exists(select 1 from public.money_movements where id=any(v_ids) and status<>'voided') then
      raise exception 'La operación anulada fue modificada y requiere revisión.' using errcode='22023';
    end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  if exists(select 1 from public.commission_payment_operations where payment_movement_id=any(v_ids) or fee_movement_id=any(v_ids)) then
    raise exception 'Anula este abono desde su liquidación de comisiones para conservar el saldo del asesor.' using errcode='22023';
  end if;
  -- Refuse ambiguous legacy side effects instead of guessing ledger ownership.
  if exists(select 1 from public.counter_command_receipts r where r.idempotency_key=v_group and r.command_type='apply_order_payments'
      and (coalesce((r.result_payload->>'fund_credit_usd')::numeric,0)>0
        or exists(select 1 from public.client_fund_movements f where f.order_id=r.order_id and f.created_at=r.created_at)
        or exists(select 1 from public.order_change_obligations c where c.command_idempotency_key=r.idempotency_key))) then
    raise exception 'Este pago de Mostrador tiene fondo o cambio vinculado. Requiere revisar esa operación completa antes de anularla.' using errcode='22023';
  end if;
  if exists(select 1 from public.money_movements m where m.id=any(v_ids) and m.reference_code ~ '^closure-[0-9]+$') then
    raise exception 'Este movimiento corresponde a un cierre de cuenta; corrige el cierre desde Cuentas.' using errcode='22023';
  end if;
  perform id from public.orders where id=any(v_order_ids) order by id for update;
  perform id from public.money_accounts where id in (select money_account_id from public.money_movements where id=any(v_ids)) order by id for update;
  perform id from public.money_movements where id=any(v_ids) order by id for update;
  select array_agg(id order by id) into v_locked_ids from public.money_movements
    where (v_group is not null and movement_group_id=v_group) or (v_group is null and id=v_first.id);
  if v_locked_ids is distinct from v_ids or exists(select 1 from public.money_movements where id=any(v_ids) and movement_group_id is distinct from v_group) then
    raise exception 'El grupo cambió; actualiza la pantalla.' using errcode='22023';
  end if;
  if exists(select 1 from public.money_movements where id=any(v_ids) and status not in ('confirmed','pending')) then
    raise exception 'La operación ya fue anulada o contiene estados mezclados; revisa su historial.' using errcode='22023';
  end if;
  perform id from public.payment_reports where id=any(v_report_ids) order by id for update;
  if exists(select 1 from public.payment_reports where id=any(v_report_ids) and
    (status='rejected' or (status='confirmed' and not(confirmed_movement_id=any(v_ids))))) then
    raise exception 'El reporte está vinculado a otra confirmación o ya fue rechazado.' using errcode='22023';
  end if;
  if exists(select 1 from public.payment_confirmation_operations op,
    lateral jsonb_array_elements_text(op.result->'movementIds') ids(value)
    where op.report_id=any(v_report_ids) and not(ids.value::bigint=any(v_ids))) then
    raise exception 'Falta una parte del pago o su cambio; no se puede anular parcialmente.' using errcode='22023';
  end if;
  perform id from public.clients where id in (select client_id from public.client_fund_movements where payment_report_id=any(v_report_ids)) order by id for update;
  -- Exact linked ledger only; do not reverse unrelated client credits/restores.
  for v_fund in
    select client_id,order_id,payment_report_id,round(sum(case
      when movement_type='credit' and reason_code in ('payment_overage_stored','retention_overage_stored') then amount_usd
      when movement_type='debit' and reason_code='payment_void_fund_reversal' then -amount_usd else 0 end),2) as amount_usd
    from public.client_fund_movements where payment_report_id=any(v_report_ids)
    group by client_id,order_id,payment_report_id order by client_id,order_id,payment_report_id
  loop
    if v_fund.amount_usd>0 then
      update public.clients set fund_balance_usd=round(fund_balance_usd-v_fund.amount_usd,2)
        where id=v_fund.client_id and fund_balance_usd>=v_fund.amount_usd;
      if not found then
        raise exception 'El cliente ya utilizó parte del saldo a favor de este pago. No se anuló nada; revisa ese saldo primero.' using errcode='22023';
      end if;
      insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,payment_report_id,
        reason_code,notes,created_by_user_id,movement_group_id)
      values(v_fund.client_id,'debit','USD',v_fund.amount_usd,v_fund.amount_usd,v_fund.order_id,v_fund.payment_report_id,
        'payment_void_fund_reversal',p_reason,v_uid,v_group) returning id into v_id;
      v_fund_ids:=v_fund_ids||jsonb_build_array(v_id);
    end if;
  end loop;
  -- Restore only the fields touched by the recorded rounding operation. Never
  -- overwrite later totals or unrelated pricing/payment metadata.
  for v_round in select a.* from public.payment_confirmation_operations op
    join public.order_admin_adjustments a on a.id=op.adjustment_id where op.report_id=any(v_report_ids) order by a.id desc
  loop
    select * into v_order from public.orders where id=v_round.order_id;
    if v_order.total_usd is distinct from (v_round.payload->>'next_total_usd')::numeric
      or v_order.total_bs_snapshot is distinct from (v_round.payload->>'next_total_bs')::numeric
      or (v_order.extra_fields#>>'{pricing,total_usd}')::numeric is distinct from (v_round.payload->>'next_total_usd')::numeric
      or (v_order.extra_fields#>>'{pricing,total_bs}')::numeric is distinct from (v_round.payload->>'next_total_bs')::numeric then
      raise exception 'El total de la orden cambió después del redondeo. Revisa el ajuste antes de anular este pago.' using errcode='22023';
    end if;
    v_pricing:=coalesce(v_order.extra_fields->'pricing','{}');
    v_payment:=coalesce(v_order.extra_fields->'payment','{}');
    v_before_pricing:=coalesce(nullif(v_round.payload->'previous_pricing','null'::jsonb),'{}');
    v_before_payment:=coalesce(nullif(v_round.payload->'previous_payment','null'::jsonb),'{}');
    foreach v_key in array array['total_usd','total_bs','rounding_gain_closed_usd','rounding_gain_close_applied_at','rounding_gain_close_applied_by'] loop
      v_pricing:=v_pricing-v_key;
      if v_before_pricing ? v_key then v_pricing:=v_pricing||jsonb_build_object(v_key,v_before_pricing->v_key); end if;
    end loop;
    v_payment:=v_payment-'rounding_gain_close';
    if v_before_payment ? 'rounding_gain_close' then v_payment:=v_payment||jsonb_build_object('rounding_gain_close',v_before_payment->'rounding_gain_close'); end if;
    update public.orders set total_usd=(v_round.payload->>'previous_total_usd')::numeric,
      total_bs_snapshot=(v_round.payload->>'previous_total_bs')::numeric,
      extra_fields=extra_fields||jsonb_build_object('pricing',v_pricing,'payment',v_payment),last_modified_at=v_now,last_modified_by=v_uid where id=v_order.id;
    insert into public.order_admin_adjustments(order_id,adjustment_type,reason,notes,payload,created_by_user_id)
    values(v_order.id,'other','Reversión de redondeo por anulación de pago',p_reason,
      jsonb_build_object('kind','rounding_gain_close_reversal','original_adjustment_id',v_round.id,
        'delta_usd',-(v_round.payload->>'delta_usd')::numeric,'payment_report_id',v_round.payload->'payment_report_id'),v_uid);
  end loop;
  update public.money_movements set status='voided',reviewed_at=v_now,reviewed_by_user_id=v_uid,
    voided_at=v_now,voided_by_user_id=v_uid,void_reason=p_reason where id=any(v_ids);
  update public.payment_reports set status='rejected',confirmed_movement_id=null,reviewed_at=v_now,reviewed_by_user_id=v_uid,
    review_notes=concat_ws(E'\n',nullif(btrim(review_notes),''),'Anulado desde cuentas: '||p_reason) where id=any(v_report_ids);
  v_result:=jsonb_build_object('movementIds',v_ids,'paymentReportIds',coalesce(v_report_ids,'{}'::bigint[]),
    'fundReversalIds',v_fund_ids,'movementGroupId',v_group,'replayed',false);
  for v_order in select * from public.orders where id=any(v_order_ids) order by id loop
    insert into public.order_events(order_id,event,performed_by,meta)
    values(v_order.id,'financial_movement_voided',v_uid,v_result||jsonb_build_object('reason',p_reason));
    insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(v_order.id,v_order.order_number,'financial_movement_voided','payment','Movimiento anulado',p_reason,'warning',v_uid,v_result)
    returning id into v_id;
    v_event_ids:=v_event_ids||jsonb_build_array(v_id);
  end loop;
  v_result:=v_result||jsonb_build_object('eventIds',v_event_ids);
  insert into public.financial_void_operations(root_movement_id,movement_group_id,created_by,reason,result)
    values(v_root,v_group,v_uid,p_reason,v_result);
  return v_result;
end;
$function$;
commit;
