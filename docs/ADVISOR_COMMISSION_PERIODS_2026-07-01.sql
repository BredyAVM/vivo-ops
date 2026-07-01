create table if not exists public.advisor_commission_periods (
  id bigserial primary key,
  name text not null,
  date_from date not null,
  date_to date not null,
  status text not null default 'open'
    check (status in ('open', 'archived')),
  notes text,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advisor_commission_periods_date_check check (date_from <= date_to),
  constraint advisor_commission_periods_range_unique unique (date_from, date_to)
);

create table if not exists public.advisor_commission_closures (
  id bigserial primary key,
  period_id bigint not null references public.advisor_commission_periods(id) on delete cascade,
  advisor_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'preliminary'
    check (status in ('preliminary', 'closed', 'paid')),
  base_commission_pct numeric not null default 8,
  delivered_orders_count integer not null default 0,
  billed_usd numeric not null default 0,
  regular_base_usd numeric not null default 0,
  special_item_base_usd numeric not null default 0,
  special_order_base_usd numeric not null default 0,
  gross_commission_usd numeric not null default 0,
  pending_collection_usd numeric not null default 0,
  punctual_paid_count integer not null default 0,
  late_paid_count integer not null default 0,
  pending_payment_count integer not null default 0,
  new_own_clients_count integer not null default 0,
  new_assigned_clients_count integer not null default 0,
  gift_deductions_usd numeric not null default 0,
  manual_deductions_usd numeric not null default 0,
  payable_usd numeric not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  generated_by_user_id uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  closed_by_user_id uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  paid_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advisor_commission_closures_period_advisor_unique unique (period_id, advisor_user_id)
);

create table if not exists public.advisor_commission_deductions (
  id bigserial primary key,
  closure_id bigint not null references public.advisor_commission_closures(id) on delete cascade,
  deduction_type text not null default 'other'
    check (deduction_type in ('gift', 'manual_expense', 'assumed_debt', 'adjustment', 'other')),
  description text not null,
  amount_usd numeric not null default 0,
  order_id bigint references public.orders(id) on delete set null,
  client_id bigint references public.clients(id) on delete set null,
  product_id bigint references public.products(id) on delete set null,
  notes text,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists advisor_commission_periods_status_date_idx
  on public.advisor_commission_periods (status, date_from desc, date_to desc);

create index if not exists advisor_commission_closures_advisor_status_idx
  on public.advisor_commission_closures (advisor_user_id, status, generated_at desc);

create index if not exists advisor_commission_closures_period_status_idx
  on public.advisor_commission_closures (period_id, status, advisor_user_id);

create index if not exists advisor_commission_deductions_closure_idx
  on public.advisor_commission_deductions (closure_id, created_at desc);

create or replace function public.set_advisor_commission_periods_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_advisor_commission_periods_updated_at on public.advisor_commission_periods;
create trigger set_advisor_commission_periods_updated_at
before update on public.advisor_commission_periods
for each row
execute function public.set_advisor_commission_periods_updated_at();

create or replace function public.set_advisor_commission_closures_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_advisor_commission_closures_updated_at on public.advisor_commission_closures;
create trigger set_advisor_commission_closures_updated_at
before update on public.advisor_commission_closures
for each row
execute function public.set_advisor_commission_closures_updated_at();

alter table public.advisor_commission_periods enable row level security;
alter table public.advisor_commission_closures enable row level security;
alter table public.advisor_commission_deductions enable row level security;

drop policy if exists "advisor_commission_periods_select_staff" on public.advisor_commission_periods;
create policy "advisor_commission_periods_select_staff"
on public.advisor_commission_periods
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master', 'advisor')
  )
);

drop policy if exists "advisor_commission_periods_admin_all" on public.advisor_commission_periods;
create policy "advisor_commission_periods_admin_all"
on public.advisor_commission_periods
for all
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
)
with check (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
);

drop policy if exists "advisor_commission_closures_select_staff" on public.advisor_commission_closures;
create policy "advisor_commission_closures_select_staff"
on public.advisor_commission_closures
for select
to authenticated
using (
  advisor_user_id = auth.uid()
  or exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
);

drop policy if exists "advisor_commission_closures_admin_all" on public.advisor_commission_closures;
create policy "advisor_commission_closures_admin_all"
on public.advisor_commission_closures
for all
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
)
with check (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
);

drop policy if exists "advisor_commission_deductions_select_staff" on public.advisor_commission_deductions;
create policy "advisor_commission_deductions_select_staff"
on public.advisor_commission_deductions
for select
to authenticated
using (
  exists (
    select 1
    from public.advisor_commission_closures c
    where c.id = closure_id
      and (
        c.advisor_user_id = auth.uid()
        or exists (
          select 1
          from public.user_roles ur
          where ur.user_id = auth.uid()
            and ur.role in ('admin', 'master')
        )
      )
  )
);

drop policy if exists "advisor_commission_deductions_admin_all" on public.advisor_commission_deductions;
create policy "advisor_commission_deductions_admin_all"
on public.advisor_commission_deductions
for all
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
)
with check (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'master')
  )
);
