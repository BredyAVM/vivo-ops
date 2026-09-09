-- Controlled amendments for confirmed or published CRM plays.
-- The original cut remains auditable while a master/admin may adjust copy,
-- add an intentional exception, or withdraw an unused assignment.

create table public.crm_play_amendments (
  id bigint generated always as identity primary key,
  play_id bigint not null references public.crm_plays(id) on delete restrict,
  amendment_type text not null,
  client_id bigint references public.clients(id) on delete restrict,
  advisor_id_snapshot uuid references public.profiles(id) on delete set null,
  previous_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  reason text not null,
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint crm_play_amendments_type_check check (
    amendment_type in ('message_updated', 'member_added', 'member_removed', 'advisor_excluded')
  ),
  constraint crm_play_amendments_previous_values_check
    check (pg_catalog.jsonb_typeof(previous_values) = 'object'),
  constraint crm_play_amendments_new_values_check
    check (pg_catalog.jsonb_typeof(new_values) = 'object'),
  constraint crm_play_amendments_reason_check
    check (length(btrim(reason)) between 3 and 500)
);

create index crm_play_amendments_play_created_idx
  on public.crm_play_amendments(play_id, created_at desc, id desc);

create index crm_play_amendments_client_play_idx
  on public.crm_play_amendments(client_id, play_id)
  where client_id is not null;

create or replace function app_private.crm_play_amendment_immutable_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'CRM play amendments are immutable';
end;
$$;

revoke all on function app_private.crm_play_amendment_immutable_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_amendment_immutable_v1()
  to service_role;

create trigger crm_play_amendments_immutable
before update or delete on public.crm_play_amendments
for each row execute function app_private.crm_play_amendment_immutable_v1();

alter table public.crm_play_amendments enable row level security;

revoke all on table public.crm_play_amendments from public, anon, authenticated;
grant select on table public.crm_play_amendments to authenticated;
grant all on table public.crm_play_amendments to service_role;
grant usage, select on sequence public.crm_play_amendments_id_seq to service_role;

create policy crm_play_amendments_select_master_admin
on public.crm_play_amendments
for select
to authenticated
using (public.is_master_or_admin());

-- Only tightly scoped SECURITY DEFINER procedures may change the mutable layer
-- around a frozen definition. Clients cannot set this transaction-local context.
create or replace function app_private.crm_play_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  amendment_context text := coalesce(
    pg_catalog.current_setting('app.crm_play_amendment_context', true),
    ''
  );
