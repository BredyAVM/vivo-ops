-- Financial closure baseline grants and RLS - VIVO Ops
-- Date: 2026-06-17
--
-- Purpose:
-- Allow authenticated master/admin users to read and write the new baseline
-- and reconciliation tables from the app. Run this after
-- FINANCIAL_ACCOUNT_BASELINES_2026-06-16.sql.

begin;

alter table public.money_account_closure_baselines enable row level security;
alter table public.money_account_reconciliation_items enable row level security;

drop policy if exists "Money account baselines are readable by master admins"
  on public.money_account_closure_baselines;
create policy "Money account baselines are readable by master admins"
  on public.money_account_closure_baselines
  for select
  to authenticated
  using (public.is_master_or_admin());

drop policy if exists "Money account baselines are writable by master admins"
  on public.money_account_closure_baselines;
create policy "Money account baselines are writable by master admins"
  on public.money_account_closure_baselines
  for all
  to authenticated
  using (public.is_master_or_admin())
  with check (public.is_master_or_admin());

drop policy if exists "Reconciliation items are readable by master admins"
  on public.money_account_reconciliation_items;
create policy "Reconciliation items are readable by master admins"
  on public.money_account_reconciliation_items
  for select
  to authenticated
  using (public.is_master_or_admin());

drop policy if exists "Reconciliation items are writable by master admins"
  on public.money_account_reconciliation_items;
create policy "Reconciliation items are writable by master admins"
  on public.money_account_reconciliation_items
  for all
  to authenticated
  using (public.is_master_or_admin())
  with check (public.is_master_or_admin());

grant select, insert, update on public.money_account_closure_baselines to authenticated;
grant select, insert, update on public.money_account_reconciliation_items to authenticated;

grant usage, select on sequence public.money_account_closure_baselines_id_seq to authenticated;
grant usage, select on sequence public.money_account_reconciliation_items_id_seq to authenticated;

commit;

select
  'money_account_closure_baselines' as table_name,
  count(*) as rows
from public.money_account_closure_baselines
union all
select
  'money_account_reconciliation_items' as table_name,
  count(*) as rows
from public.money_account_reconciliation_items;

