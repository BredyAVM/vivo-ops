-- Historical commercial facts and the lightweight CRM play snapshot foundation.
--
-- Historical rows are intentionally isolated from public.orders/order_items so
-- importing them cannot trigger kitchen, inventory, payments, commissions, or
-- operational notifications. Only batches marked ready enter the unified facts
-- view used by CRM reporting.

create table public.historical_import_batches (
  id bigint generated always as identity primary key,
  source_system text not null,
  source_file_name text not null,
  source_sha256 text not null,
  cutoff_date date not null,
  status text not null default 'loading',
  expected_order_count integer not null,
  expected_purchase_count integer not null,
  expected_gift_event_count integer not null,
  expected_item_count integer not null,
  expected_net_total_usd numeric(16,2) not null,
  imported_by_user_id uuid references public.profiles(id) on delete set null,
  audit_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  constraint historical_import_batches_source_system_check
    check (btrim(source_system) <> ''),
  constraint historical_import_batches_source_file_name_check
    check (btrim(source_file_name) <> ''),
  constraint historical_import_batches_sha256_check
    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint historical_import_batches_status_check
    check (status in ('loading', 'ready', 'failed')),
  constraint historical_import_batches_expected_counts_check
    check (
      expected_order_count >= 0
      and expected_purchase_count >= 0
      and expected_gift_event_count >= 0
      and expected_item_count >= 0
      and expected_order_count = expected_purchase_count + expected_gift_event_count
    ),
  constraint historical_import_batches_expected_total_check
    check (expected_net_total_usd >= 0),
  constraint historical_import_batches_audit_summary_check
    check (jsonb_typeof(audit_summary) = 'object'),
  constraint historical_import_batches_ready_at_check
    check (
      (status = 'ready' and ready_at is not null)
      or (status <> 'ready' and ready_at is null)
    ),
  constraint historical_import_batches_source_unique
    unique (source_system, source_sha256, cutoff_date)
);

create table public.historical_orders (
  id bigint generated always as identity primary key,
  import_batch_id bigint not null
    references public.historical_import_batches(id) on delete cascade,
  source_system text not null,
  source_control text not null,
  source_row integer not null,
  source_fingerprint text not null,
  client_id bigint not null references public.clients(id) on delete restrict,
  legacy_client_control text not null,
  source_created_on date,
  purchased_at timestamptz not null,
  attributed_advisor_id uuid references public.profiles(id) on delete set null,
  advisor_name_snapshot text not null,
  fulfillment public.fulfillment_type not null,
  event_kind text not null,
  net_total_usd numeric(16,2) not null,
  gift_tags text[] not null default array[]::text[],
  source_product_summary text,
  source_notes text,
  created_at timestamptz not null default now(),
  constraint historical_orders_source_system_check
    check (btrim(source_system) <> ''),
  constraint historical_orders_source_control_check
    check (btrim(source_control) <> ''),
  constraint historical_orders_source_row_check
    check (source_row > 1),
  constraint historical_orders_source_fingerprint_check
    check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint historical_orders_legacy_client_control_check
    check (btrim(legacy_client_control) <> ''),
  constraint historical_orders_advisor_snapshot_check
    check (btrim(advisor_name_snapshot) <> ''),
  constraint historical_orders_cutoff_check
    check (purchased_at < timestamptz '2026-06-01 00:00:00-04'),
  constraint historical_orders_event_kind_check
    check (event_kind in ('purchase', 'gift_only')),
  constraint historical_orders_net_total_check
    check (
      (event_kind = 'purchase' and net_total_usd > 0)
      or (event_kind = 'gift_only' and net_total_usd = 0)
    ),
  constraint historical_orders_gift_event_check
    check (event_kind <> 'gift_only' or cardinality(gift_tags) > 0),
  constraint historical_orders_source_control_unique
    unique (source_system, source_control),
  constraint historical_orders_id_batch_unique
    unique (id, import_batch_id)
);