begin
  if old.status <> 'draft' and (
    new.series_key is distinct from old.series_key
    or new.version is distinct from old.version
    or new.supersedes_play_id is distinct from old.supersedes_play_id
    or new.copied_from_play_id is distinct from old.copied_from_play_id
    or new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.rules_snapshot is distinct from old.rules_snapshot
    or new.metric_window is distinct from old.metric_window
    or new.gift_product_id is distinct from old.gift_product_id
    or new.gift_quantity is distinct from old.gift_quantity
    or new.planned_budget_usd is distinct from old.planned_budget_usd
    or new.benefit_selection_mode is distinct from old.benefit_selection_mode
    or new.purchase_requirement_mode is distinct from old.purchase_requirement_mode
    or new.minimum_order_amount_usd is distinct from old.minimum_order_amount_usd
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

  if old.status <> 'draft'
    and new.selection_summary is distinct from old.selection_summary
    and amendment_context <> 'published_summary'
  then
    raise exception 'A published CRM play summary can only change through an audited amendment';
  end if;

  if old.status <> 'draft'
    and (
      new.advisor_guidance is distinct from old.advisor_guidance
      or new.message_template is distinct from old.message_template
    )
    and amendment_context <> 'message'
  then
    raise exception 'Published CRM play copy can only change through an audited amendment';
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

create or replace function app_private.crm_play_member_guard_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  play_status text;
  amendment_context text := coalesce(
    pg_catalog.current_setting('app.crm_play_amendment_context', true),
    ''
  );
begin
  select play.status
    into play_status
  from public.crm_plays play
  where play.id = case when tg_op = 'DELETE' then old.play_id else new.play_id end;

  if play_status is null then
    raise exception 'CRM play does not exist';
  end if;

  if tg_op = 'INSERT'
    and play_status <> 'draft'
    and not (
      play_status in ('frozen', 'active', 'paused')
      and amendment_context = 'member_add'
    )
  then
    raise exception 'CRM play members can only be added through an audited published amendment';
  end if;

  if tg_op = 'DELETE' and play_status <> 'draft' then
    raise exception 'A frozen CRM play member cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if play_status in ('closed', 'cancelled') then
      raise exception 'CRM play members cannot change while the play is %', play_status;
    end if;

    if old.workflow_status = 'removed'
      and amendment_context <> 'member_restore'
      and new is distinct from old
    then
      raise exception 'A removed CRM play member can only return through an audited amendment';
    end if;

    if play_status = 'frozen'
      and amendment_context not in ('member_remove', 'member_restore')
    then
      raise exception 'CRM play members cannot change while the play is frozen';
    end if;

    if play_status <> 'draft'
      and amendment_context <> 'member_restore'
      and (
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
      )
    then
      raise exception 'Frozen CRM play member decision data is immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app_private.crm_play_member_guard_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_member_guard_v1() to service_role;

create or replace function app_private.crm_refresh_published_play_summary_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  play_row public.crm_plays%rowtype;
  company_min numeric := 0;
  company_max numeric := 0;
  advisor_min numeric := 0;
  advisor_max numeric := 0;
  value_min numeric := 0;
  value_max numeric := 0;
  active_member_count integer := 0;
  refreshed_summary jsonb;
begin
  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current CRM play can refresh its amendment summary'
      using errcode = '55000';
  end if;

  if play_row.benefit_selection_mode = 'multiple' then
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.sum(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits benefit
    where benefit.play_id = p_play_id;
  else
    select
      coalesce(pg_catalog.min(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_company_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_advisor_cost_usd), 0),
      coalesce(pg_catalog.min(quantity * unit_benefit_value_usd), 0),
      coalesce(pg_catalog.max(quantity * unit_benefit_value_usd), 0)
    into company_min, company_max, advisor_min, advisor_max, value_min, value_max
    from public.crm_play_benefits benefit
    where benefit.play_id = p_play_id;
  end if;

  select pg_catalog.count(*)::integer into active_member_count
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and member_row.workflow_status <> 'removed';

  select coalesce(play_row.selection_summary, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'total', active_member_count,
    'advisor_count', pg_catalog.count(distinct member_row.advisor_id_snapshot)::integer,
    'gifted_client_count', pg_catalog.count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (
      select pg_catalog.count(*)::integer
      from public.crm_play_benefits benefit
      where benefit.play_id = p_play_id
    ),
    'benefit_selection_mode', play_row.benefit_selection_mode,
    'total_purchase_count', coalesce(pg_catalog.sum(member_row.purchase_count), 0)::bigint,
    'total_net_revenue_usd', pg_catalog.round(coalesce(pg_catalog.sum(member_row.net_revenue_usd), 0), 2),
    'company_cost_per_client_min_usd', pg_catalog.round(company_min, 2),
    'company_cost_per_client_max_usd', pg_catalog.round(company_max, 2),
    'projected_cost_min_usd', pg_catalog.round(active_member_count * company_min, 2),
    'projected_cost_max_usd', pg_catalog.round(active_member_count * company_max, 2),
    'advisor_charge_per_client_min_usd', pg_catalog.round(advisor_min, 2),
    'advisor_charge_per_client_max_usd', pg_catalog.round(advisor_max, 2),
    'projected_advisor_charge_min_usd', pg_catalog.round(active_member_count * advisor_min, 2),
    'projected_advisor_charge_max_usd', pg_catalog.round(active_member_count * advisor_max, 2),
    'benefit_value_per_client_min_usd', pg_catalog.round(value_min, 2),
    'benefit_value_per_client_max_usd', pg_catalog.round(value_max, 2),
    'budget_usd', play_row.planned_budget_usd,
    'budget_balance_worst_case_usd', case
      when play_row.planned_budget_usd is null then null
      else pg_catalog.round(play_row.planned_budget_usd - (active_member_count * company_max), 2)
    end,
    'budget_capacity_worst_case', case
      when play_row.planned_budget_usd is null or company_max <= 0 then null
      else pg_catalog.floor(play_row.planned_budget_usd / company_max)::bigint
    end,
    'budget_status', case
      when play_row.planned_budget_usd is null then 'not_defined'
      when play_row.planned_budget_usd >= active_member_count * company_max then 'within'
      else 'exceeds'
    end,
    'manual_addition_count', pg_catalog.count(*) filter (
      where member_row.decision_snapshot ->> 'manual_inclusion' = 'true'
    ),
    'published_removal_count', (
      select pg_catalog.count(*)::integer
      from public.crm_play_members removed_member
      where removed_member.play_id = p_play_id
        and removed_member.workflow_status = 'removed'
    ),
    'last_amended_at', (
      select pg_catalog.max(amendment.created_at)
      from public.crm_play_amendments amendment
      where amendment.play_id = p_play_id
    ),
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        ) order by advisor_totals.member_count desc, advisor_totals.advisor_name
      )
      from (
        select
          grouped.advisor_id_snapshot as advisor_id,
          coalesce(advisor.full_name, 'Asesor sin nombre') as advisor_name,
          pg_catalog.count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
          and grouped.workflow_status <> 'removed'
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into refreshed_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and member_row.workflow_status <> 'removed';

  perform pg_catalog.set_config('app.crm_play_amendment_context', 'published_summary', true);

  update public.crm_plays play
  set selection_summary = refreshed_summary
  where play.id = p_play_id;

  return refreshed_summary;
end;
$$;

revoke all on function app_private.crm_refresh_published_play_summary_v1(bigint)
  from public, anon, authenticated;
grant execute on function app_private.crm_refresh_published_play_summary_v1(bigint)
  to service_role;

create or replace function public.crm_amend_play_message_v1(
  p_play_id bigint,
  p_message_template text,
  p_advisor_guidance text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  actor_id uuid;
  clean_message text := nullif(btrim(coalesce(p_message_template, '')), '');
  clean_guidance text := nullif(btrim(coalesce(p_advisor_guidance, '')), '');
  clean_reason text := btrim(coalesce(p_reason, ''));
  changed_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to amend a CRM play'
      using errcode = '42501';
  end if;
  if length(clean_reason) not between 3 and 500 then
    raise exception 'Explain the reason in 3 to 500 characters' using errcode = '22023';
  end if;
  if length(coalesce(clean_message, '')) > 6000
    or length(coalesce(clean_guidance, '')) > 4000 then
    raise exception 'The message or advisor guidance is too long' using errcode = '22023';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current play can be amended' using errcode = '55000';
  end if;
  if play_row.ends_at is not null and play_row.ends_at <= changed_at then
    raise exception 'An expired play cannot be amended' using errcode = '55000';
  end if;
  if clean_message is not distinct from play_row.message_template
    and clean_guidance is not distinct from play_row.advisor_guidance then
    raise exception 'The message and guidance have no changes' using errcode = '22023';
  end if;

  actor_id := coalesce(caller_id, play_row.created_by_user_id);
  perform pg_catalog.set_config('app.crm_play_amendment_context', 'message', true);

  update public.crm_plays play
  set
    message_template = clean_message,
    advisor_guidance = clean_guidance
  where play.id = p_play_id;

  insert into public.crm_play_amendments (
    play_id, amendment_type, previous_values, new_values, reason,
    created_by_user_id, created_at
  ) values (
    p_play_id,
    'message_updated',
    pg_catalog.jsonb_build_object(
      'message_template', play_row.message_template,
      'advisor_guidance', play_row.advisor_guidance
    ),
    pg_catalog.jsonb_build_object(
      'message_template', clean_message,
      'advisor_guidance', clean_guidance
    ),
    clean_reason,
    actor_id,
    changed_at
  );

  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);

  return pg_catalog.jsonb_build_object('play_id', p_play_id, 'changed_at', changed_at);
end;
$$;

create or replace function public.crm_add_manual_play_member_v1(
  p_play_id bigint,
  p_client_id bigint,
  p_advisor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  client_row public.clients%rowtype;
  existing_member public.crm_play_members%rowtype;
  metric_row record;
  actor_id uuid;
  advisor_id uuid;
  clean_reason text := btrim(coalesce(p_reason, ''));
  amended_at timestamptz := pg_catalog.now();
  member_id bigint;
  restored boolean := false;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to amend a CRM play'
      using errcode = '42501';
  end if;
  if length(clean_reason) not between 3 and 500 then
    raise exception 'Explain the reason in 3 to 500 characters' using errcode = '22023';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current play can accept manual clients' using errcode = '55000';
  end if;
  if play_row.ends_at is not null and play_row.ends_at <= amended_at then
    raise exception 'An expired play cannot accept manual clients' using errcode = '55000';
  end if;

  select client.* into client_row
  from public.clients client
  where client.id = p_client_id
    and client.is_active
  for update;

  if client_row.id is null then
    raise exception 'The client does not exist or is inactive' using errcode = 'P0002';
  end if;

  advisor_id := coalesce(p_advisor_id, client_row.primary_advisor_id);
  if advisor_id is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = advisor_id
      and profile.is_active
      and exists (
        select 1
        from public.user_roles role_row
        where role_row.user_id = profile.id
          and role_row.role = 'advisor'
      )
  ) then
    raise exception 'Select an active advisor for this manual inclusion' using errcode = '22023';
  end if;

  select member_row.* into existing_member
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and member_row.client_id = p_client_id
  for update;

  if existing_member.id is not null and existing_member.workflow_status <> 'removed' then
    raise exception 'The client already belongs to this play' using errcode = '23505';
  end if;
  if existing_member.id is not null and (
    existing_member.benefit_status = 'redeemed'
    or exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = existing_member.id
        and redemption.status = 'redeemed'
    )
  ) then
    raise exception 'A client with an applied benefit cannot be re-added' using errcode = '55000';
  end if;
  if app_private.crm_play_has_overlap_conflict_v1(p_play_id, p_client_id) then
    raise exception 'The client already belongs to an incompatible play in the same period'
      using errcode = '23505';
  end if;

  select metric.* into metric_row
  from public.crm_client_metrics_v1(play_row.metric_window, amended_at) metric
  where metric.client_id = p_client_id;

  actor_id := coalesce(caller_id, play_row.created_by_user_id);

  if existing_member.id is null then
    perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_add', true);
    insert into public.crm_play_members (
      play_id, client_id, advisor_id_snapshot, eligible_at, workflow_status,
      benefit_status, first_purchase_on, last_purchase_on, purchase_count,
      net_revenue_usd, average_ticket_usd, cadence_days, cadence_window,
      last_advisor_id, last_advisor_name_snapshot, last_gift_on,
      days_since_last_purchase, used_pickup, used_delivery, decision_snapshot,
      eligibility_reasons
    ) values (
      p_play_id,
      p_client_id,
      advisor_id,
      amended_at,
      'pending',
      'available',
      metric_row.first_purchase_on,
      metric_row.last_purchase_on,
      coalesce(metric_row.purchase_count, 0)::integer,
      coalesce(metric_row.net_revenue_usd, 0),
      metric_row.average_ticket_usd,
      metric_row.cadence_days,
      play_row.metric_window,
      metric_row.last_advisor_id,
      metric_row.last_advisor_name_snapshot,
      metric_row.last_gift_on,
      metric_row.days_since_last_purchase,
      coalesce(metric_row.used_pickup, false),
      coalesce(metric_row.used_delivery, false),
      pg_catalog.jsonb_build_object(
        'rules', coalesce(play_row.rules_snapshot, '{}'::jsonb) - 'excluded_client_ids',
        'generated_at', amended_at,
        'primary_advisor_id', client_row.primary_advisor_id,
        'manual_inclusion', true,
        'included_after_publication', true,
        'original_rules_bypassed', true
      ),
      array['Inclusión manual autorizada por administrador']::text[]
    )
    returning id into member_id;
  else
    restored := true;
    member_id := existing_member.id;
    delete from public.crm_play_member_benefit_selections selection
    where selection.play_member_id = existing_member.id;

    perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_restore', true);
    update public.crm_play_members member_row
    set
      advisor_id_snapshot = advisor_id,
      eligible_at = amended_at,
      workflow_status = 'pending',
      benefit_status = 'available',
      first_purchase_on = metric_row.first_purchase_on,
      last_purchase_on = metric_row.last_purchase_on,
      purchase_count = coalesce(metric_row.purchase_count, 0)::integer,
      net_revenue_usd = coalesce(metric_row.net_revenue_usd, 0),
      average_ticket_usd = metric_row.average_ticket_usd,
      cadence_days = metric_row.cadence_days,
      cadence_window = play_row.metric_window,
      last_advisor_id = metric_row.last_advisor_id,
      last_advisor_name_snapshot = metric_row.last_advisor_name_snapshot,
      last_gift_on = metric_row.last_gift_on,
      days_since_last_purchase = metric_row.days_since_last_purchase,
      used_pickup = coalesce(metric_row.used_pickup, false),
      used_delivery = coalesce(metric_row.used_delivery, false),
      decision_snapshot = pg_catalog.jsonb_build_object(
        'rules', coalesce(play_row.rules_snapshot, '{}'::jsonb) - 'excluded_client_ids',
        'generated_at', amended_at,
        'primary_advisor_id', client_row.primary_advisor_id,
        'manual_inclusion', true,
        'included_after_publication', true,
        'original_rules_bypassed', true,
        'restored_after_removal', true
      ),
      eligibility_reasons = array['Inclusión manual autorizada por administrador']::text[],
      contacted_at = null,
      benefit_reserved_at = null,
      benefit_redeemed_at = null,
      benefit_expired_at = null,
      last_contact_at = null,
      next_follow_up_at = null,
      responded_at = null,
      accepted_at = null,
      converted_at = null,
      workflow_closed_at = null,
      contact_attempt_count = 0,
      last_contact_channel = null,
      last_note = null,
      last_event_at = null,
      selected_play_benefit_id = null,
      selected_benefit_at = null,
      selected_benefit_by_user_id = null
    where member_row.id = existing_member.id;
  end if;

  insert into public.crm_play_amendments (
    play_id, amendment_type, client_id, advisor_id_snapshot,
    previous_values, new_values, reason, created_by_user_id, created_at
  ) values (
    p_play_id,
    'member_added',
    p_client_id,
    advisor_id,
    case when restored then pg_catalog.jsonb_build_object(
      'workflow_status', existing_member.workflow_status,
      'benefit_status', existing_member.benefit_status,
      'advisor_id_snapshot', existing_member.advisor_id_snapshot
    ) else '{}'::jsonb end,
    pg_catalog.jsonb_build_object(
      'workflow_status', 'pending',
      'benefit_status', 'available',
      'advisor_id_snapshot', advisor_id,
      'manual_inclusion', true,
      'restored', restored
    ),
    clean_reason,
    actor_id,
    amended_at
  );

  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'play_member_id', member_id,
    'client_id', p_client_id,
    'advisor_id', advisor_id,
    'restored', restored,
    'changed_at', amended_at
  );
