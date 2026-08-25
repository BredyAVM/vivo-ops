-- Operational CRM follow-up on top of the immutable play snapshot.
--
-- The member row keeps the current workflow summary for fast advisor lists.
-- Every change is also appended to crm_play_member_events so the commercial
-- history remains auditable. Fresh client metrics are loaded only when an
-- advisor opens one client profile.

alter table public.crm_play_members
  drop constraint crm_play_members_workflow_status_check;

alter table public.crm_play_members
  add column last_contact_at timestamptz,
  add column next_follow_up_at timestamptz,
  add column responded_at timestamptz,
  add column accepted_at timestamptz,
  add column converted_at timestamptz,
  add column workflow_closed_at timestamptz,
  add column contact_attempt_count integer not null default 0,
  add column last_contact_channel text,
  add column last_note text,
  add column last_event_at timestamptz,
  add constraint crm_play_members_workflow_status_check
    check (
      workflow_status in (
        'pending',
        'contacted',
        'follow_up_scheduled',
        'responded',
        'accepted',
        'converted',
        'not_interested',
        'unreachable',
        'not_applicable',
        'closed',
        'removed'
      )
    ),
  add constraint crm_play_members_contact_attempt_count_check
    check (contact_attempt_count >= 0),
  add constraint crm_play_members_last_contact_channel_check
    check (
      last_contact_channel is null
      or last_contact_channel in ('whatsapp', 'call', 'in_person', 'other')
    ),
  add constraint crm_play_members_last_note_check
    check (last_note is null or length(last_note) <= 2000);

create table public.crm_play_member_events (
  id bigint generated always as identity primary key,
  play_member_id bigint not null
    references public.crm_play_members(id) on delete restrict,
  event_type text not null,
  from_status text not null,
  to_status text not null,
  channel text,
  note text,
  follow_up_at timestamptz,
  actor_user_id uuid not null
    references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint crm_play_member_events_type_check
    check (
      event_type in (
        'contact',
        'follow_up',
        'responded',
        'accepted',
        'converted',
        'not_interested',
        'unreachable',
        'not_applicable',
        'closed',
        'note'
      )
    ),
  constraint crm_play_member_events_channel_check
    check (channel is null or channel in ('whatsapp', 'call', 'in_person', 'other')),
  constraint crm_play_member_events_note_check
    check (note is null or length(note) <= 2000),
  constraint crm_play_member_events_status_check
    check (
      from_status in (
        'pending', 'contacted', 'follow_up_scheduled', 'responded', 'accepted',
        'converted', 'not_interested', 'unreachable', 'not_applicable', 'closed', 'removed'
      )
      and to_status in (
        'pending', 'contacted', 'follow_up_scheduled', 'responded', 'accepted',
        'converted', 'not_interested', 'unreachable', 'not_applicable', 'closed', 'removed'
      )
    )
);

create index crm_play_member_events_member_created_idx
  on public.crm_play_member_events(play_member_id, created_at desc, id desc);

create index crm_play_members_advisor_follow_up_idx
  on public.crm_play_members(advisor_id_snapshot, next_follow_up_at, id)
  where next_follow_up_at is not null
    and workflow_status not in (
      'converted', 'not_interested', 'not_applicable', 'closed', 'removed'
    );

create or replace function app_private.crm_play_member_event_immutable_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'CRM play follow-up events are immutable';
end;
$$;

revoke all on function app_private.crm_play_member_event_immutable_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_play_member_event_immutable_v1()
  to service_role;

create trigger crm_play_member_events_immutable
before update or delete on public.crm_play_member_events
for each row execute function app_private.crm_play_member_event_immutable_v1();

alter table public.crm_play_member_events enable row level security;

revoke all on table public.crm_play_member_events from public, anon, authenticated;
grant select on table public.crm_play_member_events to authenticated;
grant all on table public.crm_play_member_events to service_role;
grant usage, select on sequence public.crm_play_member_events_id_seq to service_role;

create policy crm_play_member_events_select_staff
on public.crm_play_member_events
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or exists (
    select 1
    from public.crm_play_members member_row
    where member_row.id = crm_play_member_events.play_member_id
      and member_row.advisor_id_snapshot = (select auth.uid())
  )
);

create or replace function public.crm_record_play_member_action_v1(
  p_play_member_id bigint,
  p_action text,
  p_note text default null,
  p_follow_up_at timestamptz default null,
  p_channel text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  normalized_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  normalized_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  normalized_channel text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_channel, ''))), '');
  member_advisor_id uuid;
  play_id_value bigint;
  play_status text;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
  old_status text;
  new_status text;
  action_time timestamptz := pg_catalog.now();
  result jsonb;
