create or replace function public.advisor_goal_commercial_metrics_v1(
  p_from date,
  p_to date
)
returns table (
  period_key text,
  period_from date,
  period_to date,
  period_year integer,
  period_month integer,
  period_half integer,
  advisor_user_id uuid,
  advisor_name text,
  billing_usd numeric,
  closures_count bigint,
  new_own_clients_count bigint,
  new_assigned_clients_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as materialized (
    select
      coalesce(p_from, date '2023-01-01') as date_from,
      coalesce(p_to, (pg_catalog.now() at time zone 'America/Caracas')::date) as date_to
  ),
  months as materialized (
    select month_start::date
    from parameters,
      pg_catalog.generate_series(
        pg_catalog.date_trunc('month', parameters.date_from::timestamp),
        pg_catalog.date_trunc('month', parameters.date_to::timestamp),
        interval '1 month'
      ) month_start
    where parameters.date_from <= parameters.date_to
      and parameters.date_to - parameters.date_from <= 3660
  ),
  periods as materialized (
    select
      pg_catalog.to_char(month_row.month_start, 'YYYY-MM') || '-1' as period_key,
      month_row.month_start as period_from,
      (month_row.month_start + 14) as period_to,
      extract(year from month_row.month_start)::integer as period_year,
      extract(month from month_row.month_start)::integer as period_month,
      1::integer as period_half
    from months month_row

    union all

    select
      pg_catalog.to_char(month_row.month_start, 'YYYY-MM') || '-2' as period_key,
      (month_row.month_start + 15) as period_from,
      (month_row.month_start + interval '1 month - 1 day')::date as period_to,
      extract(year from month_row.month_start)::integer as period_year,
      extract(month from month_row.month_start)::integer as period_month,
      2::integer as period_half
    from months month_row
  ),
  active_advisors as materialized (
    select profile.id, profile.full_name
    from public.profiles profile
    where profile.is_active = true
      and coalesce(profile.receives_commissions, false) = true
      and (
        (select public.is_master_or_admin())
        or coalesce((select auth.role()), '') = 'service_role'
        or current_user = 'postgres'
      )
  ),
  purchase_facts as materialized (
    select
      fact.fact_key,
      fact.client_id,
      fact.attributed_advisor_id,
      (fact.purchased_at at time zone 'America/Caracas')::date as purchased_on,
      fact.net_total_usd,
      pg_catalog.row_number() over (
        partition by fact.client_id
        order by fact.purchased_at, fact.fact_key
      ) as client_purchase_rank
    from public.commercial_order_facts fact
    cross join parameters
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
      and (fact.purchased_at at time zone 'America/Caracas')::date <= parameters.date_to
  ),
  advisor_activity_start as materialized (
    select
      fact.attributed_advisor_id as advisor_user_id,
      min(fact.purchased_on) as first_purchase_on
    from purchase_facts fact
    where fact.attributed_advisor_id is not null
    group by fact.attributed_advisor_id
  ),
  period_advisors as materialized (
    select period.*, advisor.id as advisor_user_id, advisor.full_name as advisor_name
    from periods period
    cross join active_advisors advisor
    join advisor_activity_start activity
      on activity.advisor_user_id = advisor.id
     and period.period_to >= activity.first_purchase_on
    cross join parameters
    where period.period_from <= parameters.date_to
      and period.period_to >= parameters.date_from
  )
  select
    period_advisor.period_key,
    period_advisor.period_from,
    period_advisor.period_to,
    period_advisor.period_year,
    period_advisor.period_month,
    period_advisor.period_half,
    period_advisor.advisor_user_id,
    period_advisor.advisor_name,
    round(coalesce(sum(fact.net_total_usd), 0), 2) as billing_usd,
    count(fact.fact_key) as closures_count,
    count(distinct fact.client_id) filter (
      where fact.client_purchase_rank = 1 and client.client_type = 'own'
    ) as new_own_clients_count,
    count(distinct fact.client_id) filter (
      where fact.client_purchase_rank = 1 and client.client_type = 'assigned'
    ) as new_assigned_clients_count
  from period_advisors period_advisor
  left join purchase_facts fact
    on fact.attributed_advisor_id = period_advisor.advisor_user_id
   and fact.purchased_on between period_advisor.period_from and period_advisor.period_to
  left join public.clients client on client.id = fact.client_id
  group by
    period_advisor.period_key,
    period_advisor.period_from,
    period_advisor.period_to,
    period_advisor.period_year,
    period_advisor.period_month,
    period_advisor.period_half,
    period_advisor.advisor_user_id,
    period_advisor.advisor_name
  order by period_advisor.period_from, period_advisor.advisor_name;
$$;

comment on function public.advisor_goal_commercial_metrics_v1(date, date) is
  'Aggregates delivered purchase facts into half-month advisor metrics for auditable goal baselines. Gift-only facts are excluded and no operational order is reconstructed.';

revoke all on function public.advisor_goal_commercial_metrics_v1(date, date)
  from public, anon;
grant execute on function public.advisor_goal_commercial_metrics_v1(date, date)
  to authenticated, service_role;