end;
$$;

create or replace function public.crm_remove_published_play_member_v1(
  p_play_id bigint,
  p_client_id bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  member_row public.crm_play_members%rowtype;
  actor_id uuid;
  clean_reason text := btrim(coalesce(p_reason, ''));
  amended_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to amend a CRM play'
      using errcode = '42501';
  end if;
  if length(clean_reason) not between 3 and 500 then
    raise exception 'Explain the reason in 3 to 500 characters' using errcode = '22023';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current play can remove clients' using errcode = '55000';
  end if;
  if play_row.ends_at is not null and play_row.ends_at <= amended_at then
    raise exception 'An expired play cannot remove clients' using errcode = '55000';
  end if;

  select member.* into member_row
  from public.crm_play_members member
  where member.play_id = p_play_id
    and member.client_id = p_client_id
  for update;

  if member_row.id is null then
    raise exception 'The client does not belong to this play' using errcode = 'P0002';
  end if;
  if member_row.workflow_status = 'removed' then
    raise exception 'The client was already removed from this play' using errcode = '55000';
  end if;
  if member_row.benefit_status = 'redeemed'
    or exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = member_row.id
        and redemption.status = 'redeemed'
    )
  then
    raise exception 'A client with an applied benefit cannot be removed' using errcode = '55000';
  end if;

  actor_id := coalesce(caller_id, play_row.created_by_user_id);
  delete from public.crm_play_member_benefit_selections selection
  where selection.play_member_id = member_row.id;

  perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_remove', true);

  update public.crm_play_members member
  set
    workflow_status = 'removed',
    benefit_status = 'cancelled',
    benefit_reserved_at = null,
    next_follow_up_at = null,
    workflow_closed_at = amended_at,
    last_note = clean_reason,
    last_event_at = amended_at,
    selected_play_benefit_id = null,
    selected_benefit_at = null,
    selected_benefit_by_user_id = null
  where member.id = member_row.id;

  insert into public.crm_play_amendments (
    play_id, amendment_type, client_id, advisor_id_snapshot,
    previous_values, new_values, reason, created_by_user_id, created_at
  ) values (
    p_play_id,
    'member_removed',
    p_client_id,
    member_row.advisor_id_snapshot,
    pg_catalog.jsonb_build_object(
      'workflow_status', member_row.workflow_status,
      'benefit_status', member_row.benefit_status,
      'selected_play_benefit_id', member_row.selected_play_benefit_id
    ),
    pg_catalog.jsonb_build_object(
      'workflow_status', 'removed',
      'benefit_status', 'cancelled'
    ),
    clean_reason,
    actor_id,
    amended_at
  );

  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'play_member_id', member_row.id,
    'client_id', p_client_id,
    'changed_at', amended_at
  );
