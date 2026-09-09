-- Atomic lifecycle controls keep advisor visibility and benefit availability
-- aligned. Closing a play expires every benefit that was not redeemed.

create or replace function public.crm_change_play_lifecycle_v1(
  p_play_id bigint,
  p_command text
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
  next_status text;
  expired_count integer := 0;
  changed_at timestamptz := pg_catalog.now();
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to manage a CRM play'
      using errcode = '42501';
  end if;

  select play.* into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  case p_command
    when 'pause' then
      if play_row.status <> 'active' then
        raise exception 'Only an active CRM play can be paused' using errcode = '55000';
      end if;
      next_status := 'paused';
    when 'resume' then
      if play_row.status <> 'paused' then
        raise exception 'Only a paused CRM play can be resumed' using errcode = '55000';
      end if;
      next_status := 'active';
    when 'close' then
      if play_row.status not in ('active', 'paused') then
        raise exception 'Only an active or paused CRM play can be closed' using errcode = '55000';
      end if;
      next_status := 'closed';
    else
      raise exception 'Invalid CRM play lifecycle command' using errcode = '22023';
  end case;

  if p_command = 'close' then
    with expired as (
      update public.crm_play_members member_row
      set benefit_status = 'expired'
      where member_row.play_id = p_play_id
        and member_row.benefit_status in ('available', 'reserved')
      returning member_row.id
    )
    select count(*)::integer into expired_count from expired;
  end if;

  update public.crm_plays play
  set
    status = next_status,
    closed_at = case when next_status = 'closed' then changed_at else play.closed_at end
  where play.id = p_play_id;

  return pg_catalog.jsonb_build_object(
    'play_id', p_play_id,
    'previous_status', play_row.status,
    'status', next_status,
    'expired_benefit_count', expired_count,
    'changed_at', changed_at
  );
end;
$$;

revoke all on function public.crm_change_play_lifecycle_v1(bigint, text)
  from public, anon, authenticated;
grant execute on function public.crm_change_play_lifecycle_v1(bigint, text)
  to authenticated, service_role;

comment on function public.crm_change_play_lifecycle_v1(bigint, text) is
  'Atomically pauses, resumes or closes a CRM play; closing expires all unredeemed member benefits.';
