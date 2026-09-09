-- Creates a clean editable version for a future recurring period. The
-- definition, benefits, upgrades and compatibility rules are copied by v2;
-- the prior client snapshot and manual exclusions are intentionally omitted.

create or replace function public.crm_clone_play_v3(
  p_source_play_id bigint,
  p_name text default null,
  p_shift_months integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  source_play public.crm_plays%rowtype;
  clone_result jsonb;
  cloned_play_id bigint;
  cloned_name text;
  cloned_starts_at timestamptz;
  cloned_ends_at timestamptz;
begin
  if caller_role <> 'service_role'
    and (caller_id is null or not public.is_master_or_admin()) then
    raise exception 'Master or admin access is required to copy a CRM play'
      using errcode = '42501';
  end if;

  if p_shift_months < 0 or p_shift_months > 24 then
    raise exception 'CRM play month shift must be between 0 and 24'
      using errcode = '22023';
  end if;

  select play.* into source_play
  from public.crm_plays play
  where play.id = p_source_play_id;

  if source_play.id is null then
    raise exception 'CRM play does not exist' using errcode = 'P0002';
  end if;

  cloned_name := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  if cloned_name is null and p_shift_months > 0 then
    cloned_name := left(source_play.name || ' · siguiente período', 120);
  end if;

  clone_result := public.crm_clone_play_v2(p_source_play_id, cloned_name);
  cloned_play_id := (clone_result ->> 'play_id')::bigint;

  if p_shift_months > 0 then
    update public.crm_plays play
    set
      starts_at = case
        when source_play.starts_at is null then null
        else source_play.starts_at + pg_catalog.make_interval(months => p_shift_months)
      end,
      ends_at = case
        when source_play.ends_at is null then null
        else source_play.ends_at + pg_catalog.make_interval(months => p_shift_months)
      end
    where play.id = cloned_play_id
      and play.status = 'draft'
    returning play.starts_at, play.ends_at
    into cloned_starts_at, cloned_ends_at;
  else
    select play.starts_at, play.ends_at
    into cloned_starts_at, cloned_ends_at
    from public.crm_plays play
    where play.id = cloned_play_id;
  end if;

  return clone_result || pg_catalog.jsonb_build_object(
    'shift_months', p_shift_months,
    'starts_at', cloned_starts_at,
    'ends_at', cloned_ends_at
  );
end;
$$;

revoke all on function public.crm_clone_play_v3(bigint, text, integer)
  from public, anon, authenticated;
grant execute on function public.crm_clone_play_v3(bigint, text, integer)
  to authenticated, service_role;

comment on function public.crm_clone_play_v3(bigint, text, integer) is
  'Copies a CRM play into a clean draft and optionally moves its validity window forward by whole months.';
