-- Admin V2 receivables read model.
--
-- This intentionally keeps all collection operations in Master Ops. The RPC
-- exposes a compact, current, read-only view and delegates final balances to
-- the canonical per-order financial calculator. A conservative candidate
-- pass avoids recalculating every historical delivered order on each request.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.admin_finance_receivables_overview_v1(
  p_period_from date,
  p_period_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := pg_catalog.statement_timestamp();
  v_local_date date := (v_as_of at time zone 'America/Caracas')::date;
  v_result jsonb;
begin
  if v_uid is null or not exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_uid
      and role_row.role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if p_period_from is null
    or p_period_to is null
    or p_period_from > p_period_to
    or p_period_to > v_local_date
    or p_period_to - p_period_from > 366
  then
    raise exception 'invalid receivables period' using errcode = '22023';
  end if;

  with delivered_event as materialized (
    select distinct on (event_row.order_id)
      event_row.order_id,
      event_row.created_at,
      (event_row.created_at at time zone 'America/Caracas')::date as delivery_date
    from public.order_events event_row
    where event_row.event = 'delivered'
      and event_row.created_at <= v_as_of
    order by event_row.order_id, event_row.created_at desc, event_row.id desc
  ),
  delivered_order as materialized (
    select
      order_row.id,
      coalesce(nullif(btrim(order_row.order_number), ''), '#' || order_row.id::text) as order_number,
      order_row.client_id,
      order_row.attributed_advisor_id,
      event_row.delivery_date,
      round(coalesce(
        nullif(order_row.extra_fields->'pricing'->>'total_usd', '')::numeric,
        order_row.total_usd,
        0
      ), 2) as raw_total_usd
    from delivered_event event_row
    join public.orders order_row on order_row.id = event_row.order_id
  ),
  money_screen as materialized (
    select
      movement.order_id,
      round(coalesce(sum(movement.amount_usd_equivalent) filter (
        where movement.status = 'confirmed'
          and movement.direction = 'inflow'
      ), 0), 2) as confirmed_inflow_usd,
      coalesce(bool_or(
        movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type in ('change_given', 'withdrawal')
      ), false) as has_relevant_outflow
    from public.money_movements movement
    join delivered_order order_row on order_row.id = movement.order_id
    where movement.created_at <= v_as_of
    group by movement.order_id
  ),
  portfolio_candidate as materialized (
    select order_row.id
    from delivered_order order_row
    left join money_screen money on money.order_id = order_row.id
    where coalesce(money.confirmed_inflow_usd, 0) + 0.005 < order_row.raw_total_usd
       or coalesce(money.has_relevant_outflow, false)
       or exists (
         select 1
         from public.client_fund_movements fund
         where fund.order_id = order_row.id
           and fund.created_at <= v_as_of
       )
       or exists (
         select 1
         from public.payment_reports report
         where report.order_id = order_row.id
           and report.created_at <= v_as_of
           and report.status = 'pending'
       )
  ),
  relevant_order as materialized (
    select candidate.id
    from portfolio_candidate candidate
    union
    select order_row.id
    from delivered_order order_row
    where order_row.delivery_date between p_period_from and p_period_to
  ),
  financial_state as materialized (
    select state.*
    from relevant_order relevant
    cross join lateral public.get_order_financial_state(
      relevant.id,
      v_local_date,
      null
    ) state
  ),
  open_order as materialized (
    select
      order_row.id,
      order_row.order_number,
      coalesce(nullif(btrim(client.full_name), ''), 'Cliente') as client_name,
      coalesce(nullif(btrim(profile.full_name), ''), 'Sin asesor') as advisor_name,
      order_row.delivery_date,
      order_row.delivery_date + 5 as due_date,
      greatest(0, v_local_date - order_row.delivery_date) as age_days,
      state.total_usd,
      least(state.total_usd, greatest(0, state.confirmed_paid_usd)) as confirmed_paid_usd,
      state.pending_usd,
      state.pending_reports_usd,
      state.pending_reports_count,
      state.payment_status,
      case
        when v_local_date - order_row.delivery_date <= 5 then 'credit_open'
        else 'overdue_open'
      end as collection_status
    from financial_state state
    join portfolio_candidate candidate on candidate.id = state.order_id
    join delivered_order order_row on order_row.id = state.order_id
    left join public.clients client on client.id = order_row.client_id
    left join public.profiles profile on profile.id = order_row.attributed_advisor_id
    where state.pending_usd > 0.005
      and state.payment_status <> 'cancelled'
  ),
  money_registration as materialized (
    select
      movement.order_id,
      coalesce(
        (linked_report.created_at at time zone 'America/Caracas')::date,
        (confirmed_report.created_at at time zone 'America/Caracas')::date,
        (movement.created_at at time zone 'America/Caracas')::date
      ) as registered_date,
      case
        when movement.direction = 'inflow'
          then greatest(0, coalesce(movement.amount_usd_equivalent, 0))
        else -greatest(0, coalesce(movement.amount_usd_equivalent, 0))
      end as amount_usd
    from public.money_movements movement
    join financial_state state on state.order_id = movement.order_id
    left join public.payment_reports linked_report
      on linked_report.id = movement.payment_report_id
     and linked_report.created_at <= v_as_of
    left join lateral (
      select report.created_at
      from public.payment_reports report
      where report.confirmed_movement_id = movement.id
        and report.created_at <= v_as_of
      order by report.created_at desc, report.id desc
      limit 1
    ) confirmed_report on true
    where movement.status = 'confirmed'
      and movement.created_at <= v_as_of
      and (
        movement.direction = 'inflow'
        or (
          movement.direction = 'outflow'
          and (
            movement.movement_type = 'change_given'
            or (
              movement.movement_type = 'withdrawal'
              and exists (
                select 1
                from public.counter_command_receipts receipt
                where receipt.command_type = 'request_refund'
                  and receipt.order_id = movement.order_id
                  and receipt.idempotency_key = movement.movement_group_id
                  and receipt.created_at <= v_as_of
              )
            )
          )
        )
      )
  ),
  fund_registration as materialized (
    select
      fund.order_id,
      (fund.created_at at time zone 'America/Caracas')::date as registered_date,
      case
        when fund.movement_type = 'debit'
          and fund.reason_code in ('order_fund_applied', 'counter_change_fund_reversal')
          then greatest(0, coalesce(fund.amount_usd, 0))
        else -greatest(0, coalesce(fund.amount_usd, 0))
      end as amount_usd
    from public.client_fund_movements fund
    join financial_state state on state.order_id = fund.order_id
    where fund.created_at <= v_as_of
      and (
        (
          fund.movement_type = 'debit'
          and fund.reason_code in ('order_fund_applied', 'counter_change_fund_reversal')
        )
        or (
          fund.movement_type = 'credit'
          and fund.reason_code = 'order_fund_restore'
        )
      )
  ),
  daily_registration as materialized (
    select
      entry.order_id,
      entry.registered_date,
      round(sum(entry.amount_usd), 2) as amount_usd
    from (
      select * from money_registration
      union all
      select * from fund_registration
    ) entry
    where abs(entry.amount_usd) > 0.005
    group by entry.order_id, entry.registered_date
  ),
  raw_registration_running as materialized (
    select
      daily.order_id,
      daily.registered_date,
      round(sum(daily.amount_usd) over (
        partition by daily.order_id
        order by daily.registered_date
        rows between unbounded preceding and current row
      ), 2) as raw_running_usd
    from daily_registration daily
  ),
  registration_running as materialized (
    select
      running.order_id,
      running.registered_date,
      round(
        running.raw_running_usd
        - least(0, min(running.raw_running_usd) over (
          partition by running.order_id
          order by running.registered_date
          rows between unbounded preceding and current row
        )),
        2
      ) as running_usd
    from raw_registration_running running
  ),
  registration_crossing as materialized (
    select
      running.order_id,
      running.registered_date,
      running.running_usd,
      coalesce(lag(running.running_usd) over (
        partition by running.order_id
        order by running.registered_date
      ), 0) as previous_running_usd,
      first_value(running.running_usd) over (
        partition by running.order_id
        order by running.registered_date desc
        rows between unbounded preceding and unbounded following
      ) as final_running_usd
    from registration_running running
  ),
  completion_date as materialized (
    select
      state.order_id,
      max(crossing.registered_date) filter (
        where crossing.previous_running_usd < least(state.total_usd, state.confirmed_paid_usd) - 0.005
          and crossing.running_usd >= least(state.total_usd, state.confirmed_paid_usd) - 0.005
          and crossing.final_running_usd >= least(state.total_usd, state.confirmed_paid_usd) - 0.005
      ) as completed_payment_registration_date
    from financial_state state
    left join registration_crossing crossing on crossing.order_id = state.order_id
    where state.pending_usd <= 0.005
      and least(state.total_usd, state.confirmed_paid_usd) > 0.005
    group by state.order_id
  ),
  cohort_order as materialized (
    select
      order_row.id,
      order_row.delivery_date,
      state.total_usd,
      least(state.total_usd, greatest(0, state.confirmed_paid_usd)) as covered_usd,
      state.pending_usd,
      completion.completed_payment_registration_date,
      case
        when state.pending_usd <= 0.005
          and completion.completed_payment_registration_date is null
          then 'missing_registration'
        when completion.completed_payment_registration_date <= order_row.delivery_date
          then 'punctual_paid'
        when completion.completed_payment_registration_date <= order_row.delivery_date + 5
          then 'credit_paid'
        when completion.completed_payment_registration_date is not null
          then 'overdue_paid'
        when v_local_date - order_row.delivery_date <= 5
          then 'credit_open'
        else 'overdue_open'
      end as collection_status
    from delivered_order order_row
    join financial_state state on state.order_id = order_row.id
    left join completion_date completion on completion.order_id = order_row.id
    where order_row.delivery_date between p_period_from and p_period_to
      and state.total_usd > 0.005
      and state.payment_status <> 'cancelled'
  ),
  portfolio_summary as (
    select
      count(*)::integer as open_orders,
      round(coalesce(sum(open_row.pending_usd), 0), 2) as receivable_usd,
      count(*) filter (where open_row.collection_status = 'credit_open')::integer as grace_orders,
      round(coalesce(sum(open_row.pending_usd) filter (
        where open_row.collection_status = 'credit_open'
      ), 0), 2) as grace_usd,
      count(*) filter (where open_row.collection_status = 'overdue_open')::integer as overdue_orders,
      round(coalesce(sum(open_row.pending_usd) filter (
        where open_row.collection_status = 'overdue_open'
      ), 0), 2) as overdue_usd,
      coalesce(sum(open_row.pending_reports_count), 0)::integer as pending_reports,
      round(coalesce(sum(open_row.pending_reports_usd), 0), 2) as pending_reports_usd,
      coalesce(max(open_row.age_days), 0)::integer as oldest_age_days
    from open_order open_row
  ),
  period_summary as (
    select
      count(*)::integer as orders,
      round(coalesce(sum(cohort.total_usd), 0), 2) as billed_usd,
      round(coalesce(sum(cohort.covered_usd), 0), 2) as covered_usd,
      round(coalesce(sum(cohort.pending_usd), 0), 2) as pending_usd,
      count(*) filter (where cohort.collection_status = 'punctual_paid')::integer as punctual_paid,
      count(*) filter (where cohort.collection_status = 'credit_paid')::integer as credit_paid,
      count(*) filter (where cohort.collection_status = 'overdue_paid')::integer as overdue_paid,
      count(*) filter (where cohort.collection_status = 'credit_open')::integer as credit_open,
      count(*) filter (where cohort.collection_status = 'overdue_open')::integer as overdue_open,
      count(*) filter (where cohort.collection_status = 'missing_registration')::integer as missing_registration
    from cohort_order cohort
  )
  select jsonb_build_object(
    'definitionVersion', 'admin-finance-receivables-v1',
    'asOf', v_as_of,
    'asOfDate', v_local_date,
    'cutoffMode', 'current_statement',
    'balanceSource', 'canonical_order_financial_state',
    'paymentTimingBasis', 'payment_registration_date',
    'graceDays', 5,
    'period', jsonb_build_object(
      'from', p_period_from,
      'to', p_period_to,
      'orders', period_summary.orders,
      'billedUsd', period_summary.billed_usd,
      'coveredUsd', period_summary.covered_usd,
      'pendingUsd', period_summary.pending_usd,
      'punctualPaid', period_summary.punctual_paid,
      'creditPaid', period_summary.credit_paid,
      'overduePaid', period_summary.overdue_paid,
      'creditOpen', period_summary.credit_open,
      'overdueOpen', period_summary.overdue_open,
      'missingRegistration', period_summary.missing_registration
    ),
    'portfolio', jsonb_build_object(
      'openOrders', portfolio_summary.open_orders,
      'receivableUsd', portfolio_summary.receivable_usd,
      'graceOrders', portfolio_summary.grace_orders,
      'graceUsd', portfolio_summary.grace_usd,
      'overdueOrders', portfolio_summary.overdue_orders,
      'overdueUsd', portfolio_summary.overdue_usd,
      'pendingReports', portfolio_summary.pending_reports,
      'pendingReportsUsd', portfolio_summary.pending_reports_usd,
      'oldestAgeDays', portfolio_summary.oldest_age_days
    ),
    'openOrders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', open_row.id,
        'orderNumber', open_row.order_number,
        'clientName', open_row.client_name,
        'advisorName', open_row.advisor_name,
        'deliveryDate', open_row.delivery_date,
        'dueDate', open_row.due_date,
        'ageDays', open_row.age_days,
        'totalUsd', open_row.total_usd,
        'confirmedPaidUsd', open_row.confirmed_paid_usd,
        'pendingUsd', open_row.pending_usd,
        'pendingReportsUsd', open_row.pending_reports_usd,
        'pendingReportsCount', open_row.pending_reports_count,
        'paymentStatus', open_row.payment_status,
        'collectionStatus', open_row.collection_status
      ) order by
        case when open_row.collection_status = 'overdue_open' then 0 else 1 end,
        open_row.age_days desc,
        open_row.pending_usd desc,
        open_row.id desc)
      from open_order open_row
    ), '[]'::jsonb)
  )
  into v_result
  from portfolio_summary
  cross join period_summary;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_receivables_overview_v1(date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_receivables_overview_v1(date, date)
  to authenticated;

comment on function public.admin_finance_receivables_overview_v1(date, date)
is 'Admin-only current receivables and payment-timing read model. Current balances come from the canonical order financial state; payment timing uses registration date and the existing five-day collection policy.';

commit;