create table public.historical_order_items (
  id bigint generated always as identity primary key,
  import_batch_id bigint not null
    references public.historical_import_batches(id) on delete cascade,
  historical_order_id bigint not null,
  source_line_no integer not null,
  source_fingerprint text not null,
  legacy_product_code text not null,
  product_id bigint references public.products(id) on delete set null,
  product_name_snapshot text not null,
  quantity numeric(14,3) not null,
  unit_price_usd numeric(16,4) not null,
  line_total_usd numeric(16,2) not null,
  created_at timestamptz not null default now(),
  constraint historical_order_items_source_line_check
    check (source_line_no > 1),
  constraint historical_order_items_source_fingerprint_check
    check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint historical_order_items_legacy_product_code_check
    check (btrim(legacy_product_code) <> ''),
  constraint historical_order_items_product_name_check
    check (btrim(product_name_snapshot) <> ''),
  constraint historical_order_items_quantity_check
    check (quantity > 0),
  constraint historical_order_items_unit_price_check
    check (unit_price_usd >= 0),
  constraint historical_order_items_line_total_check
    check (line_total_usd >= 0),
  constraint historical_order_items_order_batch_fk
    foreign key (historical_order_id, import_batch_id)
    references public.historical_orders(id, import_batch_id) on delete cascade,
  constraint historical_order_items_source_line_unique
    unique (historical_order_id, source_line_no)
);

create index historical_orders_import_batch_id_idx
  on public.historical_orders(import_batch_id);

create index historical_orders_client_purchased_at_idx
  on public.historical_orders(client_id, purchased_at desc);

create index historical_orders_advisor_purchased_at_idx
  on public.historical_orders(attributed_advisor_id, purchased_at desc)
  where attributed_advisor_id is not null;

create index historical_orders_purchased_at_idx
  on public.historical_orders(purchased_at desc);

create index historical_orders_gift_purchased_at_idx
  on public.historical_orders(purchased_at desc)
  where event_kind = 'gift_only' or cardinality(gift_tags) > 0;

create index historical_order_items_product_id_idx
  on public.historical_order_items(product_id)
  where product_id is not null;

create index historical_order_items_import_batch_id_idx
  on public.historical_order_items(import_batch_id);

