-- Master operational inbox state persistence.
-- Apply this in Supabase before relying on shared reviewed/reopened state.

create table if not exists public.master_inbox_item_states (
  item_id text primary key,
  item_type text not null check (item_type in ('task', 'event')),
  order_id bigint references public.orders(id) on delete cascade,
  status text not null default 'reviewed' check (status in ('reviewed', 'resolved')),
  reviewed_by_user_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  resolved_by_user_id uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  reopened_by_user_id uuid references public.profiles(id) on delete set null,
  reopened_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists master_inbox_item_states_order_id_idx
  on public.master_inbox_item_states(order_id);

create index if not exists master_inbox_item_states_status_idx
  on public.master_inbox_item_states(status);

alter table public.master_inbox_item_states enable row level security;

drop policy if exists "Master inbox states are readable by master admins"
  on public.master_inbox_item_states;
create policy "Master inbox states are readable by master admins"
  on public.master_inbox_item_states
  for select
  using (
    exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.role in ('admin', 'master')
    )
  );

drop policy if exists "Master inbox states are writable by master admins"
  on public.master_inbox_item_states;
create policy "Master inbox states are writable by master admins"
  on public.master_inbox_item_states
  for all
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
