-- Split the advisor outreach funnel into three auditable milestones:
-- 1. initial WhatsApp contact, 2. greeting response, 3. actual play launch.
-- Existing `contact` events came from the old "Jugada lanzada" control, so
-- they are conservatively preserved as historical launches.

alter table public.crm_play_members
  add column if not exists play_launched_at timestamptz;

alter table public.crm_play_member_events
  drop constraint if exists crm_play_member_events_type_check;

alter table public.crm_play_member_events
  add constraint crm_play_member_events_type_check
    check (
      event_type in (
        'contact',
        'follow_up',
        'responded',
        'launched',
        'accepted',
        'converted',
        'not_interested',
        'unreachable',
        'not_applicable',
        'closed',
        'note',
        'benefit_selected',
        'benefit_redeemed'
      )
    );

with historical_launches as (
  select event.play_member_id, min(event.created_at) as launched_at
  from public.crm_play_member_events event
  where event.event_type = 'contact'
  group by event.play_member_id
)
update public.crm_play_members member
set play_launched_at = historical.launched_at
from historical_launches historical
where member.id = historical.play_member_id
  and member.play_launched_at is null;

create or replace function public.crm_record_play_member_action_v2(
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
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  normalized_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  normalized_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  normalized_channel text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_channel, ''))), '');
  member_row public.crm_play_members%rowtype;
  play_status text;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
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
    'contact', 'follow_up', 'responded', 'launched', 'accepted', 'converted',
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

  select member.*
  into member_row
  from public.crm_play_members member
  where member.id = p_play_member_id
  for update;

  if member_row.id is null then
    raise exception 'CRM play member does not exist'
      using errcode = 'P0002';
  end if;

  select play.status, play.starts_at, play.ends_at
  into play_status, play_starts_at, play_ends_at
  from public.crm_plays play
  where play.id = member_row.play_id;

  if caller_role <> 'service_role'
    and not (
      member_row.advisor_id_snapshot = caller_id
      or public.is_master_or_admin()
    )
  then
    raise exception 'This CRM follow-up belongs to another advisor'
      using errcode = '42501';
  end if;

  if member_row.benefit_status = 'redeemed' then
    raise exception 'The play benefit was already delivered; manual follow-up is closed'
      using errcode = '55000';
  end if;

  if play_status <> 'active'
    or (play_starts_at is not null and action_time < play_starts_at)
    or (play_ends_at is not null and action_time >= play_ends_at)
  then
    raise exception 'The CRM play is not active for follow-up'
      using errcode = '55000';
  end if;

  if member_row.workflow_status = 'removed' then
    raise exception 'A removed CRM play member cannot receive follow-up'
      using errcode = '55000';
  end if;

  -- Milestones are idempotent so double clicks do not inflate activity.
  if (normalized_action = 'contact' and member_row.contacted_at is not null)
    or (normalized_action = 'responded' and member_row.responded_at is not null)
    or (normalized_action = 'launched' and member_row.play_launched_at is not null)
  then
    select pg_catalog.jsonb_build_object(
      'id', member.id,
      'play_id', member.play_id,
      'client_id', member.client_id,
      'workflow_status', member.workflow_status,
      'contact_attempt_count', member.contact_attempt_count,
      'contacted_at', member.contacted_at,
      'responded_at', member.responded_at,
      'play_launched_at', member.play_launched_at,
      'last_contact_at', member.last_contact_at,
      'next_follow_up_at', member.next_follow_up_at,
      'last_event_at', member.last_event_at
    )
    into result
    from public.crm_play_members member
    where member.id = p_play_member_id;

    return result;
  end if;

  if normalized_action in ('responded', 'unreachable')
    and member_row.contacted_at is null
  then
    raise exception 'Open WhatsApp before recording the greeting result'
      using errcode = '55000';
  end if;

  if normalized_action = 'launched' and member_row.responded_at is null then
    raise exception 'Record the greeting response before launching the play'
      using errcode = '55000';
  end if;

  if normalized_action = 'launched' then
    update public.crm_play_members member
    set
      play_launched_at = action_time,
      last_contact_at = action_time,
      last_contact_channel = coalesce(normalized_channel, member.last_contact_channel),
      next_follow_up_at = null,
      last_note = coalesce(normalized_note, member.last_note),
      last_event_at = action_time
    where member.id = p_play_member_id;

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
      'launched',
      member_row.workflow_status,
      member_row.workflow_status,
      coalesce(normalized_channel, 'whatsapp'),
      normalized_note,
      null,
      caller_id,
      action_time
    );
  else
    result := public.crm_record_play_member_action_v1(
      p_play_member_id,
      normalized_action,
      normalized_note,
      p_follow_up_at,
      normalized_channel
    );
  end if;

  select pg_catalog.jsonb_build_object(
    'id', member.id,
    'play_id', member.play_id,
    'client_id', member.client_id,
    'workflow_status', member.workflow_status,
    'contact_attempt_count', member.contact_attempt_count,
    'contacted_at', member.contacted_at,
    'responded_at', member.responded_at,
    'play_launched_at', member.play_launched_at,
    'last_contact_at', member.last_contact_at,
    'next_follow_up_at', member.next_follow_up_at,
    'last_event_at', member.last_event_at
  )
  into result
  from public.crm_play_members member
  where member.id = p_play_member_id;

  return result;