create table public.crm_plays (
  id bigint generated always as identity primary key,
  series_key text not null,
  version integer not null default 1,
  supersedes_play_id bigint references public.crm_plays(id) on delete set null,
  name text not null,
  description text,
  status text not null default 'draft',
  rules_snapshot jsonb not null default '{}'::jsonb,
  selection_summary jsonb not null default '{}'::jsonb,
  metric_window smallint not null default 6,
  gift_product_id bigint not null references public.products(id) on delete restrict,
  gift_quantity numeric(12,3) not null default 1,
  starts_at timestamptz,
  ends_at timestamptz,
  snapshot_at timestamptz,
  activated_at timestamptz,
  closed_at timestamptz,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  activated_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_plays_series_key_check
    check (series_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  constraint crm_plays_version_check
    check (version > 0),
  constraint crm_plays_name_check
    check (btrim(name) <> ''),
  constraint crm_plays_status_check
    check (status in ('draft', 'frozen', 'active', 'paused', 'closed', 'cancelled')),
  constraint crm_plays_rules_snapshot_check
    check (jsonb_typeof(rules_snapshot) = 'object'),
  constraint crm_plays_selection_summary_check
    check (jsonb_typeof(selection_summary) = 'object'),
  constraint crm_plays_metric_window_check
    check (metric_window between 2 and 50),
  constraint crm_plays_gift_quantity_check
    check (gift_quantity > 0),
  constraint crm_plays_period_check
    check (starts_at is null or ends_at is null or starts_at < ends_at),
  constraint crm_plays_snapshot_status_check
    check (
      (status = 'draft' and snapshot_at is null)
      or status = 'cancelled'
      or (status not in ('draft', 'cancelled') and snapshot_at is not null)
    ),
  constraint crm_plays_activation_status_check
    check (
      (
        status in ('active', 'paused', 'closed')
        and activated_at is not null
        and activated_by_user_id is not null
      )
      or (status not in ('active', 'paused', 'closed'))
    ),
  constraint crm_plays_closed_status_check
    check ((status = 'closed' and closed_at is not null) or status <> 'closed'),
  constraint crm_plays_series_version_unique
    unique (series_key, version)
);

create table public.crm_play_members (
  id bigint generated always as identity primary key,
  play_id bigint not null references public.crm_plays(id) on delete restrict,
  client_id bigint not null references public.clients(id) on delete restrict,
  advisor_id_snapshot uuid references public.profiles(id) on delete set null,
  eligible_at timestamptz not null,
  workflow_status text not null default 'pending',
  benefit_status text not null default 'available',
  first_purchase_on date,
  last_purchase_on date,
  purchase_count integer not null,
  net_revenue_usd numeric(16,2) not null,
  average_ticket_usd numeric(16,2),
  cadence_days numeric(12,2),
  cadence_window smallint not null,
  last_advisor_id uuid references public.profiles(id) on delete set null,
  last_advisor_name_snapshot text,
  last_gift_on date,
  days_since_last_purchase integer,
  used_pickup boolean not null default false,
  used_delivery boolean not null default false,
  decision_snapshot jsonb not null default '{}'::jsonb,
  eligibility_reasons text[] not null default array[]::text[],
  contacted_at timestamptz,
  benefit_reserved_at timestamptz,
  benefit_redeemed_at timestamptz,
  benefit_expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_play_members_workflow_status_check
    check (workflow_status in ('pending', 'contacted', 'converted', 'not_interested', 'unreachable', 'removed')),
  constraint crm_play_members_benefit_status_check
    check (benefit_status in ('available', 'reserved', 'redeemed', 'expired', 'cancelled')),
  constraint crm_play_members_purchase_count_check
    check (purchase_count >= 0),
  constraint crm_play_members_net_revenue_check
    check (net_revenue_usd >= 0),
  constraint crm_play_members_average_ticket_check
    check (average_ticket_usd is null or average_ticket_usd >= 0),
  constraint crm_play_members_cadence_check
    check (cadence_days is null or cadence_days >= 0),
  constraint crm_play_members_cadence_window_check
    check (cadence_window between 2 and 50),
  constraint crm_play_members_days_since_purchase_check
    check (days_since_last_purchase is null or days_since_last_purchase >= 0),
  constraint crm_play_members_decision_snapshot_check
    check (jsonb_typeof(decision_snapshot) = 'object'),
  constraint crm_play_members_play_client_unique
    unique (play_id, client_id)
);

create table public.crm_play_redemptions (
  id bigint generated always as identity primary key,
  play_member_id bigint not null references public.crm_play_members(id) on delete restrict,
  order_id bigint not null references public.orders(id) on delete restrict,
  order_item_id bigint references public.order_items(id) on delete set null,
  product_id bigint not null references public.products(id) on delete restrict,
  quantity numeric(12,3) not null,
  status text not null default 'redeemed',
  redeemed_by_user_id uuid not null references public.profiles(id) on delete restrict,
  redeemed_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  constraint crm_play_redemptions_quantity_check
    check (quantity > 0),
  constraint crm_play_redemptions_status_check
    check (status in ('redeemed', 'voided')),
  constraint crm_play_redemptions_void_check
    check (
      (status = 'voided' and voided_at is not null and btrim(coalesce(void_reason, '')) <> '')
      or (status = 'redeemed' and voided_at is null and void_reason is null)
    )
);

create index crm_plays_status_period_idx
  on public.crm_plays(status, starts_at, ends_at);

create index crm_plays_gift_product_id_idx
  on public.crm_plays(gift_product_id);

create index crm_plays_supersedes_play_id_idx
  on public.crm_plays(supersedes_play_id)
  where supersedes_play_id is not null;

create index crm_play_members_advisor_play_status_idx
  on public.crm_play_members(advisor_id_snapshot, play_id, workflow_status)
  where advisor_id_snapshot is not null;

create index crm_play_members_client_benefit_idx
  on public.crm_play_members(client_id, benefit_status, play_id);

create index crm_play_members_last_advisor_id_idx
  on public.crm_play_members(last_advisor_id)
  where last_advisor_id is not null;

create unique index crm_play_redemptions_active_member_unique
  on public.crm_play_redemptions(play_member_id)
  where status = 'redeemed';

create index crm_play_redemptions_play_member_id_idx
  on public.crm_play_redemptions(play_member_id);

create unique index crm_play_redemptions_order_item_unique
  on public.crm_play_redemptions(order_item_id)
  where order_item_id is not null and status = 'redeemed';

create index crm_play_redemptions_order_id_idx
  on public.crm_play_redemptions(order_id);

create index crm_play_redemptions_product_id_idx
  on public.crm_play_redemptions(product_id);

create or replace function app_private.crm_set_updated_at_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function app_private.crm_set_updated_at_v1() from public, anon, authenticated;
grant execute on function app_private.crm_set_updated_at_v1() to service_role;

create or replace function app_private.historical_import_batch_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'ready' then
    raise exception 'A ready historical import batch is immutable';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.historical_import_batch_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.historical_import_batch_guard_v1() to service_role;

create or replace function app_private.crm_play_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and (
    new.series_key is distinct from old.series_key
    or new.version is distinct from old.version
    or new.supersedes_play_id is distinct from old.supersedes_play_id
    or new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.rules_snapshot is distinct from old.rules_snapshot
    or new.selection_summary is distinct from old.selection_summary
    or new.metric_window is distinct from old.metric_window
    or new.gift_product_id is distinct from old.gift_product_id
    or new.gift_quantity is distinct from old.gift_quantity
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.snapshot_at is distinct from old.snapshot_at
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'A frozen CRM play definition is immutable';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('frozen', 'cancelled'))
    or (old.status = 'frozen' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('paused', 'closed', 'cancelled'))
    or (old.status = 'paused' and new.status in ('active', 'closed', 'cancelled'))
  ) then
    raise exception 'Invalid CRM play status transition: % -> %', old.status, new.status;
  end if;

  if new.status is not distinct from old.status
    and old.status <> 'draft'
    and (
      new.activated_at is distinct from old.activated_at
      or new.activated_by_user_id is distinct from old.activated_by_user_id
      or new.closed_at is distinct from old.closed_at
    )
  then
    raise exception 'CRM play lifecycle timestamps can only change with a status transition';
  end if;

  if new.status = 'frozen' and (
    new.activated_at is not null
    or new.activated_by_user_id is not null
    or new.closed_at is not null
  ) then
    raise exception 'A frozen CRM play cannot contain activation or closure timestamps';
  end if;

  if new.status = 'active' and old.status = 'frozen' and (
    new.activated_at is null or new.activated_by_user_id is null
  ) then
    raise exception 'CRM play activation requires actor and timestamp';
  end if;

  if new.status = 'closed' and new.closed_at is null then
    raise exception 'Closing a CRM play requires closed_at';
  end if;

  return new;
