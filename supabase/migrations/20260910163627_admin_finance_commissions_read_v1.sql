-- Read existing commission snapshots, never recalculate or mutate settlements.
begin;
set local lock_timeout = '5s';
create or replace function public.admin_finance_commissions_read_v1()
returns jsonb language plpgsql stable security invoker set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Invoker preserves all existing RLS policies. One statement = one read snapshot.
  with periods as materialized (
    select id, name, date_from, date_to, status from public.advisor_commission_periods
  ), advisors as materialized (
    select p.id, a.full_name
    from public.get_advisor_profiles() a
    join public.profiles p on p.id = a.user_id
    where a.is_active = true and p.is_active = true and p.receives_commissions = true
  ), closures as materialized (
    select c.id, c.period_id, c.advisor_user_id, c.status, c.gross_commission_usd,
      c.gift_deductions_usd, c.manual_deductions_usd, c.pending_collection_usd, c.payable_usd,
      c.generated_at, c.closed_at, c.paid_at,
      coalesce(nullif(btrim(p.full_name), ''), nullif(c.snapshot #>> '{advisor,name}', ''), 'Sin nombre') as advisor_name,
      exists(select 1 from advisors a where a.id=c.advisor_user_id) as eligible_now,
      jsonb_build_object('version', c.snapshot->'version', 'totals', c.snapshot->'totals',
        'settlement', c.snapshot->'settlement', 'commissionWorkflow', c.snapshot->'commissionWorkflow') as snapshot
    from public.advisor_commission_closures c
    left join public.profiles p on p.id = c.advisor_user_id
  ), payments as materialized (
    select id, description, amount_usd_equivalent, movement_date
    from public.money_movements
    where status = 'confirmed' and direction = 'outflow' and movement_type = 'expense_payment'
      and description like 'Liquidación de comisión · Cierre %'
  )
  select jsonb_build_object(
    'definitionVersion', 'admin-finance-commissions-v1',
    'asOf', pg_catalog.statement_timestamp(),
    'paymentLinkBasis', 'legacy_description',
    'periodCount', (select count(*) from periods),
    'closureCount', (select count(*) from closures),
    'paymentCount', (select count(*) from payments),
    'periods', coalesce((select jsonb_agg(to_jsonb(p) order by p.date_from desc, p.id desc) from periods p), '[]'::jsonb),
    'closures', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from closures c), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from payments m), '[]'::jsonb),
    'eligibleAdvisorIds', coalesce((select jsonb_agg(a.id order by a.id) from advisors a), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.admin_finance_commissions_read_v1() from public, anon, authenticated, service_role;
grant execute on function public.admin_finance_commissions_read_v1() to authenticated;
comment on function public.admin_finance_commissions_read_v1() is
  'Admin-only invoker read of stored commission snapshots. Payment descriptions are diagnostic references, not certified settlement links.';
commit;
