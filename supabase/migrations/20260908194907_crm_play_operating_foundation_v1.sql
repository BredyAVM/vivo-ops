-- Operating foundation for reusable CRM plays.
--
-- This migration keeps the existing play/member/redemption model intact while
-- adding the pieces needed before the advisor workflow can be simplified:
-- reusable copies, advisor guidance, a copy-ready message, explicit overlap
-- rules, and a pricing snapshot taken when the list is confirmed.

alter table public.crm_plays
  add column copied_from_play_id bigint
    references public.crm_plays(id) on delete set null,
  add column advisor_guidance text,
  add column message_template text,
  add column overlap_policy text not null default 'exclusive',
  add column benefit_stack_policy text not null default 'one_per_order',
  add column evaluation_window_days smallint not null default 90,
  add column pricing_exchange_rate_ves_per_usd numeric(18,6),
  add column pricing_snapshot_at timestamptz,
  add constraint crm_plays_advisor_guidance_length_check
    check (advisor_guidance is null or char_length(advisor_guidance) <= 4000),
  add constraint crm_plays_message_template_length_check
    check (message_template is null or char_length(message_template) <= 6000),
  add constraint crm_plays_overlap_policy_check
    check (overlap_policy in ('exclusive', 'selected_compatible')),
  add constraint crm_plays_benefit_stack_policy_check
    check (benefit_stack_policy in ('one_per_order', 'allow_multiple')),
  add constraint crm_plays_evaluation_window_days_check
    check (evaluation_window_days between 7 and 365);

-- Existing confirmed plays predate this snapshot. Seed them from the current
-- active rate so the new invariant is valid without rewriting old economics.
update public.crm_plays play
set
  pricing_exchange_rate_ves_per_usd = public.get_active_exchange_rate(),
  pricing_snapshot_at = coalesce(play.snapshot_at, play.activated_at, play.created_at)
where play.status not in ('draft', 'cancelled');

alter table public.crm_plays
  add constraint crm_plays_pricing_snapshot_check
    check (
      (
        status = 'draft'
        and pricing_exchange_rate_ves_per_usd is null
        and pricing_snapshot_at is null
      )
      or status = 'cancelled'
      or (
        status not in ('draft', 'cancelled')
        and pricing_exchange_rate_ves_per_usd is not null
        and pricing_exchange_rate_ves_per_usd > 0
        and pricing_snapshot_at is not null
      )
    );

create index crm_plays_copied_from_play_id_idx
  on public.crm_plays(copied_from_play_id)
  where copied_from_play_id is not null;

alter table public.crm_play_benefits
  add column product_name_snapshot text,
  add column source_price_currency_snapshot public.currency_code,
  add column source_price_amount_snapshot numeric(18,6),
  add column catalog_price_usd_snapshot numeric(18,6),
  add constraint crm_play_benefits_source_price_amount_check
    check (source_price_amount_snapshot is null or source_price_amount_snapshot >= 0),
  add constraint crm_play_benefits_catalog_price_usd_check
    check (catalog_price_usd_snapshot is null or catalog_price_usd_snapshot >= 0);

create table public.crm_play_compatibilities (
  play_id_low bigint not null references public.crm_plays(id) on delete cascade,
  play_id_high bigint not null references public.crm_plays(id) on delete cascade,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (play_id_low, play_id_high),
  constraint crm_play_compatibilities_order_check check (play_id_low < play_id_high)
);

alter table public.crm_play_compatibilities enable row level security;

revoke all on table public.crm_play_compatibilities from public, anon, authenticated;
grant select, insert, delete on table public.crm_play_compatibilities to authenticated;
grant all on table public.crm_play_compatibilities to service_role;

create policy crm_play_compatibilities_select_master_admin
on public.crm_play_compatibilities
for select
to authenticated
using ((select public.is_master_or_admin()));

create policy crm_play_compatibilities_insert_master_admin
on public.crm_play_compatibilities
for insert
to authenticated
with check ((select public.is_master_or_admin()));

create policy crm_play_compatibilities_delete_master_admin
on public.crm_play_compatibilities
for delete
to authenticated
using ((select public.is_master_or_admin()));

create or replace function app_private.crm_play_compatibility_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  low_status text;
  high_status text;
begin
  select play.status into low_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id_low else new.play_id_low end;

  select play.status into high_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id_high else new.play_id_high end;

  if low_status is null or high_status is null then
    raise exception 'Both CRM plays must exist';
  end if;

  if low_status <> 'draft' and high_status <> 'draft' then
    raise exception 'Compatibility can only change while one of the plays is in design';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_compatibility_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_compatibility_guard_v1()
  to service_role;

create trigger crm_play_compatibilities_guard
before insert or delete on public.crm_play_compatibilities
for each row execute function app_private.crm_play_compatibility_guard_v1();

create index crm_play_members_client_overlap_idx
  on public.crm_play_members(client_id, play_id)
  where workflow_status <> 'removed';

