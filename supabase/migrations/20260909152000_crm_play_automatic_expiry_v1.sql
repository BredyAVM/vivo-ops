-- Close due CRM plays and expire every unused benefit without requiring a
-- dashboard visit. The job is deliberately small and runs entirely in Postgres.

create extension if not exists pg_cron;

create or replace function app_private.crm_expire_due_plays_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_play_ids bigint[];
  closed_play_count integer := 0;
  expired_benefit_count integer := 0;
  changed_at timestamptz := pg_catalog.now();
begin
  select pg_catalog.array_agg(locked_play.id order by locked_play.id)
    into due_play_ids
  from (
    select play.id
    from public.crm_plays play
    where play.status in ('active', 'paused')
      and play.ends_at is not null
      and play.ends_at <= changed_at
    order by play.id
    for update skip locked
  ) locked_play;

  if due_play_ids is null or pg_catalog.cardinality(due_play_ids) = 0 then
    return pg_catalog.jsonb_build_object(
      'closed_play_count', 0,
      'expired_benefit_count', 0,
      'changed_at', changed_at
    );
  end if;

  with expired as (
    update public.crm_play_members member_row
    set
      benefit_status = 'expired',
      benefit_expired_at = coalesce(member_row.benefit_expired_at, changed_at)
    where member_row.play_id = any(due_play_ids)
      and member_row.benefit_status in ('available', 'reserved')
    returning member_row.id
  )
  select count(*)::integer into expired_benefit_count from expired;

  with closed as (
    update public.crm_plays play
    set
      status = 'closed',
      closed_at = changed_at
    where play.id = any(due_play_ids)
      and play.status in ('active', 'paused')
    returning play.id
  )
  select count(*)::integer into closed_play_count from closed;

  return pg_catalog.jsonb_build_object(
    'closed_play_count', closed_play_count,
    'expired_benefit_count', expired_benefit_count,
    'changed_at', changed_at
  );
end;
$$;

revoke all on function app_private.crm_expire_due_plays_v1()
  from public, anon, authenticated;
grant execute on function app_private.crm_expire_due_plays_v1()
  to service_role;

comment on function app_private.crm_expire_due_plays_v1() is
  'Closes active or paused CRM plays whose period ended and expires only their unused benefits.';

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select job.jobid
    from cron.job job
    where job.jobname = 'crm-play-automatic-expiry-v1'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'crm-play-automatic-expiry-v1',
    '*/15 * * * *',
    'select app_private.crm_expire_due_plays_v1();'
  );
end;
$schedule$;