begin
  if caller_id is null then
    raise exception 'Authentication is required for CRM follow-up'
      using errcode = '42501';
  end if;

  if p_play_member_id is null or p_play_member_id <= 0 then
    raise exception 'A valid play member is required'
      using errcode = '22023';
  end if;

  if normalized_action not in (
    'contact', 'follow_up', 'responded', 'accepted', 'converted',
    'not_interested', 'unreachable', 'not_applicable', 'closed', 'note'
  ) then
    raise exception 'Unsupported CRM follow-up action'
      using errcode = '22023';
  end if;

  if normalized_channel is not null
    and normalized_channel not in ('whatsapp', 'call', 'in_person', 'other')
  then
    raise exception 'Unsupported contact channel'
      using errcode = '22023';
  end if;

  if normalized_note is not null and length(normalized_note) > 2000 then
    raise exception 'The follow-up note is too long'
      using errcode = '22023';
  end if;

  if normalized_action = 'follow_up' and p_follow_up_at is null then
    raise exception 'A follow-up date is required'
      using errcode = '22023';
  end if;

  if p_follow_up_at is not null and p_follow_up_at <= action_time then
    raise exception 'The follow-up date must be in the future'
      using errcode = '22023';
  end if;

  if p_follow_up_at is not null and normalized_action not in ('contact', 'follow_up') then
    raise exception 'A follow-up date is only valid for contact or follow-up actions'
      using errcode = '22023';
  end if;

  select
    member_row.advisor_id_snapshot,
    member_row.play_id,
    member_row.workflow_status,
    play.status,
    play.starts_at,
    play.ends_at
  into
    member_advisor_id,
    play_id_value,
    old_status,
    play_status,
    play_starts_at,
    play_ends_at
  from public.crm_play_members member_row
  join public.crm_plays play on play.id = member_row.play_id
  where member_row.id = p_play_member_id
  for update of member_row;

  if play_id_value is null then
    raise exception 'CRM play member does not exist'
      using errcode = 'P0002';
  end if;

  if not (
    member_advisor_id = caller_id
    or public.is_master_or_admin()
  ) then
    raise exception 'This CRM follow-up belongs to another advisor'
      using errcode = '42501';
  end if;

  if play_status <> 'active'
    or (play_starts_at is not null and action_time < play_starts_at)
    or (play_ends_at is not null and action_time >= play_ends_at)
  then
    raise exception 'The CRM play is not active for follow-up'
      using errcode = '55000';
  end if;

  if old_status = 'removed' then
    raise exception 'A removed CRM play member cannot receive follow-up'
      using errcode = '55000';
  end if;

  new_status := case normalized_action
    when 'contact' then case
      when p_follow_up_at is not null then 'follow_up_scheduled'
      else 'contacted'
    end
    when 'follow_up' then 'follow_up_scheduled'
    when 'responded' then 'responded'
    when 'accepted' then 'accepted'
    when 'converted' then 'converted'
    when 'not_interested' then 'not_interested'
    when 'unreachable' then 'unreachable'
    when 'not_applicable' then 'not_applicable'
    when 'closed' then 'closed'
    else old_status
  end;

  update public.crm_play_members member_row
  set
    workflow_status = new_status,
    contacted_at = case
      when normalized_action in ('contact', 'unreachable')
        then coalesce(member_row.contacted_at, action_time)
      else member_row.contacted_at
    end,
    last_contact_at = case
      when normalized_action in ('contact', 'unreachable') then action_time
      else member_row.last_contact_at
    end,
    contact_attempt_count = case
      when normalized_action in ('contact', 'unreachable')
        then member_row.contact_attempt_count + 1
      else member_row.contact_attempt_count
    end,
    last_contact_channel = case
      when normalized_action in ('contact', 'unreachable')
        then coalesce(normalized_channel, member_row.last_contact_channel)
      else member_row.last_contact_channel
    end,
    next_follow_up_at = case
      when normalized_action in ('contact', 'follow_up') then p_follow_up_at
      when normalized_action in (
        'responded', 'accepted', 'converted', 'not_interested',
        'unreachable', 'not_applicable', 'closed'
      ) then null
      else member_row.next_follow_up_at
    end,
    responded_at = case
      when normalized_action = 'responded' then coalesce(member_row.responded_at, action_time)
      else member_row.responded_at
    end,
    accepted_at = case
      when normalized_action = 'accepted' then coalesce(member_row.accepted_at, action_time)
      else member_row.accepted_at
    end,
    converted_at = case
      when normalized_action = 'converted' then coalesce(member_row.converted_at, action_time)
      else member_row.converted_at
    end,
    workflow_closed_at = case
      when normalized_action = 'closed' then coalesce(member_row.workflow_closed_at, action_time)
      else member_row.workflow_closed_at
    end,
    last_note = coalesce(normalized_note, member_row.last_note),
    last_event_at = action_time
  where member_row.id = p_play_member_id;

  insert into public.crm_play_member_events (
    play_member_id,
    event_type,
    from_status,
    to_status,
    channel,
    note,
    follow_up_at,
    actor_user_id,
    created_at
  ) values (
    p_play_member_id,
    normalized_action,
    old_status,
    new_status,
    normalized_channel,
    normalized_note,
    p_follow_up_at,
    caller_id,
    action_time
  );

  select pg_catalog.jsonb_build_object(
    'id', member_row.id,
    'play_id', member_row.play_id,
    'client_id', member_row.client_id,
    'workflow_status', member_row.workflow_status,
    'contact_attempt_count', member_row.contact_attempt_count,
    'last_contact_at', member_row.last_contact_at,
    'next_follow_up_at', member_row.next_follow_up_at,
    'last_event_at', member_row.last_event_at
  )
  into result
  from public.crm_play_members member_row
  where member_row.id = p_play_member_id;

  return result;