create or replace function app_private.crm_play_has_overlap_conflict_v1(
  p_play_id bigint,
  p_client_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_plays current_play
    join public.crm_play_members other_member
      on other_member.client_id = p_client_id
     and other_member.play_id <> current_play.id
     and other_member.workflow_status <> 'removed'
    join public.crm_plays other_play on other_play.id = other_member.play_id
    where current_play.id = p_play_id
      and other_play.status in ('frozen', 'active', 'paused')
      and coalesce(current_play.starts_at, '-infinity'::timestamptz)
          < coalesce(other_play.ends_at, 'infinity'::timestamptz)
      and coalesce(other_play.starts_at, '-infinity'::timestamptz)
          < coalesce(current_play.ends_at, 'infinity'::timestamptz)
      and (
        current_play.overlap_policy = 'exclusive'
        or other_play.overlap_policy = 'exclusive'
        or not exists (
          select 1
          from public.crm_play_compatibilities compatibility
          where compatibility.play_id_low = least(current_play.id, other_play.id)
            and compatibility.play_id_high = greatest(current_play.id, other_play.id)
        )
      )
  );
$$;

revoke all on function app_private.crm_play_has_overlap_conflict_v1(bigint, bigint)
  from public, anon, authenticated;
grant execute on function app_private.crm_play_has_overlap_conflict_v1(bigint, bigint)
  to service_role;

