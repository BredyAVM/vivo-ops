-- Lightweight operational and financial rollup for the master play dashboard.
-- It returns aggregates only, avoiding repeated client/order history downloads.

create or replace function public.crm_get_play_monitor_summary_v1(p_play_id bigint)
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

  with event_flags as (
    select
      member_row.id as play_member_id,
      pg_catalog.bool_or(event_row.event_type = 'contact') as launched,
      pg_catalog.bool_or(event_row.event_type = 'responded') as responded,
      pg_catalog.bool_or(event_row.event_type = 'unreachable') as marked_no_response
    from public.crm_play_members member_row
    left join public.crm_play_member_events event_row
      on event_row.play_member_id = member_row.id
    where member_row.play_id = p_play_id
      and member_row.workflow_status <> 'removed'
    group by member_row.id
  ),
  member_rollup as (
    select
      count(*)::integer as total_members,
      count(*) filter (where flags.launched)::integer as launched_members,
      count(*) filter (where flags.responded)::integer as responded_members,
      count(*) filter (
        where flags.marked_no_response and not flags.responded
      )::integer as no_response_members,
      count(*) filter (where member_row.benefit_status = 'redeemed')::integer as redeemed_members,
      count(*) filter (where member_row.benefit_status = 'expired')::integer as expired_members
    from public.crm_play_members member_row
    left join event_flags flags on flags.play_member_id = member_row.id
    where member_row.play_id = p_play_id
      and member_row.workflow_status <> 'removed'
  ),
  redemption_rollup as (
    select
      count(distinct redemption.play_member_id)::integer as redeemed_clients,
      count(distinct redemption.order_id)::integer as redemption_orders,
      coalesce(sum(redemption.benefit_credit_usd), 0)::numeric as benefit_credit_usd,
      coalesce(sum(redemption.advisor_charge_usd), 0)::numeric as advisor_charge_usd,
      coalesce(sum(redemption.company_cost_usd), 0)::numeric as company_cost_usd,
      coalesce(sum(redemption.customer_paid_difference_usd), 0)::numeric as customer_paid_difference_usd
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
    'total_members', member_rollup.total_members,
    'launched_members', member_rollup.launched_members,
    'responded_members', member_rollup.responded_members,
    'no_response_members', member_rollup.no_response_members,
    'redeemed_members', greatest(member_rollup.redeemed_members, redemption_rollup.redeemed_clients),
    'expired_members', member_rollup.expired_members,
    'redemption_orders', redemption_rollup.redemption_orders,
    'launch_rate_pct', case
      when member_rollup.total_members = 0 then 0
      else pg_catalog.round(member_rollup.launched_members * 100.0 / member_rollup.total_members, 1)
    end,
    'response_rate_pct', case
      when member_rollup.launched_members = 0 then 0
      else pg_catalog.round(member_rollup.responded_members * 100.0 / member_rollup.launched_members, 1)
    end,
    'redemption_rate_pct', case
      when member_rollup.total_members = 0 then 0
      else pg_catalog.round(
        greatest(member_rollup.redeemed_members, redemption_rollup.redeemed_clients)
          * 100.0 / member_rollup.total_members,
        1
      )
    end,
    'benefit_credit_usd', pg_catalog.round(redemption_rollup.benefit_credit_usd, 2),
    'advisor_charge_usd', pg_catalog.round(redemption_rollup.advisor_charge_usd, 2),
    'company_cost_usd', pg_catalog.round(redemption_rollup.company_cost_usd, 2),
    'customer_paid_difference_usd', pg_catalog.round(redemption_rollup.customer_paid_difference_usd, 2),
    'direct_order_revenue_usd', pg_catalog.round(direct_sales.direct_order_revenue_usd, 2),
    'generated_at', pg_catalog.now()
  ) into result
  from member_rollup
  cross join redemption_rollup
  cross join direct_sales;

  return coalesce(result, '{}'::jsonb);
end;
$$;

revoke all on function public.crm_get_play_monitor_summary_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_get_play_monitor_summary_v1(bigint)
  to authenticated, service_role;

comment on function public.crm_get_play_monitor_summary_v1(bigint) is
  'Returns aggregate launch, response, redemption and frozen campaign economics for one CRM play.';