end;
$$;

create or replace function public.crm_exclude_play_advisor_v1(
  p_play_id bigint,
  p_advisor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  play_row public.crm_plays%rowtype;
  actor_id uuid;
  clean_reason text := btrim(coalesce(p_reason, ''));
  amended_at timestamptz := pg_catalog.now();
  removed_count integer := 0;
  redeemed_count integer := 0;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to amend a CRM play'
      using errcode = '42501';
  end if;
  if p_advisor_id is null then
    raise exception 'Select an advisor' using errcode = '22023';
  end if;
  if length(clean_reason) not between 3 and 500 then
    raise exception 'Explain the reason in 3 to 500 characters' using errcode = '22023';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;
  if play_row.status not in ('frozen', 'active', 'paused') then
    raise exception 'Only a confirmed current play can exclude an advisor' using errcode = '55000';
  end if;
  if play_row.ends_at is not null and play_row.ends_at <= amended_at then
    raise exception 'An expired play cannot exclude an advisor' using errcode = '55000';
  end if;

  select pg_catalog.count(*)::integer into redeemed_count
  from public.crm_play_members member
  where member.play_id = p_play_id
    and member.advisor_id_snapshot = p_advisor_id
    and member.workflow_status <> 'removed'
    and (
      member.benefit_status = 'redeemed'
      or exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.play_member_id = member.id
          and redemption.status = 'redeemed'
      )
    );

  perform pg_catalog.set_config('app.crm_play_amendment_context', 'member_remove', true);

  delete from public.crm_play_member_benefit_selections selection
  using public.crm_play_members member
  where selection.play_member_id = member.id
    and member.play_id = p_play_id
    and member.advisor_id_snapshot = p_advisor_id
    and member.workflow_status <> 'removed'
    and member.benefit_status <> 'redeemed'
    and not exists (
      select 1
      from public.crm_play_redemptions redemption
      where redemption.play_member_id = member.id
        and redemption.status = 'redeemed'
    );

  with removed as (
    update public.crm_play_members member
    set
      workflow_status = 'removed',
      benefit_status = 'cancelled',
      benefit_reserved_at = null,
      next_follow_up_at = null,
      workflow_closed_at = amended_at,
      last_note = clean_reason,
      last_event_at = amended_at,
      selected_play_benefit_id = null,
      selected_benefit_at = null,
      selected_benefit_by_user_id = null
    where member.play_id = p_play_id
      and member.advisor_id_snapshot = p_advisor_id
      and member.workflow_status <> 'removed'
      and member.benefit_status <> 'redeemed'
      and not exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.play_member_id = member.id
          and redemption.status = 'redeemed'
      )
    returning member.id
  )
  select pg_catalog.count(*)::integer into removed_count from removed;

  if removed_count = 0 and redeemed_count = 0 then
    raise exception 'The advisor has no current clients in this play' using errcode = 'P0002';
  end if;

  actor_id := coalesce(caller_id, play_row.created_by_user_id);
  insert into public.crm_play_amendments (
    play_id, amendment_type, advisor_id_snapshot, previous_values,
    new_values, reason, created_by_user_id, created_at
  ) values (
    p_play_id,
    'advisor_excluded',
    p_advisor_id,
    pg_catalog.jsonb_build_object('assigned_client_count', removed_count + redeemed_count),
    pg_catalog.jsonb_build_object(
      'removed_client_count', removed_count,
      'preserved_redeemed_client_count', redeemed_count
    ),
    clean_reason,
    actor_id,
    amended_at
  );

  perform app_private.crm_refresh_published_play_summary_v1(p_play_id);

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'advisor_id', p_advisor_id,
    'removed_client_count', removed_count,
    'preserved_redeemed_client_count', redeemed_count,
    'changed_at', amended_at
  );
