-- P07: current obligations for approved, not-yet-delivered orders.
-- Read-only: never infer cash receipts or a promised payment date from the schedule.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.admin_finance_active_orders_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_as_of timestamptz := pg_catalog.statement_timestamp();
  v_date date := (v_as_of at time zone 'America/Caracas')::date;
  v_result jsonb;
begin
  -- Check persisted roles, not caller-supplied metadata. This definer is needed
  -- to reach the private canonical calculator without widening its privileges.
  if v_uid is null or not exists (
    select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  with active as materialized (
    select o.id,
      coalesce(nullif(btrim(o.order_number), ''), '#' || o.id::text) as order_number,
      coalesce(nullif(btrim(c.full_name), ''), 'Sin cliente') as client_name,
      coalesce(nullif(btrim(p.full_name), ''), 'Sin asesor') as advisor_name,
      o.status::text as status, o.fulfillment::text as fulfillment,
      coalesce(o.needs_reapproval, false) or coalesce(o.queued_needs_reapproval, false) as needs_review,
      app_private.admin_finance_safe_date_v1(o.extra_fields #>> '{schedule,date}') as scheduled_date,
      case when o.extra_fields #>> '{schedule,time_24}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        then o.extra_fields #>> '{schedule,time_24}' end as scheduled_time
    from public.orders o
    left join public.clients c on c.id = o.client_id
    left join public.profiles p on p.id = o.attributed_advisor_id
    where o.status in ('queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
  ), financial as materialized (
    select a.*, s.total_usd, s.pending_usd,
      least(s.total_usd, greatest(0, s.total_usd - s.pending_usd)) as covered_usd,
      s.pending_reports_usd, s.pending_reports_count,
      case when a.scheduled_date is null or a.needs_review or s.pending_usd > s.total_usd
        then 'Q3_incomplete' else 'Q1_exact' end as quality_code
    from active a
    cross join lateral public.get_order_financial_state(a.id, v_date, null) s
  )
  select jsonb_build_object(
    'definitionVersion', 'admin-finance-active-orders-v1',
    'asOf', v_as_of, 'asOfDate', v_date,
    'cutoffMode', 'current_statement',
    'balanceSource', 'canonical_order_financial_state',
    'timeAxis', 'scheduled_date', 'currency', 'USD',
    'summary', jsonb_build_object(
      'orders', count(*),
      'totalUsd', coalesce(sum(f.total_usd), 0),
      'coveredUsd', coalesce(sum(f.covered_usd), 0),
      'pendingUsd', coalesce(sum(f.pending_usd), 0),
      'pendingReportsUsd', coalesce(sum(f.pending_reports_usd), 0),
      'pendingReportsCount', coalesce(sum(f.pending_reports_count), 0),
      'reviewOrders', count(*) filter (where f.needs_review),
      'unscheduledOrders', count(*) filter (where f.scheduled_date is null)
    ),
    'orders', coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'orderNumber', f.order_number,
      'clientName', f.client_name, 'advisorName', f.advisor_name,
      'status', f.status, 'fulfillment', f.fulfillment,
      'needsReview', f.needs_review,
      'scheduledDate', f.scheduled_date, 'scheduledTime', f.scheduled_time,
      'totalUsd', f.total_usd, 'coveredUsd', f.covered_usd, 'pendingUsd', f.pending_usd,
      'pendingReportsUsd', f.pending_reports_usd, 'pendingReportsCount', f.pending_reports_count,
      'qualityCode', f.quality_code
    ) order by f.scheduled_date nulls first, f.scheduled_time nulls first, f.id), '[]'::jsonb)
  ) into v_result from financial f;

  return v_result;
end;
$function$;

revoke all on function public.admin_finance_active_orders_v1() from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_active_orders_v1() to authenticated, service_role;
comment on function public.admin_finance_active_orders_v1() is
  'Admin-only P07 current snapshot. Approved queued and executing orders; canonical balances; schedule is not a cash forecast. No writes.';
commit;
