-- Operational supervision by advisor. The snapshot membership remains fixed;
-- these counters only summarize the live workflow and redeemed-benefit facts.

create index if not exists crm_play_members_play_advisor_workflow_idx
  on public.crm_play_members(play_id, advisor_id_snapshot, workflow_status)
  include (benefit_status, next_follow_up_at, last_event_at, responded_at)
  where workflow_status <> 'removed';

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
      count(*) filter (where member.workflow_status = 'pending')::integer as pending_members,
      count(*) filter (where member.workflow_status <> 'pending')::integer as launched_members,
      count(*) filter (
        where member.responded_at is not null
          or member.workflow_status in ('responded', 'accepted', 'converted')
      )::integer as responded_members,
      count(*) filter (where member.workflow_status = 'unreachable')::integer as no_response_members,
      count(*) filter (where member.has_redemption)::integer as redeemed_members,
      count(*) filter (where member.benefit_status = 'expired')::integer as expired_members,
      count(*) filter (
        where member.next_follow_up_at <= pg_catalog.now()
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
  'Returns master/admin-only live play execution counters grouped by snapshot advisor.';