end;
$$;

revoke all on function public.crm_record_play_member_action_v1(
  bigint, text, text, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.crm_record_play_member_action_v1(
  bigint, text, text, timestamptz, text
) to authenticated, service_role;

comment on function public.crm_record_play_member_action_v1(
  bigint, text, text, timestamptz, text
) is
  'Atomically updates the current CRM play workflow summary and appends an immutable advisor follow-up event after validating ownership and active play dates.';

comment on table public.crm_play_member_events is
  'Immutable audit trail of advisor contacts, responses, scheduled follow-ups and outcomes for each frozen CRM play member.';

create or replace function crm_private.crm_client_profile_core_v1(
  p_client_id bigint,
  p_purchase_window integer default 6,
  p_recent_limit integer default 5,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with parameters as materialized (
    select
      greatest(2, least(coalesce(p_purchase_window, 6), 50))::integer
        as purchase_window,
      greatest(1, least(coalesce(p_recent_limit, 5), 20))::integer
        as recent_limit,
      coalesce(p_as_of, pg_catalog.now()) as as_of,
      (coalesce(p_as_of, pg_catalog.now()) at time zone 'America/Caracas')::date
        as as_of_date
  ),
  client_record as materialized (
    select
      client_row.id,
      client_row.full_name,
      client_row.phone,
      client_row.client_type,
      client_row.birth_date,
      client_row.important_date,
      client_row.primary_advisor_id,
      client_row.is_active,
      client_row.created_at,
      client_row.updated_at
    from public.clients client_row
    where client_row.id = p_client_id
  ),
  eligible_facts as materialized (
    select fact.*
    from public.commercial_order_facts fact
    cross join parameters
    where fact.client_id = p_client_id
      and fact.purchased_at <= parameters.as_of
  ),
  purchase_facts as materialized (
    select fact.*
    from eligible_facts fact
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
  ),
  ranked_purchases as materialized (
    select
      fact.*,
      pg_catalog.row_number() over (
        order by fact.purchased_at desc, fact.fact_key desc
      ) as purchase_rank
    from purchase_facts fact
  ),
  purchase_metrics as materialized (
    select
      min((fact.purchased_at at time zone 'America/Caracas')::date)
        as first_purchase_on,
      max((fact.purchased_at at time zone 'America/Caracas')::date)
        as last_purchase_on,
      count(*)::bigint as purchase_count,
      coalesce(pg_catalog.round(sum(fact.net_total_usd), 2), 0::numeric)
        as net_revenue_usd,
      pg_catalog.round(avg(fact.net_total_usd), 2) as average_ticket_usd,
      (array_agg(
        fact.attributed_advisor_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) filter (where fact.attributed_advisor_id is not null))[1]
        as last_advisor_id,
      (array_agg(
        fact.advisor_name_snapshot
        order by fact.purchased_at desc, fact.fact_key desc
      ) filter (
        where nullif(pg_catalog.btrim(fact.advisor_name_snapshot), '') is not null
      ))[1] as last_advisor_name_snapshot,
      count(*) filter (where fact.fact_origin = 'historical')::bigint
        as historical_purchase_count,
      count(*) filter (where fact.fact_origin = 'live')::bigint
        as live_purchase_count,
      coalesce(pg_catalog.round(sum(fact.net_total_usd) filter (
        where fact.fact_origin = 'historical'
      ), 2), 0::numeric) as historical_revenue_usd,
      coalesce(pg_catalog.round(sum(fact.net_total_usd) filter (
        where fact.fact_origin = 'live'
      ), 2), 0::numeric) as live_revenue_usd
    from purchase_facts fact
  ),
  recent_dates as materialized (
    select
      (fact.purchased_at at time zone 'America/Caracas')::date as purchase_on,
      lead((fact.purchased_at at time zone 'America/Caracas')::date) over (
        order by fact.purchased_at desc, fact.fact_key desc
      ) as prior_purchase_on
    from ranked_purchases fact
    cross join parameters
    where fact.purchase_rank <= parameters.purchase_window
  ),
  cadence as materialized (
    select
      pg_catalog.round(avg((recent.purchase_on - recent.prior_purchase_on)::numeric), 2)
        as cadence_days
    from recent_dates recent
    where recent.prior_purchase_on is not null
  ),
  gift_metrics as materialized (
    select
      max((fact.purchased_at at time zone 'America/Caracas')::date) filter (
        where fact.event_kind = 'gift_only'
          or cardinality(fact.gift_tags) > 0
      ) as last_gift_on,
      count(*) filter (
        where fact.event_kind = 'gift_only'
          or cardinality(fact.gift_tags) > 0
      )::bigint as gift_event_count
    from eligible_facts fact
  ),
  channel_metrics as materialized (
    select
      coalesce(bool_or(fact.fulfillment = 'pickup'), false) as used_pickup,
      coalesce(bool_or(fact.fulfillment = 'delivery'), false) as used_delivery
    from eligible_facts fact
  ),
  recent_activity as materialized (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'fact_key', recent.fact_key,
          'origin', recent.fact_origin,
          'source_control', recent.source_control,
          'purchased_at', recent.purchased_at,
          'event_kind', recent.event_kind,
          'net_total_usd', recent.net_total_usd,
          'fulfillment', recent.fulfillment,
          'advisor_name', recent.advisor_name_snapshot,
          'has_gift', (
            recent.event_kind = 'gift_only'
            or cardinality(recent.gift_tags) > 0
          )
        )
        order by recent.purchased_at desc, recent.fact_key desc
      ),
      '[]'::jsonb
    ) as items
    from (
      select fact.*
      from eligible_facts fact
      cross join parameters
      order by fact.purchased_at desc, fact.fact_key desc
      limit (select recent_limit from parameters)
    ) recent
  ),
  pending_orders as materialized (
    select
      count(*)::bigint as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', pending.id,
            'order_number', pending.order_number,
            'status', pending.status,
            'created_at', pending.created_at,
            'scheduled_date', pending.scheduled_date,
            'total_usd', pending.total_usd,
            'fulfillment', pending.fulfillment,
            'advisor_name', pending.advisor_name
          )
          order by pending.created_at desc, pending.id desc
        )
        from (
          select
            order_row.id,
            order_row.order_number,
            order_row.status::text as status,
            order_row.created_at,
            case
              when order_row.extra_fields #>> '{schedule,date}'
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                then order_row.extra_fields #>> '{schedule,date}'
              else null
            end as scheduled_date,
            pg_catalog.round(order_row.total_usd, 2) as total_usd,
            order_row.fulfillment::text as fulfillment,
            advisor_profile.full_name as advisor_name
          from public.orders order_row
          left join public.profiles advisor_profile
            on advisor_profile.id = order_row.attributed_advisor_id
          where order_row.client_id = p_client_id
            and order_row.status not in ('delivered', 'cancelled')
          order by order_row.created_at desc, order_row.id desc
          limit (select recent_limit from parameters)
        ) pending
      ), '[]'::jsonb) as items
    from public.orders order_count
    where order_count.client_id = p_client_id
      and order_count.status not in ('delivered', 'cancelled')
  )
  select pg_catalog.jsonb_build_object(
    'client_id', client_row.id,
    'generated_at', parameters.as_of,
    'purchase_window', parameters.purchase_window,
    'client', pg_catalog.jsonb_build_object(
      'id', client_row.id,
      'full_name', client_row.full_name,
      'phone', client_row.phone,
      'client_type', client_row.client_type,
      'birth_date', client_row.birth_date,
      'important_date', client_row.important_date,
      'primary_advisor_id', client_row.primary_advisor_id,
      'is_active', client_row.is_active,
      'created_at', client_row.created_at,
      'updated_at', client_row.updated_at
    ),
    'metrics', pg_catalog.jsonb_build_object(
      'first_purchase_on', purchase_metric.first_purchase_on,
      'last_purchase_on', purchase_metric.last_purchase_on,
      'purchase_count', purchase_metric.purchase_count,
      'net_revenue_usd', purchase_metric.net_revenue_usd,
      'average_ticket_usd', purchase_metric.average_ticket_usd,
      'cadence_days', cadence_metric.cadence_days,
      'last_advisor_id', purchase_metric.last_advisor_id,
      'last_advisor_name', purchase_metric.last_advisor_name_snapshot,
      'last_gift_on', gift_metric.last_gift_on,
      'gift_event_count', gift_metric.gift_event_count,
      'days_since_last_purchase', case
        when purchase_metric.last_purchase_on is null then null
        else (parameters.as_of_date - purchase_metric.last_purchase_on)::integer
      end,
      'used_pickup', channel_metric.used_pickup,
      'used_delivery', channel_metric.used_delivery,
      'historical_purchase_count', purchase_metric.historical_purchase_count,
      'live_purchase_count', purchase_metric.live_purchase_count,
      'historical_revenue_usd', purchase_metric.historical_revenue_usd,
      'live_revenue_usd', purchase_metric.live_revenue_usd
    ),
    'classification', pg_catalog.jsonb_build_object(
      'is_new_client', (
        purchase_metric.first_purchase_on is not null
        and (parameters.as_of_date - purchase_metric.first_purchase_on) between 0 and 30
      ),
      'needs_contact', (
        purchase_metric.last_purchase_on is null
        or (parameters.as_of_date - purchase_metric.last_purchase_on) >= 60
      ),
      'outside_rhythm', (
        cadence_metric.cadence_days is not null
        and cadence_metric.cadence_days > 0
        and purchase_metric.last_purchase_on is not null
        and (parameters.as_of_date - purchase_metric.last_purchase_on)
          > cadence_metric.cadence_days
      )
    ),
    'recent_activity', recent.items,
    'pending_order_count', pending.total_count,
    'pending_orders', pending.items
  )
  from parameters
  cross join client_record client_row
  cross join purchase_metrics purchase_metric
  cross join cadence cadence_metric
  cross join gift_metrics gift_metric
  cross join channel_metrics channel_metric
  cross join recent_activity recent
  cross join pending_orders pending;