create or replace function public.crm_prepare_play_preview_v2(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  conflict_count integer := 0;
  preview_summary jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to prepare a CRM play preview'
      using errcode = '42501';
  end if;

  perform public.crm_rebuild_play_members_v1(p_play_id);

  with removed_conflicts as (
    delete from public.crm_play_members member_row
    where member_row.play_id = p_play_id
      and app_private.crm_play_has_overlap_conflict_v1(p_play_id, member_row.client_id)
    returning member_row.id
  )
  select count(*)::integer into conflict_count
  from removed_conflicts;

  preview_summary := public.crm_refresh_play_preview_summary_v1(p_play_id)
    || pg_catalog.jsonb_build_object('overlap_conflict_count', conflict_count);

  update public.crm_plays play
  set selection_summary = preview_summary
  where play.id = p_play_id;

  return preview_summary;
end;
$$;

revoke all on function public.crm_prepare_play_preview_v2(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_prepare_play_preview_v2(bigint)
  to authenticated, service_role;

create or replace function public.crm_confirm_play_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  member_count integer;
  benefit_count integer;
  conflict_count integer;
  active_rate numeric;
  confirmed_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to confirm a CRM play'
      using errcode = '42501';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status <> 'draft' then
    raise exception 'Only a play in design can be confirmed' using errcode = '55000';
  end if;

  select count(*)::integer into member_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  select count(*)::integer into benefit_count
  from public.crm_play_benefits benefit
  where benefit.play_id = p_play_id;

  if member_count = 0 then
    raise exception 'Generate and review a client list before confirming the play';
  end if;
  if benefit_count = 0 then
    raise exception 'At least one benefit is required before confirming the play';
  end if;

  select count(*)::integer into conflict_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and app_private.crm_play_has_overlap_conflict_v1(p_play_id, member_row.client_id);

  if conflict_count > 0 then
    raise exception '% clients now conflict with another confirmed play. Run the preview again.', conflict_count
      using errcode = '40001';
  end if;

  active_rate := public.get_active_exchange_rate();
  if active_rate is null or active_rate <= 0 then
    raise exception 'An active exchange rate is required to freeze this play';
  end if;

  update public.crm_play_benefits benefit
  set
    product_name_snapshot = product.name,
    source_price_currency_snapshot = product.source_price_currency,
    source_price_amount_snapshot = product.source_price_amount,
    catalog_price_usd_snapshot = product.base_price_usd
  from public.products product
  where benefit.play_id = p_play_id
    and product.id = benefit.product_id;

  update public.crm_plays play
  set
    status = 'frozen',
    snapshot_at = confirmed_at,
    pricing_exchange_rate_ves_per_usd = active_rate,
    pricing_snapshot_at = confirmed_at
  where play.id = p_play_id;

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'member_count', member_count,
    'benefit_count', benefit_count,
    'snapshot_at', confirmed_at,
    'exchange_rate_ves_per_usd', active_rate
  );
end;
$$;

revoke all on function public.crm_confirm_play_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_confirm_play_v1(bigint)
  to authenticated, service_role;

create or replace function public.crm_clone_play_v1(
  p_source_play_id bigint,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  source_play public.crm_plays%rowtype;
  next_version integer;
  cloned_play_id bigint;
  cloned_name text;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to copy a CRM play'
      using errcode = '42501';
  end if;

  select play.* into source_play
  from public.crm_plays play
  where play.id = p_source_play_id;

  if source_play.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(source_play.series_key, 0));

  select coalesce(max(play.version), 0) + 1 into next_version
  from public.crm_plays play
  where play.series_key = source_play.series_key;

  cloned_name := nullif(btrim(coalesce(p_name, '')), '');
  if cloned_name is null then
    cloned_name := left(source_play.name || ' · copia', 120);
  end if;

  insert into public.crm_plays (
    series_key,
    version,
    supersedes_play_id,
    copied_from_play_id,
    name,
    description,
    status,
    rules_snapshot,
    selection_summary,
    metric_window,
    gift_product_id,
    gift_quantity,
    planned_budget_usd,
    benefit_selection_mode,
    purchase_requirement_mode,
    minimum_order_amount_usd,
    advisor_guidance,
    message_template,
    overlap_policy,
    benefit_stack_policy,
    evaluation_window_days,
    starts_at,
    ends_at,
    created_by_user_id
  ) values (
    source_play.series_key,
    next_version,
    null,
    source_play.id,
    cloned_name,
    source_play.description,
    'draft',
    source_play.rules_snapshot - 'excluded_client_ids',
    '{}'::jsonb,
    source_play.metric_window,
    source_play.gift_product_id,
    source_play.gift_quantity,
    source_play.planned_budget_usd,
    source_play.benefit_selection_mode,
    source_play.purchase_requirement_mode,
    source_play.minimum_order_amount_usd,
    source_play.advisor_guidance,
    source_play.message_template,
    source_play.overlap_policy,
    source_play.benefit_stack_policy,
    source_play.evaluation_window_days,
    source_play.starts_at,
    source_play.ends_at,
    coalesce(caller_id, source_play.created_by_user_id)
  )
  returning id into cloned_play_id;

  insert into public.crm_play_benefits (
    play_id,
    product_id,
    quantity,
    unit_budget_cost_usd,
    unit_benefit_value_usd,
    unit_advisor_cost_usd,
    unit_company_cost_usd,
    sort_order
  )
  select
    cloned_play_id,
    benefit.product_id,
    benefit.quantity,
    benefit.unit_budget_cost_usd,
    benefit.unit_benefit_value_usd,
    benefit.unit_advisor_cost_usd,
    benefit.unit_company_cost_usd,
    benefit.sort_order
  from public.crm_play_benefits benefit
  where benefit.play_id = source_play.id
  order by benefit.sort_order, benefit.id;

  insert into public.crm_play_compatibilities (
    play_id_low,
    play_id_high,
    created_by_user_id
  )
  select
    least(cloned_play_id, compatible_play.other_play_id),
    greatest(cloned_play_id, compatible_play.other_play_id),
    coalesce(caller_id, source_play.created_by_user_id)
  from (
    select case
      when compatibility.play_id_low = source_play.id then compatibility.play_id_high
      else compatibility.play_id_low
    end as other_play_id
    from public.crm_play_compatibilities compatibility
    where compatibility.play_id_low = source_play.id
       or compatibility.play_id_high = source_play.id
  ) compatible_play
  where compatible_play.other_play_id <> cloned_play_id
  on conflict do nothing;

  return pg_catalog.jsonb_build_object(
    'play_id', cloned_play_id,
    'source_play_id', source_play.id,
    'version', next_version
  );
end;
$$;

revoke all on function public.crm_clone_play_v1(bigint, text)
  from public, anon, authenticated;
grant execute on function public.crm_clone_play_v1(bigint, text)
  to authenticated, service_role;

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
    or new.copied_from_play_id is distinct from old.copied_from_play_id
    or new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.rules_snapshot is distinct from old.rules_snapshot
    or new.selection_summary is distinct from old.selection_summary
    or new.metric_window is distinct from old.metric_window
    or new.gift_product_id is distinct from old.gift_product_id
    or new.gift_quantity is distinct from old.gift_quantity
    or new.planned_budget_usd is distinct from old.planned_budget_usd
    or new.benefit_selection_mode is distinct from old.benefit_selection_mode
    or new.purchase_requirement_mode is distinct from old.purchase_requirement_mode
    or new.minimum_order_amount_usd is distinct from old.minimum_order_amount_usd
    or new.advisor_guidance is distinct from old.advisor_guidance
    or new.message_template is distinct from old.message_template
    or new.overlap_policy is distinct from old.overlap_policy
    or new.benefit_stack_policy is distinct from old.benefit_stack_policy
    or new.evaluation_window_days is distinct from old.evaluation_window_days
    or new.pricing_exchange_rate_ves_per_usd is distinct from old.pricing_exchange_rate_ves_per_usd
    or new.pricing_snapshot_at is distinct from old.pricing_snapshot_at
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

comment on column public.crm_plays.message_template is
  'Copy-ready advisor message. Supported variables are rendered by the application, not stored as client data.';

comment on column public.crm_plays.overlap_policy is
  'Exclusive by default. selected_compatible still requires an explicit pair in crm_play_compatibilities.';

comment on table public.crm_play_compatibilities is
  'Explicit play pairs that may share a client during overlapping confirmed or active periods.';

comment on function public.crm_prepare_play_preview_v2(bigint) is
  'Rebuilds a draft client list and removes overlaps with incompatible confirmed or active plays.';

comment on function public.crm_confirm_play_v1(bigint) is
  'Atomically rechecks conflicts and freezes the client list plus product pricing context.';

comment on function public.crm_clone_play_v1(bigint, text) is
  'Copies a play definition, benefits, message, and compatible-play rules into a new editable version.';
