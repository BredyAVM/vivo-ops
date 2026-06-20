create table if not exists public.advisor_order_drafts (
  id bigserial primary key,
  advisor_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'quoted', 'converted', 'archived')),
  title text,
  client_id bigint references public.clients(id) on delete set null,
  client_snapshot jsonb not null default '{}'::jsonb,
  new_client_snapshot jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  quote_text text,
  total_usd numeric not null default 0,
  total_bs numeric not null default 0,
  fx_rate numeric,
  quoted_at timestamptz,
  converted_order_id bigint references public.orders(id) on delete set null,
  converted_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists advisor_order_drafts_advisor_status_updated_idx
  on public.advisor_order_drafts (advisor_user_id, status, updated_at desc);

create index if not exists advisor_order_drafts_client_idx
  on public.advisor_order_drafts (client_id);

create index if not exists advisor_order_drafts_converted_order_idx
  on public.advisor_order_drafts (converted_order_id);

create or replace function public.set_advisor_order_drafts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_advisor_order_drafts_updated_at on public.advisor_order_drafts;
create trigger set_advisor_order_drafts_updated_at
before update on public.advisor_order_drafts
for each row
execute function public.set_advisor_order_drafts_updated_at();

alter table public.advisor_order_drafts enable row level security;

drop policy if exists "advisor_order_drafts_select_own" on public.advisor_order_drafts;
create policy "advisor_order_drafts_select_own"
on public.advisor_order_drafts
for select
to authenticated
using (advisor_user_id = auth.uid());

drop policy if exists "advisor_order_drafts_insert_own" on public.advisor_order_drafts;
create policy "advisor_order_drafts_insert_own"
on public.advisor_order_drafts
for insert
to authenticated
with check (advisor_user_id = auth.uid());

drop policy if exists "advisor_order_drafts_update_own" on public.advisor_order_drafts;
create policy "advisor_order_drafts_update_own"
on public.advisor_order_drafts
for update
to authenticated
using (advisor_user_id = auth.uid())
with check (advisor_user_id = auth.uid());

drop policy if exists "advisor_order_drafts_delete_own" on public.advisor_order_drafts;
create policy "advisor_order_drafts_delete_own"
on public.advisor_order_drafts
for delete
to authenticated
using (advisor_user_id = auth.uid());
