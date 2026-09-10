-- A redeemed benefit is the definitive outcome of a play member. Once it is
-- delivered, manual follow-up controls must stop and operational counters must
-- no longer classify the member as pending.

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
  benefit_status_value text;
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
    member_row.benefit_status,
    play.status,
    play.starts_at,
    play.ends_at
  into
    member_advisor_id,
    play_id_value,
    old_status,
    benefit_status_value,
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

  if benefit_status_value = 'redeemed' then
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
  'Updates advisor follow-up while the play is active and the benefit has not been delivered, preserving ownership and immutable event checks.';

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
      member.responded_at,
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
        where member.workflow_status = 'pending'
          and not member.has_redemption
      )::integer as pending_members,
      count(*) filter (
        where member.workflow_status <> 'pending'
      )::integer as launched_members,
      count(*) filter (
        where member.responded_at is not null
          or member.workflow_status in ('responded', 'accepted', 'converted')
      )::integer as responded_members,
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
        'launched_members', rollup.launched_members,
        'responded_members', rollup.responded_members,
        'no_response_members', rollup.no_response_members,
        'redeemed_members', rollup.redeemed_members,
        'expired_members', rollup.expired_members,
        'overdue_follow_ups', rollup.overdue_follow_ups,
        'launch_rate_pct', case
          when rollup.total_members = 0 then 0
          else pg_catalog.round(100.0 * rollup.launched_members / rollup.total_members, 1)
        end,
        'response_rate_pct', case
          when rollup.launched_members = 0 then 0
          else pg_catalog.round(100.0 * rollup.responded_members / rollup.launched_members, 1)
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
  'Returns master/admin live execution counters and excludes delivered benefits from pending and overdue follow-up totals.';