end;
$$;

create or replace function public.crm_search_manual_play_clients_v1(
  p_play_id bigint,
  p_query text,
  p_limit integer default 12
)
returns table (
  client_id bigint,
  full_name text,
  phone text,
  primary_advisor_id uuid,
  primary_advisor_name text,
  current_workflow_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  clean_query text := btrim(coalesce(p_query, ''));
  result_limit integer := greatest(1, least(coalesce(p_limit, 12), 20));
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to search play clients'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.crm_plays play
    where play.id = p_play_id
      and play.status in ('frozen', 'active', 'paused')
  ) then
    raise exception 'Select a confirmed current play' using errcode = '55000';
  end if;
  if length(clean_query) < 2 then
    return;
  end if;

  return query
  select
    client.id,
    client.full_name,
    client.phone,
    client.primary_advisor_id,
    advisor.full_name,
    member.workflow_status
  from public.clients client
  left join public.profiles advisor on advisor.id = client.primary_advisor_id
  left join public.crm_play_members member
    on member.play_id = p_play_id
   and member.client_id = client.id
  where client.is_active
    and (
      client.full_name ilike '%' || clean_query || '%'
      or coalesce(client.phone, '') ilike '%' || clean_query || '%'
      or case
        when clean_query ~ '^[0-9]{1,18}$' then client.id = clean_query::bigint
        else false
      end
    )
  order by
    case when client.full_name ilike clean_query || '%' then 0 else 1 end,
    client.full_name,
    client.id
  limit result_limit;
