create or replace function public.save_advisor_goal_publications_v1(
  p_period_id bigint,
  p_period_config jsonb,
  p_publications jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  publication_count integer;
  distinct_advisor_count integer;
  updated_count integer;
begin
  if not (select public.is_master_or_admin()) then
    raise exception 'Administrator role required';
  end if;

  if p_period_id is null or p_period_id <= 0 then
    raise exception 'A valid commission period is required';
  end if;
  if p_period_config is null or pg_catalog.jsonb_typeof(p_period_config) <> 'object' then
    raise exception 'The goal period configuration must be an object';
  end if;
  if p_publications is null or pg_catalog.jsonb_typeof(p_publications) <> 'array' then
    raise exception 'Goal publications must be an array';
  end if;

  perform 1
  from public.advisor_commission_periods period
  where period.id = p_period_id
    and period.status = 'open'
  for update;
  if not found then
    raise exception 'The commission period is unavailable or no longer open';
  end if;

  select
    pg_catalog.jsonb_array_length(p_publications),
    count(distinct publication.advisor_user_id)
  into publication_count, distinct_advisor_count
  from pg_catalog.jsonb_to_recordset(p_publications)
    as publication(advisor_user_id uuid, advisor_goal jsonb);

  if publication_count <= 0 then
    raise exception 'At least one advisor goal publication is required';
  end if;
  if distinct_advisor_count <> publication_count then
    raise exception 'Goal publications contain duplicate or invalid advisors';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_publications)
      as publication(advisor_user_id uuid, advisor_goal jsonb)
    where publication.advisor_user_id is null
      or publication.advisor_goal is null
      or pg_catalog.jsonb_typeof(publication.advisor_goal) <> 'object'
  ) then
    raise exception 'Every publication requires an advisor and an object snapshot';
  end if;

  with publication_rows as materialized (
    select publication.advisor_user_id, publication.advisor_goal
    from pg_catalog.jsonb_to_recordset(p_publications)
      as publication(advisor_user_id uuid, advisor_goal jsonb)
  ),
  updated as (
    update public.advisor_commission_closures closure
    set
      snapshot = coalesce(closure.snapshot, '{}'::jsonb)
        || pg_catalog.jsonb_build_object('advisorGoal', publication.advisor_goal),
      updated_at = pg_catalog.now()
    from publication_rows publication
    join public.profiles advisor
      on advisor.id = publication.advisor_user_id
     and advisor.is_active = true
     and coalesce(advisor.receives_commissions, false) = true
    where closure.period_id = p_period_id
      and closure.advisor_user_id = publication.advisor_user_id
    returning closure.id
  )
  select count(*) into updated_count from updated;

  if updated_count <> publication_count then
    raise exception 'Every active commission advisor must have a closure before publishing goals';
  end if;

  update public.advisor_commission_periods
  set goal_config = p_period_config, updated_at = pg_catalog.now()
  where id = p_period_id;

  return updated_count;
end;
$$;

comment on function public.save_advisor_goal_publications_v1(bigint, jsonb, jsonb) is
  'Atomically stores one versioned period goal configuration and one advisor goal snapshot per existing commission closure.';

revoke all on function public.save_advisor_goal_publications_v1(bigint, jsonb, jsonb)
  from public, anon;
grant execute on function public.save_advisor_goal_publications_v1(bigint, jsonb, jsonb)
  to authenticated, service_role;