$$;

revoke all on function crm_private.crm_client_profile_core_v1(
  bigint, integer, integer, timestamptz
) from public, anon, authenticated;
grant execute on function crm_private.crm_client_profile_core_v1(
  bigint, integer, integer, timestamptz
) to service_role;

create or replace function public.crm_advisor_client_profile_v1(
  p_client_id bigint,
  p_purchase_window integer default 6,
  p_recent_limit integer default 5,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication is required for the client commercial profile'
      using errcode = '42501';
  end if;

  if not (public.has_role('advisor') or public.is_master_or_admin()) then
    raise exception 'Advisor access is required for the client commercial profile'
      using errcode = '42501';
  end if;

  if p_client_id is null or p_client_id <= 0 then
    raise exception 'A valid client id is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.clients client_row
    where client_row.id = p_client_id
  ) then
    raise exception 'Client does not exist'
      using errcode = 'P0002';
  end if;

  if not (
    public.is_master_or_admin()
    or exists (
      select 1
      from public.clients client_row
      where client_row.id = p_client_id
        and client_row.is_active
        and client_row.primary_advisor_id = caller_id
    )
    or exists (
      select 1
      from public.crm_play_members member_row
      join public.crm_plays play on play.id = member_row.play_id
      where member_row.client_id = p_client_id
        and member_row.advisor_id_snapshot = caller_id
        and play.status in ('active', 'paused')
    )
  ) then
    raise exception 'This client does not belong to the advisor portfolio or an active CRM play'
      using errcode = '42501';
  end if;

  return crm_private.crm_client_profile_core_v1(
    p_client_id,
    p_purchase_window,
    p_recent_limit,
    p_as_of
  );
end;
$$;

revoke all on function public.crm_advisor_client_profile_v1(
  bigint, integer, integer, timestamptz
) from public, anon, authenticated;

grant execute on function public.crm_advisor_client_profile_v1(
  bigint, integer, integer, timestamptz
) to authenticated, service_role;

comment on function public.crm_advisor_client_profile_v1(
  bigint, integer, integer, timestamptz
) is
  'Returns one fresh commercial profile only when the client is currently assigned to the caller or appears in one of the caller active CRM plays.';