end;
$$;

revoke all on function public.crm_amend_play_message_v1(bigint, text, text, text)
  from public, anon, authenticated;
revoke all on function public.crm_add_manual_play_member_v1(bigint, bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.crm_remove_published_play_member_v1(bigint, bigint, text)
  from public, anon, authenticated;
revoke all on function public.crm_exclude_play_advisor_v1(bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.crm_search_manual_play_clients_v1(bigint, text, integer)
  from public, anon, authenticated;

grant execute on function public.crm_amend_play_message_v1(bigint, text, text, text)
  to authenticated, service_role;
grant execute on function public.crm_add_manual_play_member_v1(bigint, bigint, uuid, text)
  to authenticated, service_role;
grant execute on function public.crm_remove_published_play_member_v1(bigint, bigint, text)
  to authenticated, service_role;
grant execute on function public.crm_exclude_play_advisor_v1(bigint, uuid, text)
  to authenticated, service_role;
grant execute on function public.crm_search_manual_play_clients_v1(bigint, text, integer)
  to authenticated, service_role;

comment on table public.crm_play_amendments is
  'Immutable audit log for controlled changes made after a CRM play snapshot is confirmed.';

comment on function public.crm_add_manual_play_member_v1(bigint, bigint, uuid, text) is
  'Adds one auditable exception to a confirmed CRM play while preserving overlap and redemption protections.';