end;
$$;

revoke all on function app_private.crm_play_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_guard_v1() to service_role;

create or replace function app_private.historical_fact_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_batch_status text;
  new_batch_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select import_batch.status
      into old_batch_status
    from public.historical_import_batches import_batch
    where import_batch.id = old.import_batch_id;

    if old_batch_status is distinct from 'loading' then
      raise exception 'Historical facts are mutable only while their batch is loading';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select import_batch.status
      into new_batch_status
    from public.historical_import_batches import_batch
    where import_batch.id = new.import_batch_id;

    if new_batch_status is distinct from 'loading' then
      raise exception 'Historical facts can be written only to a loading batch';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.historical_fact_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.historical_fact_guard_v1() to service_role;

create or replace function app_private.crm_play_member_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
begin
  select play.status
    into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;

  if tg_op = 'INSERT' and play_status <> 'draft' then
    raise exception 'CRM play members can only be selected while the play is a draft';
  end if;

  if tg_op = 'DELETE' and play_status <> 'draft' then
    raise exception 'A frozen CRM play member cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if play_status in ('frozen', 'closed', 'cancelled') then
      raise exception 'CRM play members cannot change while the play is %', play_status;
    end if;

    if play_status <> 'draft' and (
      new.play_id is distinct from old.play_id
      or new.client_id is distinct from old.client_id
      or new.advisor_id_snapshot is distinct from old.advisor_id_snapshot
      or new.eligible_at is distinct from old.eligible_at
      or new.first_purchase_on is distinct from old.first_purchase_on
      or new.last_purchase_on is distinct from old.last_purchase_on
      or new.purchase_count is distinct from old.purchase_count
      or new.net_revenue_usd is distinct from old.net_revenue_usd
      or new.average_ticket_usd is distinct from old.average_ticket_usd
      or new.cadence_days is distinct from old.cadence_days
      or new.cadence_window is distinct from old.cadence_window
      or new.last_advisor_id is distinct from old.last_advisor_id
      or new.last_advisor_name_snapshot is distinct from old.last_advisor_name_snapshot
      or new.last_gift_on is distinct from old.last_gift_on
      or new.days_since_last_purchase is distinct from old.days_since_last_purchase
      or new.used_pickup is distinct from old.used_pickup
      or new.used_delivery is distinct from old.used_delivery
      or new.decision_snapshot is distinct from old.decision_snapshot
      or new.eligibility_reasons is distinct from old.eligibility_reasons
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'Frozen CRM play member decision data is immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_member_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_member_guard_v1() to service_role;

create or replace function app_private.crm_play_redemption_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
  play_product_id bigint;
  play_quantity numeric;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
  member_client_id bigint;
  member_benefit_status text;
  order_client_id bigint;
  redemption_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'CRM play redemptions cannot be deleted; void them instead';
  end if;

  if tg_op = 'UPDATE' then
    if new.play_member_id is distinct from old.play_member_id
      or new.order_id is distinct from old.order_id
      or new.order_item_id is distinct from old.order_item_id
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.redeemed_by_user_id is distinct from old.redeemed_by_user_id
      or new.redeemed_at is distinct from old.redeemed_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'A CRM play redemption identity is immutable';
    end if;

    if old.status <> 'redeemed' or new.status <> 'voided' then
      raise exception 'The only allowed redemption transition is redeemed -> voided';
    end if;

    return new;
  end if;

  select
    play.status,
    play.gift_product_id,
    play.gift_quantity,
    play.starts_at,
    play.ends_at,
    member_row.client_id,
    member_row.benefit_status
  into
    play_status,
    play_product_id,
    play_quantity,
    play_starts_at,
    play_ends_at,
    member_client_id,
    member_benefit_status
  from public.crm_play_members member_row
  join public.crm_plays play on play.id = member_row.play_id
  where member_row.id = new.play_member_id;

  if play_status is null then
    raise exception 'CRM play membership does not exist';
  end if;

  redemption_time := coalesce(new.redeemed_at, pg_catalog.now());

  if play_status <> 'active'
    or (play_starts_at is not null and redemption_time < play_starts_at)
    or (play_ends_at is not null and redemption_time >= play_ends_at)
  then
    raise exception 'The CRM play is not active for this redemption';
  end if;

  if member_benefit_status not in ('available', 'reserved') then
    raise exception 'The CRM play member benefit is not redeemable';
  end if;

  if new.product_id is distinct from play_product_id or new.quantity > play_quantity then
    raise exception 'The redemption does not match the CRM play benefit';
  end if;

  select order_row.client_id
    into order_client_id
  from public.orders order_row
  where order_row.id = new.order_id;

  if order_client_id is distinct from member_client_id then
    raise exception 'The order client does not match the CRM play member';
  end if;

  if new.order_item_id is not null and not exists (
    select 1
    from public.order_items order_item
    where order_item.id = new.order_item_id
      and order_item.order_id = new.order_id
      and order_item.product_id = new.product_id
  ) then
    raise exception 'The redemption order item does not match the benefit product';
  end if;

  return new;
end;
$$;

revoke all on function app_private.crm_play_redemption_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_redemption_guard_v1() to service_role;

create trigger historical_import_batches_guard
before update or delete on public.historical_import_batches
for each row execute function app_private.historical_import_batch_guard_v1();

create trigger historical_orders_guard
before insert or update or delete on public.historical_orders
for each row execute function app_private.historical_fact_guard_v1();

create trigger historical_order_items_guard
before insert or update or delete on public.historical_order_items
for each row execute function app_private.historical_fact_guard_v1();

create trigger crm_plays_guard
before update on public.crm_plays
for each row execute function app_private.crm_play_guard_v1();

create trigger crm_play_members_guard
before insert or update or delete on public.crm_play_members
for each row execute function app_private.crm_play_member_guard_v1();

create trigger crm_play_redemptions_guard
before insert or update or delete on public.crm_play_redemptions
for each row execute function app_private.crm_play_redemption_guard_v1();

create trigger crm_plays_set_updated_at
before update on public.crm_plays
for each row execute function app_private.crm_set_updated_at_v1();

create trigger crm_play_members_set_updated_at
before update on public.crm_play_members
for each row execute function app_private.crm_set_updated_at_v1();

create or replace view public.commercial_order_facts
with (security_invoker = true)
as
with live_candidates as (
  select
    order_row.id,
    order_row.order_number,
    order_row.client_id,
    case
      when nullif(order_row.extra_fields #>> '{delivery,completed_at}', '')
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        then (order_row.extra_fields #>> '{delivery,completed_at}')::timestamptz
      when order_row.extra_fields #>> '{schedule,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then ((order_row.extra_fields #>> '{schedule,date}')::date::timestamp
          + time '12:00') at time zone 'America/Caracas'
      else order_row.created_at
    end as purchased_at,
    order_row.attributed_advisor_id,
    advisor_profile.full_name as advisor_name_snapshot,
    order_row.fulfillment::text as fulfillment,
    case
      when order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}'
        ~ '^[0-9]+([.][0-9]+)?$'
        then round((order_row.extra_fields #>> '{pricing,subtotal_after_discount_usd}')::numeric, 2)
      else round(order_row.total_usd, 2)
    end as net_total_usd,
    array_remove(array[
      case when exists (
        select 1
        from public.order_items gift_item
        left join public.products gift_product on gift_product.id = gift_item.product_id
        where gift_item.order_id = order_row.id
          and (
            gift_product.type::text = 'gambit'
            or lower(gift_item.product_name_snapshot) like '%obsequio%'
            or lower(gift_item.product_name_snapshot) like '%regalo%'
            or lower(gift_item.product_name_snapshot) like '%premio%'
            or lower(gift_item.product_name_snapshot) like '%degustaci%'
            or lower(gift_item.product_name_snapshot) like '%donativo%'
            or lower(gift_item.product_name_snapshot)
              ~ '(^|[^a-z0-9])(obs|obsq)([^a-z0-9]|$)'
          )
      ) then 'obsequio'::text end,
      case when exists (
        select 1
        from public.order_items dondy_item
        where dondy_item.order_id = order_row.id
          and lower(dondy_item.product_name_snapshot) like '%dondy%'
      ) then 'dondys'::text end
    ], null)::text[] as gift_tags
  from public.orders order_row
  left join public.profiles advisor_profile
    on advisor_profile.id = order_row.attributed_advisor_id
  where order_row.status = 'delivered'
    and order_row.client_id is not null
)
select
  'historical:' || historical_order.id::text as fact_key,
  'historical'::text as fact_origin,
  historical_order.id as source_record_id,
  historical_order.source_control,
  historical_order.client_id,
  historical_order.purchased_at,
  historical_order.attributed_advisor_id,
  historical_order.advisor_name_snapshot,
  historical_order.fulfillment::text as fulfillment,
  historical_order.event_kind,
  historical_order.net_total_usd,
  historical_order.gift_tags
from public.historical_orders historical_order
join public.historical_import_batches import_batch
  on import_batch.id = historical_order.import_batch_id
 and import_batch.status = 'ready'

union all

select
  'live:' || live_order.id::text as fact_key,
  'live'::text as fact_origin,
  live_order.id as source_record_id,
  live_order.order_number as source_control,
  live_order.client_id,
  live_order.purchased_at,
  live_order.attributed_advisor_id,
  live_order.advisor_name_snapshot,
  live_order.fulfillment,
  case when live_order.net_total_usd > 0 then 'purchase'::text else 'gift_only'::text end
    as event_kind,
  live_order.net_total_usd,
  live_order.gift_tags
from live_candidates live_order
where live_order.net_total_usd > 0
  or (
    live_order.net_total_usd = 0
    and cardinality(live_order.gift_tags) > 0
  );

comment on view public.commercial_order_facts is
  'RLS-aware delivered commercial facts for CRM reporting: purchases plus zero-total gift events. Historical rows never enter operational orders.';

create or replace function public.crm_client_metrics_v1(
  p_purchase_window integer default 6,
  p_as_of timestamptz default pg_catalog.now()
)
returns table (
  client_id bigint,
  first_purchase_on date,
  last_purchase_on date,
  purchase_count bigint,
  net_revenue_usd numeric,
  average_ticket_usd numeric,
  cadence_days numeric,
  cadence_window_used integer,
  last_advisor_id uuid,
  last_advisor_name_snapshot text,
  last_gift_on date,
  days_since_last_purchase integer,
  used_pickup boolean,
  used_delivery boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as (
    select
      greatest(2, least(coalesce(p_purchase_window, 6), 50))::integer
        as purchase_window,
      coalesce(p_as_of, pg_catalog.now()) as as_of
  ),
  eligible_facts as (
    select fact.*
    from public.commercial_order_facts fact
    cross join parameters
    where fact.purchased_at <= parameters.as_of
  ),
  purchase_facts as (
    select fact.*
    from eligible_facts fact
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
  ),
  ranked_facts as (
    select
      fact.*,
      pg_catalog.row_number() over (
        partition by fact.client_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) as purchase_rank
    from purchase_facts fact
  ),
  all_metrics as (
    select
      fact.client_id,
      min((fact.purchased_at at time zone 'America/Caracas')::date) as first_purchase_on,
      max((fact.purchased_at at time zone 'America/Caracas')::date) as last_purchase_on,
      count(*) as purchase_count,
      round(sum(fact.net_total_usd), 2) as net_revenue_usd,
      round(avg(fact.net_total_usd), 2) as average_ticket_usd,
      (array_agg(fact.attributed_advisor_id order by fact.purchased_at desc, fact.fact_key desc)
        filter (where fact.attributed_advisor_id is not null))[1] as last_advisor_id,
      (array_agg(fact.advisor_name_snapshot order by fact.purchased_at desc, fact.fact_key desc)
        filter (where nullif(btrim(fact.advisor_name_snapshot), '') is not null))[1]
        as last_advisor_name_snapshot
    from purchase_facts fact
    group by fact.client_id
  ),
  gift_metrics as (
    select
      fact.client_id,
      max((fact.purchased_at at time zone 'America/Caracas')::date) as last_gift_on
    from eligible_facts fact
    where fact.event_kind = 'gift_only'
      or cardinality(fact.gift_tags) > 0
    group by fact.client_id
  ),
  channel_metrics as (
    select
      fact.client_id,
      bool_or(fact.fulfillment = 'pickup') as used_pickup,
      bool_or(fact.fulfillment = 'delivery') as used_delivery
    from eligible_facts fact
    group by fact.client_id
  ),
  recent_dates as (
    select
      fact.client_id,
      (fact.purchased_at at time zone 'America/Caracas')::date as purchase_on,
      lead((fact.purchased_at at time zone 'America/Caracas')::date) over (
        partition by fact.client_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) as prior_purchase_on
    from ranked_facts fact
    cross join parameters
    where fact.purchase_rank <= parameters.purchase_window
  ),
  cadence as (
    select
      recent.client_id,
      round(avg((recent.purchase_on - recent.prior_purchase_on)::numeric), 2) as cadence_days
    from recent_dates recent
    where recent.prior_purchase_on is not null
    group by recent.client_id
  )
  select
    metric.client_id,
    metric.first_purchase_on,
    metric.last_purchase_on,
    metric.purchase_count,
    metric.net_revenue_usd,
    metric.average_ticket_usd,
    cadence.cadence_days,
    parameters.purchase_window as cadence_window_used,
    metric.last_advisor_id,
    metric.last_advisor_name_snapshot,
    gift_metric.last_gift_on,
    ((parameters.as_of at time zone 'America/Caracas')::date - metric.last_purchase_on)::integer
      as days_since_last_purchase,
    channel_metric.used_pickup,
    channel_metric.used_delivery
  from all_metrics metric
  cross join parameters
  left join cadence on cadence.client_id = metric.client_id
  left join gift_metrics gift_metric on gift_metric.client_id = metric.client_id
  left join channel_metrics channel_metric on channel_metric.client_id = metric.client_id;
$$;

comment on function public.crm_client_metrics_v1(integer, timestamptz) is
  'Computes CRM metrics from delivered commercial facts. Purchase metrics exclude gift-only events; gift and channel history include them. The purchase window is configurable from 2 to 50 purchases.';

alter table public.historical_import_batches enable row level security;
alter table public.historical_orders enable row level security;
alter table public.historical_order_items enable row level security;
alter table public.crm_plays enable row level security;
alter table public.crm_play_members enable row level security;
alter table public.crm_play_redemptions enable row level security;

revoke all on table
  public.historical_import_batches,
  public.historical_orders,
  public.historical_order_items,
  public.crm_plays,
  public.crm_play_members,
  public.crm_play_redemptions,
  public.commercial_order_facts
from anon, authenticated;

grant select on table
  public.historical_import_batches,
  public.historical_orders,
  public.historical_order_items,
  public.crm_play_members,
  public.crm_play_redemptions,
  public.commercial_order_facts
to authenticated;

grant select, insert, update, delete on table public.crm_plays to authenticated;

grant all on table
  public.historical_import_batches,
  public.historical_orders,
  public.historical_order_items,
  public.crm_plays,
  public.crm_play_members,
  public.crm_play_redemptions
to service_role;

grant select on table public.commercial_order_facts to service_role;

grant usage, select on sequence
  public.historical_import_batches_id_seq,
  public.historical_orders_id_seq,
  public.historical_order_items_id_seq,
  public.crm_plays_id_seq,
  public.crm_play_members_id_seq,
  public.crm_play_redemptions_id_seq
to service_role;

grant usage, select on sequence public.crm_plays_id_seq to authenticated;

revoke all on function public.crm_client_metrics_v1(integer, timestamptz)
  from public, anon;
grant execute on function public.crm_client_metrics_v1(integer, timestamptz)
  to authenticated, service_role;

create policy historical_import_batches_select_staff
on public.historical_import_batches
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or status = 'ready'
);

create policy historical_orders_select_crm_staff
on public.historical_orders
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or (
    exists (
      select 1
      from public.historical_import_batches import_batch
      where import_batch.id = historical_orders.import_batch_id
        and import_batch.status = 'ready'
    )
    and (
      attributed_advisor_id = (select auth.uid())
      or exists (
        select 1
        from public.clients client_row
        where client_row.id = historical_orders.client_id
          and client_row.primary_advisor_id = (select auth.uid())
      )
    )
  )
);

create policy historical_order_items_select_crm_staff
on public.historical_order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.historical_orders historical_order
    where historical_order.id = historical_order_items.historical_order_id
  )
);

