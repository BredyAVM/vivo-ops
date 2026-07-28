-- Counter Block 12 certification hardening rollback.
--
-- This restores the exact pre-Block-12 access surface. It should only be used
-- to recover from an operational regression because it re-enables the obsolete
-- authenticated dispatch command and broad active-account visibility.

begin;

drop policy if exists "counter_money_accounts_read_boundary"
  on public.money_accounts;
drop policy if exists "ma_read_active_for_auth"
  on public.money_accounts;

create policy "ma_read_active_for_auth"
  on public.money_accounts
  for select
  to authenticated
  using (is_active = true);

grant execute on function public.counter_dispatch_order(bigint, integer)
  to authenticated, service_role;

commit;
