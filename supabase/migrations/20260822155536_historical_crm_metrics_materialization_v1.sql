-- Prevent the SQL planner from repeatedly expanding the unified facts view
-- while calculating a whole CRM portfolio. Results remain fully live.

create or replace function public.crm_client_metrics_v1(
  p_purchase_window integer default 6,
  p_as_of timestamptz default pg_catalog.now()
)
returns table (
  client_id bigint,
  first_purchase_on date,
  last_purchase_on date,
  purchase_count bigint,
  net_revenue_usd numeric,
  average_ticket_usd numeric,
  cadence_days numeric,
  cadence_window_used integer,
  last_advisor_id uuid,
  last_advisor_name_snapshot text,
  last_gift_on date,
  days_since_last_purchase integer,
  used_pickup boolean,
  used_delivery boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as materialized (
    select
      greatest(2, least(coalesce(p_purchase_window, 6), 50))::integer
        as purchase_window,
      coalesce(p_as_of, pg_catalog.now()) as as_of
  ),
  eligible_facts as materialized (
    select fact.*
    from public.commercial_order_facts fact
    cross join parameters
    where fact.purchased_at <= parameters.as_of
  ),
  purchase_facts as materialized (
    select fact.*
    from eligible_facts fact
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
  ),
  ranked_facts as materialized (
    select
      fact.*,
      pg_catalog.row_number() over (
        partition by fact.client_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) as purchase_rank
    from purchase_facts fact
  ),
  all_metrics as materialized (
    select
      fact.client_id,
      min((fact.purchased_at at time zone 'America/Caracas')::date) as first_purchase_on,
      max((fact.purchased_at at time zone 'America/Caracas')::date) as last_purchase_on,
      count(*) as purchase_count,
      round(sum(fact.net_total_usd), 2) as net_revenue_usd,
      round(avg(fact.net_total_usd), 2) as average_ticket_usd,
      (array_agg(fact.attributed_advisor_id order by fact.purchased_at desc, fact.fact_key desc)
        filter (where fact.attributed_advisor_id is not null))[1] as last_advisor_id,
      (array_agg(fact.advisor_name_snapshot order by fact.purchased_at desc, fact.fact_key desc)
        filter (where nullif(btrim(fact.advisor_name_snapshot), '') is not null))[1]
        as last_advisor_name_snapshot
    from purchase_facts fact
    group by fact.client_id
  ),
  gift_metrics as materialized (
    select
      fact.client_id,
      max((fact.purchased_at at time zone 'America/Caracas')::date) as last_gift_on
    from eligible_facts fact
    where fact.event_kind = 'gift_only'
      or cardinality(fact.gift_tags) > 0
    group by fact.client_id
  ),
  channel_metrics as materialized (
    select
      fact.client_id,
      bool_or(fact.fulfillment = 'pickup') as used_pickup,
      bool_or(fact.fulfillment = 'delivery') as used_delivery
    from eligible_facts fact
    group by fact.client_id
  ),
  recent_dates as materialized (
    select
      fact.client_id,
      (fact.purchased_at at time zone 'America/Caracas')::date as purchase_on,
      lead((fact.purchased_at at time zone 'America/Caracas')::date) over (
        partition by fact.client_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) as prior_purchase_on
    from ranked_facts fact
    cross join parameters
    where fact.purchase_rank <= parameters.purchase_window
  ),
  cadence as materialized (
    select
      recent.client_id,
      round(avg((recent.purchase_on - recent.prior_purchase_on)::numeric), 2) as cadence_days
    from recent_dates recent
    where recent.prior_purchase_on is not null
    group by recent.client_id
  )
  select
    metric.client_id,
    metric.first_purchase_on,
    metric.last_purchase_on,
    metric.purchase_count,
    metric.net_revenue_usd,
    metric.average_ticket_usd,
    cadence.cadence_days,
    parameters.purchase_window as cadence_window_used,
    metric.last_advisor_id,
    metric.last_advisor_name_snapshot,
    gift_metric.last_gift_on,
    ((parameters.as_of at time zone 'America/Caracas')::date - metric.last_purchase_on)::integer
      as days_since_last_purchase,
    channel_metric.used_pickup,
    channel_metric.used_delivery
  from all_metrics metric
  cross join parameters
  left join cadence on cadence.client_id = metric.client_id
  left join gift_metrics gift_metric on gift_metric.client_id = metric.client_id
  left join channel_metrics channel_metric on channel_metric.client_id = metric.client_id;
$$;

comment on function public.crm_client_metrics_v1(integer, timestamptz) is
  'Computes live CRM metrics from one materialized pass over delivered commercial facts. The purchase window is configurable from 2 to 50 purchases.';

revoke all on function public.crm_client_metrics_v1(integer, timestamptz)
  from public, anon;
grant execute on function public.crm_client_metrics_v1(integer, timestamptz)
  to authenticated, service_role;
