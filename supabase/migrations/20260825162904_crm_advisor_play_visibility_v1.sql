-- Keep unpublished CRM planning private to master/admin users.
-- Advisors only gain read access after a play has been activated.

create or replace function app_private.crm_play_is_visible_to_advisor_v1(p_play_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_plays play
    join public.crm_play_members member_row on member_row.play_id = play.id
    where play.id = p_play_id
      and play.status in ('active', 'paused', 'closed')
      and member_row.advisor_id_snapshot = (select auth.uid())
  );
$$;

revoke all on function app_private.crm_play_is_visible_to_advisor_v1(bigint)
  from public, anon;
grant execute on function app_private.crm_play_is_visible_to_advisor_v1(bigint)
  to authenticated, service_role;

drop policy if exists crm_plays_select_staff on public.crm_plays;

create policy crm_plays_select_staff
on public.crm_plays
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or app_private.crm_play_is_visible_to_advisor_v1(id)
);

drop policy if exists crm_play_members_select_staff on public.crm_play_members;

create policy crm_play_members_select_staff
on public.crm_play_members
for select
to authenticated
using (
  (select public.is_master_or_admin())
  or (
    advisor_id_snapshot = (select auth.uid())
    and app_private.crm_play_is_visible_to_advisor_v1(play_id)
  )
);

drop policy if exists crm_play_member_events_select_staff on public.crm_play_member_events;

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
      and app_private.crm_play_is_visible_to_advisor_v1(member_row.play_id)
  )
);
