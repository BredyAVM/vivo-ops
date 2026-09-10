-- CRM follow-up is evidence-driven, not a rigid wizard. Advisors may record
-- any known milestone manually, while later evidence fills earlier milestones.
-- Redeeming a benefit is definitive evidence that contact, response and launch
-- all happened, even if the advisor did not register them beforehand.

create or replace function public.crm_record_play_member_action_v3(
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
  member_row public.crm_play_members%rowtype;
  play_status text;
  play_starts_at timestamptz;
  play_ends_at timestamptz;
  action_time timestamptz := pg_catalog.now();
  milestone text;
  old_status text;
  milestone_status text;
  missing_contact boolean;
  missing_response boolean;
  missing_launch boolean;
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

  if not (
    member_row.advisor_id_snapshot = caller_id
    or public.is_master_or_admin()
  ) then
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

  milestone := case
    when normalized_action = 'contact' then 'contact'
    when normalized_action = 'responded' then 'responded'
    when normalized_action in ('launched', 'accepted', 'converted', 'not_interested') then 'launched'
    else null
  end;

  if milestone is not null then
    old_status := member_row.workflow_status;
    missing_contact := member_row.contacted_at is null;
    missing_response := milestone in ('responded', 'launched')
      and member_row.responded_at is null;
    missing_launch := milestone = 'launched'
      and member_row.play_launched_at is null;

    milestone_status := case
      when milestone = 'contact'
        and old_status = 'pending'
        then 'contacted'
      when milestone in ('responded', 'launched')
        and old_status in ('pending', 'contacted', 'follow_up_scheduled', 'unreachable')
        then 'responded'
      else old_status
    end;

    if missing_contact or missing_response or missing_launch then
      update public.crm_play_members member
      set
        workflow_status = milestone_status,
        contacted_at = coalesce(member.contacted_at, action_time),
        responded_at = case
          when milestone in ('responded', 'launched')
            then coalesce(member.responded_at, action_time)
          else member.responded_at
        end,
        play_launched_at = case
          when milestone = 'launched'
            then coalesce(member.play_launched_at, action_time)
          else member.play_launched_at
        end,
        last_contact_at = action_time,
        contact_attempt_count = case
          when member.contacted_at is null
            then greatest(member.contact_attempt_count, 1)
          else member.contact_attempt_count
        end,
        last_contact_channel = coalesce(normalized_channel, member.last_contact_channel),
        next_follow_up_at = case
          when milestone = 'contact' then p_follow_up_at
          else null
        end,
        last_note = coalesce(normalized_note, member.last_note),
        last_event_at = action_time
      where member.id = p_play_member_id;

      if missing_contact then
        insert into public.crm_play_member_events (
          play_member_id, event_type, from_status, to_status, channel,
          note, follow_up_at, actor_user_id, created_at
        ) values (
          p_play_member_id,
          'contact',
          old_status,
          milestone_status,
          normalized_channel,
          case
            when normalized_action = 'contact' then normalized_note
            else 'Contacto inferido automáticamente por un hito posterior.'
          end,
          case when milestone = 'contact' then p_follow_up_at else null end,
          caller_id,
          action_time
        );
      end if;

      if missing_response then
        insert into public.crm_play_member_events (
          play_member_id, event_type, from_status, to_status, channel,
          note, actor_user_id, created_at
        ) values (
          p_play_member_id,
          'responded',
          old_status,
          milestone_status,
          normalized_channel,
          case
            when normalized_action = 'responded' then normalized_note
            else 'Respuesta inferida automáticamente al registrar la jugada como lanzada.'
          end,
          caller_id,
          action_time
        );
      end if;

      if missing_launch then
        insert into public.crm_play_member_events (
          play_member_id, event_type, from_status, to_status, channel,
          note, actor_user_id, created_at
        ) values (
          p_play_member_id,
          'launched',
          old_status,
          milestone_status,
          normalized_channel,
          case
            when normalized_action = 'launched' then normalized_note
            else pg_catalog.concat('Lanzamiento inferido al registrar el resultado: ', normalized_action, '.')
          end,
          caller_id,
          action_time
        );
      end if;
    end if;

    if normalized_action in ('contact', 'responded', 'launched') then
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
  end if;

  result := public.crm_record_play_member_action_v1(
    p_play_member_id,
    normalized_action,
    normalized_note,
    p_follow_up_at,
    normalized_channel
  );

  return result;
end;
$$;

revoke all on function public.crm_record_play_member_action_v2(
  bigint, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.crm_record_play_member_action_v2(
  bigint, text, text, timestamptz, text
) to service_role;

revoke all on function public.crm_record_play_member_action_v3(
  bigint, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.crm_record_play_member_action_v3(
  bigint, text, text, timestamptz, text
) to authenticated, service_role;

comment on function public.crm_record_play_member_action_v3(
  bigint, text, text, timestamptz, text
) is
  'Records flexible CRM evidence: later milestones infer any earlier contact, response and launch timestamps that are missing.';

create or replace function app_private.crm_infer_play_funnel_from_redemption_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.crm_play_members member
  set
    contacted_at = coalesce(member.contacted_at, new.created_at),
    responded_at = coalesce(member.responded_at, new.created_at),
    play_launched_at = coalesce(member.play_launched_at, new.created_at),
    last_contact_at = case
      when member.last_contact_at is null then new.created_at
      else greatest(member.last_contact_at, new.created_at)
    end,
    contact_attempt_count = greatest(member.contact_attempt_count, 1),
    last_event_at = case
      when member.last_event_at is null then new.created_at
      else greatest(member.last_event_at, new.created_at)
    end
  where member.id = new.play_member_id;

  return new;
end;
$$;

revoke all on function app_private.crm_infer_play_funnel_from_redemption_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_infer_play_funnel_from_redemption_v1()
  to service_role;

drop trigger if exists crm_play_member_events_infer_redemption_funnel
  on public.crm_play_member_events;
create trigger crm_play_member_events_infer_redemption_funnel
after insert on public.crm_play_member_events
for each row
when (new.event_type = 'benefit_redeemed')
execute function app_private.crm_infer_play_funnel_from_redemption_v1();

-- Keep already-redeemed rows coherent if this migration is applied after live
-- redemptions have occurred. No historical facts are removed or rewritten.
with redemption_evidence as (
  select
    redemption.play_member_id,
    min(redemption.redeemed_at) as evidence_at
  from public.crm_play_redemptions redemption
  where redemption.status = 'redeemed'
  group by redemption.play_member_id
)
update public.crm_play_members member
set
  contacted_at = coalesce(member.contacted_at, evidence.evidence_at),
  responded_at = coalesce(member.responded_at, evidence.evidence_at),
  play_launched_at = coalesce(member.play_launched_at, evidence.evidence_at),
  last_contact_at = case
    when member.last_contact_at is null then evidence.evidence_at
    else greatest(member.last_contact_at, evidence.evidence_at)
  end,
  contact_attempt_count = greatest(member.contact_attempt_count, 1),
  last_event_at = case
    when member.last_event_at is null then evidence.evidence_at
    else greatest(member.last_event_at, evidence.evidence_at)
  end
from redemption_evidence evidence
where member.id = evidence.play_member_id
  and (
    member.contacted_at is null
    or member.responded_at is null
    or member.play_launched_at is null
  );
