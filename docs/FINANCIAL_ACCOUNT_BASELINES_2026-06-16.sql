-- Financial account baselines and reconciliation items - VIVO Ops
-- Date: 2026-06-16
--
-- Purpose:
-- Add the structure required to start account closures from a controlled baseline.
-- This does not change money_accounts, money_movements, payment_reports or existing closures.
--
-- Canonical idea:
-- baseline counted amount
-- + confirmed inflows after baseline
-- - confirmed outflows after baseline
-- +/- resolved inherited items
-- = expected amount for next closure

begin;

create table if not exists public.money_account_closure_baselines (
  id bigserial primary key,
  money_account_id bigint not null references public.money_accounts(id) on delete cascade,
  baseline_date date not null,
  baseline_at timestamptz not null,
  currency_code text not null,
  exchange_rate_ves_per_usd numeric(18, 6) null,
  expected_amount numeric(18, 2) not null default 0,
  counted_amount numeric(18, 2) not null default 0,
  difference_amount numeric(18, 2) not null default 0,
  expected_amount_usd numeric(18, 2) not null default 0,
  counted_amount_usd numeric(18, 2) not null default 0,
  difference_amount_usd numeric(18, 2) not null default 0,
  status text not null default 'active',
  reason text null,
  notes text null,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  voided_by_user_id uuid null,
  voided_at timestamptz null,
  void_reason text null,
  constraint money_account_closure_baselines_currency_check check (currency_code in ('USD', 'VES')),
  constraint money_account_closure_baselines_status_check check (status in ('active', 'superseded', 'voided')),
  constraint money_account_closure_baselines_ves_rate_check check (
    currency_code <> 'VES' or exchange_rate_ves_per_usd is not null
  )
);

create unique index if not exists idx_money_account_closure_baselines_one_active
on public.money_account_closure_baselines (money_account_id)
where status = 'active';

create index if not exists idx_money_account_closure_baselines_account_date
on public.money_account_closure_baselines (money_account_id, baseline_at desc);

create table if not exists public.money_account_reconciliation_items (
  id bigserial primary key,
  money_account_id bigint not null references public.money_accounts(id) on delete cascade,
  source_kind text not null,
  source_id bigint null,
  item_type text not null,
  direction text not null,
  currency_code text not null,
  amount numeric(18, 2) not null,
  amount_usd_equivalent numeric(18, 2) not null default 0,
  operation_date date null,
  reference_code text null,
  counterparty_name text null,
  description text not null,
  status text not null default 'open',
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  resolved_by_user_id uuid null,
  resolved_at timestamptz null,
  resolution_notes text null,
  voided_by_user_id uuid null,
  voided_at timestamptz null,
  void_reason text null,
  constraint money_account_reconciliation_items_source_check check (
    source_kind in ('baseline', 'closure', 'manual')
  ),
  constraint money_account_reconciliation_items_type_check check (
    item_type in (
      'unidentified_payment',
      'unregistered_fee',
      'unregistered_transfer',
      'conversion_difference',
      'amount_error',
      'timing_difference',
      'manual_adjustment',
      'other_pending'
    )
  ),
  constraint money_account_reconciliation_items_direction_check check (
    direction in ('surplus', 'shortage')
  ),
  constraint money_account_reconciliation_items_currency_check check (currency_code in ('USD', 'VES')),
  constraint money_account_reconciliation_items_status_check check (
    status in ('open', 'resolved', 'voided')
  ),
  constraint money_account_reconciliation_items_amount_check check (amount >= 0)
);

create index if not exists idx_money_account_reconciliation_items_account_status
on public.money_account_reconciliation_items (money_account_id, status, created_at desc);

create index if not exists idx_money_account_reconciliation_items_source
on public.money_account_reconciliation_items (source_kind, source_id);

-- Review query to run after this script.
select
  ma.id,
  ma.name,
  ma.currency_code,
  p.closure_kind,
  b.id as active_baseline_id,
  b.baseline_date,
  b.counted_amount,
  b.difference_amount,
  b.status as baseline_status
from public.money_accounts ma
left join public.money_account_closure_profiles p on p.money_account_id = ma.id
left join public.money_account_closure_baselines b
  on b.money_account_id = ma.id
 and b.status = 'active'
order by ma.id;

commit;
