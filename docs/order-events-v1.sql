create extension if not exists pgcrypto;

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.orders(id) on delete cascade,
  order_number text null,
  event_type text not null,
  event_group text not null,
  title text not null,
  message text null,
  severity text not null default 'info',
  actor_user_id uuid null references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.order_event_recipients (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.order_events(id) on delete cascade,
  target_role text null,
  target_user_id uuid null references public.profiles(id) on delete cascade,
  requires_action boolean not null default false,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists order_events_order_id_created_at_idx
  on public.order_events(order_id, created_at desc);

create index if not exists order_event_recipients_user_idx
  on public.order_event_recipients(target_user_id, read_at, created_at desc);

create index if not exists order_event_recipients_role_idx
  on public.order_event_recipients(target_role, read_at, created_at desc);

alter table public.order_events enable row level security;
alter table public.order_event_recipients enable row level security;

drop policy if exists "order_events_authenticated_select" on public.order_events;
create policy "order_events_authenticated_select"
on public.order_events
for select
to authenticated
using (true);

drop policy if exists "order_events_authenticated_insert" on public.order_events;
create policy "order_events_authenticated_insert"
on public.order_events
for insert
to authenticated
with check (true);

drop policy if exists "order_event_recipients_authenticated_select" on public.order_event_recipients;
create policy "order_event_recipients_authenticated_select"
on public.order_event_recipients
for select
to authenticated
using (true);

drop policy if exists "order_event_recipients_authenticated_insert" on public.order_event_recipients;
create policy "order_event_recipients_authenticated_insert"
on public.order_event_recipients
for insert
to authenticated
with check (true);

drop policy if exists "order_event_recipients_authenticated_update" on public.order_event_recipients;
create policy "order_event_recipients_authenticated_update"
on public.order_event_recipients
for update
to authenticated
using (true)
with check (true);
