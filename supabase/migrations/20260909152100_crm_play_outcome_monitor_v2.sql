-- Keep direct applications and later commercial influence separate. A direct
-- result always requires a redeemed benefit attached to an order. Influence is
-- only observed after a successful response and never reclassified as direct.

create or replace function public.crm_get_play_monitor_summary_v2(p_play_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  result jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to monitor a CRM play'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.crm_plays play where play.id = p_play_id) then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  with play_config as materialized (
    select play.evaluation_window_days
    from public.crm_plays play
    where play.id = p_play_id
  ),
  member_base as materialized (
    select
      member_row.id,
      member_row.client_id,
      member_row.cadence_days as baseline_cadence_days,
      member_row.last_purchase_on as baseline_last_purchase_on,
      member_row.benefit_status,
      coalesce(
        member_row.responded_at,
        min(event_row.created_at) filter (where event_row.event_type = 'responded')
      ) as responded_at,
      min(event_row.created_at) filter (where event_row.event_type = 'contact') as launched_at,
      pg_catalog.bool_or(event_row.event_type = 'unreachable') as marked_no_response
    from public.crm_play_members member_row
    left join public.crm_play_member_events event_row
      on event_row.play_member_id = member_row.id
    where member_row.play_id = p_play_id
      and member_row.workflow_status <> 'removed'
    group by member_row.id
  ),
  direct_member as materialized (
    select
      member.id,
      exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.play_member_id = member.id
          and redemption.status = 'redeemed'
      ) as has_direct_application
    from member_base member
  ),
  post_response_purchases as materialized (
    select
      member.id as play_member_id,
      (fact.purchased_at at time zone 'America/Caracas')::date as purchase_on,
      fact.net_total_usd
    from member_base member
    join play_config config on true
    join direct_member direct on direct.id = member.id
    join public.commercial_order_facts fact
      on fact.client_id = member.client_id
     and fact.fact_origin = 'live'
     and fact.event_kind = 'purchase'
     and fact.net_total_usd > 0
     and member.responded_at is not null
     and fact.purchased_at > member.responded_at
     and fact.purchased_at <= pg_catalog.least(
       pg_catalog.now(),
       member.responded_at + pg_catalog.make_interval(days => config.evaluation_window_days)
     )
    where not direct.has_direct_application
  ),
  post_purchase_rollup as materialized (
    select
      purchase.play_member_id,
      count(*)::integer as purchase_count,
      pg_catalog.round(sum(purchase.net_total_usd), 2) as revenue_usd
    from post_response_purchases purchase
    group by purchase.play_member_id
  ),
  cadence_sequence as materialized (
    select
      purchase.play_member_id,
      purchase.purchase_on,
      pg_catalog.lag(
        purchase.purchase_on,
        1,
        member.baseline_last_purchase_on
      ) over (
        partition by purchase.play_member_id
        order by purchase.purchase_on, purchase.net_total_usd
      ) as prior_purchase_on
    from post_response_purchases purchase
    join member_base member on member.id = purchase.play_member_id
  ),
  post_cadence as materialized (
    select
      sequence.play_member_id,
      pg_catalog.round(
        avg((sequence.purchase_on - sequence.prior_purchase_on)::numeric),
        2
      ) as cadence_days
    from cadence_sequence sequence
    where sequence.prior_purchase_on is not null
    group by sequence.play_member_id
  ),
  outcomes as materialized (
    select
      member.id,
      member.baseline_cadence_days,
      cadence.cadence_days as post_response_cadence_days,
      coalesce(purchases.purchase_count, 0) as later_purchase_count,
      coalesce(purchases.revenue_usd, 0) as later_revenue_usd,
      member.responded_at,
      member.launched_at,
      member.marked_no_response,
      direct.has_direct_application,
      case
        when member.responded_at is null or direct.has_direct_application then false
        when member.baseline_cadence_days is null or member.baseline_cadence_days <= 0 then false
        when cadence.cadence_days is null then false
        else cadence.cadence_days < member.baseline_cadence_days
      end as cadence_improved,
      case
        when member.responded_at is null or direct.has_direct_application then false
        else member.responded_at
          + pg_catalog.make_interval(days => config.evaluation_window_days)
          > pg_catalog.now()
      end as evaluation_open
    from member_base member
    join play_config config on true
    join direct_member direct on direct.id = member.id
    left join post_purchase_rollup purchases on purchases.play_member_id = member.id
    left join post_cadence cadence on cadence.play_member_id = member.id
  ),
  member_rollup as (
    select
      count(*)::integer as total_members,
      count(*) filter (where outcome.launched_at is not null)::integer as launched_members,
      count(*) filter (where outcome.responded_at is not null)::integer as responded_members,
      count(*) filter (
        where outcome.marked_no_response and outcome.responded_at is null
      )::integer as no_response_members,
      count(*) filter (where outcome.has_direct_application)::integer as redeemed_members,
      count(*) filter (
        where member.benefit_status = 'expired'
      )::integer as expired_members,
      count(*) filter (
        where outcome.responded_at is not null and not outcome.has_direct_application
      )::integer as responded_without_redemption_members,
      count(*) filter (
        where not outcome.has_direct_application and outcome.later_purchase_count > 0
      )::integer as post_contact_purchase_members,
      count(*) filter (where outcome.cadence_improved)::integer as cadence_improved_members,
      count(*) filter (
        where not outcome.has_direct_application
          and outcome.responded_at is not null
          and outcome.baseline_cadence_days is not null
          and outcome.baseline_cadence_days > 0
          and outcome.post_response_cadence_days is not null
      )::integer as comparable_cadence_members,
      count(*) filter (
        where outcome.evaluation_open and outcome.later_purchase_count = 0
      )::integer as evaluation_pending_members,
      coalesce(sum(outcome.later_revenue_usd), 0)::numeric as post_contact_revenue_usd,
      pg_catalog.round(avg(outcome.baseline_cadence_days) filter (
        where outcome.baseline_cadence_days is not null
          and outcome.post_response_cadence_days is not null
          and not outcome.has_direct_application
      ), 2) as comparable_baseline_cadence_days,
      pg_catalog.round(avg(outcome.post_response_cadence_days) filter (
        where outcome.baseline_cadence_days is not null
          and outcome.post_response_cadence_days is not null
          and not outcome.has_direct_application
      ), 2) as comparable_post_cadence_days
    from outcomes outcome
    join member_base member on member.id = outcome.id
  ),
  redemption_rollup as (
    select
      count(distinct redemption.order_id)::integer as redemption_orders,
      coalesce(sum(redemption.benefit_credit_usd), 0)::numeric as benefit_credit_usd,
      coalesce(sum(redemption.advisor_charge_usd), 0)::numeric as advisor_charge_usd,
      coalesce(sum(redemption.company_cost_usd), 0)::numeric as company_cost_usd,
      coalesce(sum(redemption.customer_paid_difference_usd), 0)::numeric
        as customer_paid_difference_usd
    from public.crm_play_redemptions redemption
    join public.crm_play_members member_row on member_row.id = redemption.play_member_id
    where member_row.play_id = p_play_id
      and redemption.status = 'redeemed'
  ),
  direct_orders as (
    select distinct redemption.order_id
    from public.crm_play_redemptions redemption
    join public.crm_play_members member_row on member_row.id = redemption.play_member_id
    where member_row.play_id = p_play_id
      and redemption.status = 'redeemed'
  ),
  direct_sales as (
    select coalesce(sum(order_row.total_usd), 0)::numeric as direct_order_revenue_usd
    from direct_orders direct_order
    join public.orders order_row on order_row.id = direct_order.order_id
  )
  select pg_catalog.jsonb_build_object(
    'total_members', members.total_members,
    'launched_members', members.launched_members,
    'responded_members', members.responded_members,
    'no_response_members', members.no_response_members,
    'redeemed_members', members.redeemed_members,
    'expired_members', members.expired_members,
    'redemption_orders', redemptions.redemption_orders,
    'launch_rate_pct', case when members.total_members = 0 then 0
      else pg_catalog.round(members.launched_members * 100.0 / members.total_members, 1) end,
    'response_rate_pct', case when members.launched_members = 0 then 0
      else pg_catalog.round(members.responded_members * 100.0 / members.launched_members, 1) end,
    'redemption_rate_pct', case when members.total_members = 0 then 0
      else pg_catalog.round(members.redeemed_members * 100.0 / members.total_members, 1) end,
    'responded_without_redemption_members', members.responded_without_redemption_members,
    'post_contact_purchase_members', members.post_contact_purchase_members,
    'cadence_improved_members', members.cadence_improved_members,
    'comparable_cadence_members', members.comparable_cadence_members,
    'cadence_improvement_rate_pct', case when members.comparable_cadence_members = 0 then 0
      else pg_catalog.round(
        members.cadence_improved_members * 100.0 / members.comparable_cadence_members,
        1
      ) end,
    'evaluation_pending_members', members.evaluation_pending_members,
    'post_contact_revenue_usd', pg_catalog.round(members.post_contact_revenue_usd, 2),
    'comparable_baseline_cadence_days', members.comparable_baseline_cadence_days,
    'comparable_post_cadence_days', members.comparable_post_cadence_days,
    'benefit_credit_usd', pg_catalog.round(redemptions.benefit_credit_usd, 2),
    'advisor_charge_usd', pg_catalog.round(redemptions.advisor_charge_usd, 2),
    'company_cost_usd', pg_catalog.round(redemptions.company_cost_usd, 2),
    'customer_paid_difference_usd',
      pg_catalog.round(redemptions.customer_paid_difference_usd, 2),
    'direct_order_revenue_usd', pg_catalog.round(direct_sales.direct_order_revenue_usd, 2),
    'direct_attribution_rule', 'redeemed_benefit_in_order',
    'generated_at', pg_catalog.now()
  ) into result
  from member_rollup members
  cross join redemption_rollup redemptions
  cross join direct_sales;

  return coalesce(result, '{}'::jsonb);
end;
$$;

revoke all on function public.crm_get_play_monitor_summary_v2(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_get_play_monitor_summary_v2(bigint)
  to authenticated, service_role;

comment on function public.crm_get_play_monitor_summary_v2(bigint) is
  'Separates direct benefit redemption from post-response purchases and measurable cadence improvement.';