end;
$$;

revoke all on function public.crm_record_play_member_action_v1(
  bigint, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.crm_record_play_member_action_v1(
  bigint, text, text, timestamptz, text
) to service_role;

revoke all on function public.crm_record_play_member_action_v2(
  bigint, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.crm_record_play_member_action_v2(
  bigint, text, text, timestamptz, text
) to authenticated, service_role;

comment on function public.crm_record_play_member_action_v2(
  bigint, text, text, timestamptz, text
) is
  'Records initial contact, greeting response and play launch as separate, ordered and idempotent CRM milestones.';

create or replace function public.crm_get_play_advisor_monitor_v1(p_play_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  result jsonb;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to monitor a CRM play'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.crm_plays play
    where play.id = p_play_id
  ) then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  with member_base as materialized (
    select
      member.id,
      member.advisor_id_snapshot,
      coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Sin asesor') as advisor_name,
      member.workflow_status,
      member.benefit_status,
      member.contacted_at,
      member.responded_at,
      member.play_launched_at,
      member.next_follow_up_at,
      member.last_event_at,
      exists (
        select 1
        from public.crm_play_redemptions redemption
        where redemption.play_member_id = member.id
          and redemption.status = 'redeemed'
      ) as has_redemption
    from public.crm_play_members member
    left join public.profiles profile on profile.id = member.advisor_id_snapshot
    where member.play_id = p_play_id
      and member.workflow_status <> 'removed'
  ),
  advisor_rollup as (
    select
      member.advisor_id_snapshot,
      member.advisor_name,
      count(*)::integer as total_members,
      count(*) filter (
        where member.contacted_at is null
          and not member.has_redemption
      )::integer as pending_members,
      count(*) filter (where member.contacted_at is not null)::integer as contacted_members,
      count(*) filter (where member.responded_at is not null)::integer as responded_members,
      count(*) filter (where member.play_launched_at is not null)::integer as launched_members,
      count(*) filter (where member.workflow_status = 'unreachable')::integer as no_response_members,
      count(*) filter (where member.has_redemption)::integer as redeemed_members,
      count(*) filter (where member.benefit_status = 'expired')::integer as expired_members,
      count(*) filter (
        where member.next_follow_up_at <= pg_catalog.now()
          and not member.has_redemption
          and member.workflow_status not in (
            'converted', 'not_interested', 'not_applicable', 'closed', 'removed'
          )
      )::integer as overdue_follow_ups,
      max(member.last_event_at) as last_activity_at
    from member_base member
    group by member.advisor_id_snapshot, member.advisor_name
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'advisor_id', rollup.advisor_id_snapshot,
        'advisor_name', rollup.advisor_name,
        'total_members', rollup.total_members,
        'pending_members', rollup.pending_members,
        'contacted_members', rollup.contacted_members,
        'responded_members', rollup.responded_members,
        'launched_members', rollup.launched_members,
        'no_response_members', rollup.no_response_members,
        'redeemed_members', rollup.redeemed_members,
        'expired_members', rollup.expired_members,
        'overdue_follow_ups', rollup.overdue_follow_ups,
        'contact_rate_pct', case
          when rollup.total_members = 0 then 0
          else pg_catalog.round(100.0 * rollup.contacted_members / rollup.total_members, 1)
        end,
        'response_rate_pct', case
          when rollup.contacted_members = 0 then 0
          else pg_catalog.round(100.0 * rollup.responded_members / rollup.contacted_members, 1)
        end,
        'launch_rate_pct', case
          when rollup.total_members = 0 then 0
          else pg_catalog.round(100.0 * rollup.launched_members / rollup.total_members, 1)
        end,
        'last_activity_at', rollup.last_activity_at
      )
      order by rollup.pending_members desc, rollup.overdue_follow_ups desc,
        rollup.advisor_name, rollup.advisor_id_snapshot
    ),
    '[]'::jsonb
  )
  into result
  from advisor_rollup rollup;

  return result;
end;
$$;

revoke all on function public.crm_get_play_advisor_monitor_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_get_play_advisor_monitor_v1(bigint)
  to authenticated, service_role;

comment on function public.crm_get_play_advisor_monitor_v1(bigint) is
  'Returns separate initial-contact, greeting-response and play-launch counters for master/admin supervision.';
