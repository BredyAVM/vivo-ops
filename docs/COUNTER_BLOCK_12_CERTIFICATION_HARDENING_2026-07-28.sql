-- Counter Block 12 certification hardening.
--
-- Scope:
-- 1. Retire the obsolete authenticated dispatch command. The canonical
--    Counter flow is counter_dispatch_delivery(...), which atomically opens
--    custody, change and settlement state.
-- 2. Keep the existing active-account visibility for users outside Counter,
--    while limiting Counter operators to their configured direct accounts.
--
-- This migration does not change Kitchen policies, user role assignments,
-- application code or /app/master/dashboard.

begin;

revoke all on function public.counter_dispatch_order(bigint, integer)
  from public, anon, authenticated;
grant execute on function public.counter_dispatch_order(bigint, integer)
  to service_role;

drop policy if exists "ma_read_active_for_auth" on public.money_accounts;
drop policy if exists "counter_money_accounts_read_boundary" on public.money_accounts;

create policy "counter_money_accounts_read_boundary"
  on public.money_accounts
  for select
  to authenticated
  using (
    is_active = true
    and (
      not (select public.has_role('counter'))
      or (select public.is_master_or_admin())
      or public.is_counter_direct_money_account(id)
    )
  );

commit;
