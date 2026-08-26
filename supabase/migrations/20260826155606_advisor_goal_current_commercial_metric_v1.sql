create or replace function public.advisor_goal_current_commercial_metric_v1(
  p_from date,
  p_to date
)
returns table (
  period_from date,
  period_to date,
  advisor_user_id uuid,
  billing_usd numeric,
  closures_count bigint,
  new_own_clients_count bigint,
  new_assigned_clients_count bigint,
  observed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with caller as materialized (
    select profile.id
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.is_active = true
      and coalesce(profile.receives_commissions, false) = true
      and p_from is not null
      and p_to is not null
      and p_from <= p_to
      and p_to - p_from <= 31
  ),
  current_facts as materialized (
    select
      fact.fact_key,
      fact.client_id,
      fact.attributed_advisor_id,
      fact.purchased_at,
      fact.net_total_usd
    from public.commercial_order_facts fact
    join caller on caller.id = fact.attributed_advisor_id
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
      and (fact.purchased_at at time zone 'America/Caracas')::date
        between p_from and p_to
  ),
  first_client_facts as materialized (
    select distinct on (fact.client_id)
      fact.client_id,
      fact.fact_key
    from public.commercial_order_facts fact
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
      and fact.client_id in (select current_fact.client_id from current_facts current_fact)
    order by fact.client_id, fact.purchased_at, fact.fact_key
  )
  select
    p_from as period_from,
    p_to as period_to,
    caller.id as advisor_user_id,
    round(coalesce(sum(current_fact.net_total_usd), 0), 2) as billing_usd,
    count(current_fact.fact_key) as closures_count,
    count(distinct current_fact.client_id) filter (
      where first_fact.fact_key = current_fact.fact_key
        and client.client_type = 'own'
    ) as new_own_clients_count,
    count(distinct current_fact.client_id) filter (
      where first_fact.fact_key = current_fact.fact_key
        and client.client_type = 'assigned'
    ) as new_assigned_clients_count,
    pg_catalog.now() as observed_at
  from caller
  left join current_facts current_fact on true
  left join first_client_facts first_fact on first_fact.client_id = current_fact.client_id
  left join public.clients client on client.id = current_fact.client_id
  group by caller.id;
$$;

comment on function public.advisor_goal_current_commercial_metric_v1(date, date) is
  'Returns only the authenticated commission advisor current delivered commercial totals for one bounded period. The security definer is identity-bound and never accepts an advisor id.';

revoke all on function public.advisor_goal_current_commercial_metric_v1(date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.advisor_goal_current_commercial_metric_v1(date, date)
  to authenticated;