create policy crm_plays_select_staff
on public.crm_plays
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or exists (
    select 1
    from public.crm_play_members member_row
    where member_row.play_id = crm_plays.id
      and member_row.advisor_id_snapshot = (select auth.uid())
  )
);

create policy crm_plays_insert_master_admin
on public.crm_plays
for insert
to authenticated
with check (
  (select public.is_master_or_admin())
  and created_by_user_id = (select auth.uid())
  and status = 'draft'
);

create policy crm_plays_update_master_admin
on public.crm_plays
for update
to authenticated
using ((select public.is_master_or_admin()))
with check ((select public.is_master_or_admin()));

create policy crm_plays_delete_draft_master_admin
on public.crm_plays
for delete
to authenticated
using (
  (select public.is_master_or_admin())
  and status = 'draft'
);

create policy crm_play_members_select_staff
on public.crm_play_members
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or advisor_id_snapshot = (select auth.uid())
);

create policy crm_play_redemptions_select_staff
on public.crm_play_redemptions
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or exists (
    select 1
    from public.crm_play_members member_row
    where member_row.id = crm_play_redemptions.play_member_id
      and member_row.advisor_id_snapshot = (select auth.uid())
  )
);

comment on table public.historical_import_batches is
  'Auditable import manifests. Loading batches remain invisible to commercial facts until reconciled and marked ready.';

comment on table public.historical_orders is
  'Read-only delivered purchase and gift-event facts before the Vivo Ops live cutoff. They carry no debt or payment state and never become operational orders.';

comment on table public.historical_order_items is
  'Historical product snapshots used for commercial intelligence; product_id is optional and only set on exact matches.';

comment on table public.crm_plays is
  'Versioned CRM play definitions. Rules and member selection are frozen at snapshot_at.';

comment on table public.crm_play_members is
  'One row per selected client with advisor assignment and decision metrics frozen at play activation.';

comment on table public.crm_play_redemptions is
  'Auditable use of the product benefit granted by a CRM play membership.';
