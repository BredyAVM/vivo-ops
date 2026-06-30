-- Financial closure timestamps - VIVO Ops
-- Date: 2026-06-30
--
-- Purpose:
-- A closure is a financial snapshot at a specific moment, not just a day.
-- This allows points, banks, cash boxes and wallets to have more than one closure
-- in the same calendar day while keeping old closures compatible.

begin;

alter table public.money_account_closures
  add column if not exists closure_at timestamptz;

update public.money_account_closures
set closure_at = coalesce(
  closure_at,
  created_at,
  closure_date::timestamp at time zone 'America/Caracas'
)
where closure_at is null;

alter table public.money_account_closures
  alter column closure_at set not null;

create index if not exists idx_money_account_closures_account_at
on public.money_account_closures (money_account_id, closure_at desc);

drop index if exists idx_money_account_closures_one_active_per_day;

create unique index if not exists idx_money_account_closures_one_active_per_moment
on public.money_account_closures (money_account_id, closure_at)
where status in ('recorded', 'approved');

comment on column public.money_account_closures.closure_at is
  'Exact financial snapshot timestamp. closure_date remains the local operation date for reporting.';

select
  id,
  money_account_id,
  closure_date,
  closure_at,
  counted_amount,
  difference_amount,
  status
from public.money_account_closures
order by money_account_id, closure_at desc
limit 30;

commit;
