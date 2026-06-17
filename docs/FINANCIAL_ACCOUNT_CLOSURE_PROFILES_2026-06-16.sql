-- Financial account closure profiles - VIVO Ops
-- Date: 2026-06-16
--
-- Purpose:
-- Add a non-invasive closure profile layer for the existing money accounts.
-- This does not change money_accounts, money_movements, payment_reports or existing closures.
-- It only defines how each account should behave when closures/reconciliations are implemented.

begin;

create table if not exists public.money_account_closure_profiles (
  id bigserial primary key,
  money_account_id bigint not null references public.money_accounts(id) on delete cascade,
  closure_kind text not null,
  requires_zero_difference boolean not null default false,
  allows_classified_difference boolean not null default true,
  generates_transfer_on_close boolean not null default false,
  default_target_money_account_id bigint null references public.money_accounts(id),
  baseline_required boolean not null default true,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint money_account_closure_profiles_account_unique unique (money_account_id),
  constraint money_account_closure_profiles_kind_check check (
    closure_kind in ('bank', 'cash', 'pos', 'wallet_usd', 'retention', 'fund', 'other')
  )
);

create index if not exists idx_money_account_closure_profiles_kind
on public.money_account_closure_profiles (closure_kind);

-- Seed profiles for the accounts that already exist.
-- Important: this intentionally keeps money_accounts.account_kind unchanged.
insert into public.money_account_closure_profiles (
  money_account_id,
  closure_kind,
  requires_zero_difference,
  allows_classified_difference,
  generates_transfer_on_close,
  baseline_required,
  notes
)
select
  ma.id,
  case
    when lower(ma.name) = 'retenciones' then 'retention'
    when ma.account_kind = 'pos' then 'pos'
    when ma.account_kind = 'cash' then 'cash'
    when ma.account_kind = 'bank' then 'bank'
    when ma.account_kind = 'wallet' and ma.currency_code = 'USD' then 'wallet_usd'
    when ma.account_kind = 'fund' then 'fund'
    else 'other'
  end as closure_kind,
  case
    when lower(ma.name) = 'retenciones' then false
    when ma.account_kind in ('cash', 'pos', 'fund') then true
    else false
  end as requires_zero_difference,
  case
    when ma.account_kind in ('cash', 'pos', 'fund') then false
    else true
  end as allows_classified_difference,
  case when ma.account_kind = 'pos' then true else false end as generates_transfer_on_close,
  true as baseline_required,
  case
    when lower(ma.name) = 'retenciones' then 'Perfil canonico: retenciones fiscales por documentos recibidos, aplicados y pendientes.'
    when ma.account_kind = 'pos' then 'Perfil canonico: cuenta temporal de punto, debe cerrar en cero y transferir al banco receptor.'
    when ma.account_kind = 'cash' then 'Perfil canonico: caja fisica, debe cerrar en cero o con ajuste formal.'
    when ma.account_kind = 'bank' then 'Perfil canonico: banco, puede cerrar con diferencia clasificada.'
    when ma.account_kind = 'wallet' and ma.currency_code = 'USD' then 'Perfil canonico: wallet USD, puede cerrar con diferencia clasificada por conversion, fee o pendiente.'
    when ma.account_kind = 'fund' then 'Perfil canonico: fondo, debe coincidir con ledger de fondo.'
    else 'Perfil canonico pendiente de definicion administrativa.'
  end as notes
from public.money_accounts ma
where not exists (
  select 1
  from public.money_account_closure_profiles p
  where p.money_account_id = ma.id
);

-- Review query to run after this script.
select
  ma.id,
  ma.name,
  ma.currency_code,
  ma.account_kind as current_account_kind,
  p.closure_kind,
  p.requires_zero_difference,
  p.allows_classified_difference,
  p.generates_transfer_on_close,
  p.default_target_money_account_id,
  p.baseline_required
from public.money_accounts ma
join public.money_account_closure_profiles p on p.money_account_id = ma.id
order by ma.id;

commit;
