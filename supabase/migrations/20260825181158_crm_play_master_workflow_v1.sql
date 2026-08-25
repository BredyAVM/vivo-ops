-- Master/Admin workflow for designing, reviewing and sharing CRM plays.
-- Draft membership remains editable; frozen membership is the immutable snapshot.

create policy crm_play_members_insert_master_admin
on public.crm_play_members
for insert
to authenticated
with check ((select public.is_master_or_admin()));

create policy crm_play_members_update_master_admin
on public.crm_play_members
for update
to authenticated
using ((select public.is_master_or_admin()))
with check ((select public.is_master_or_admin()));

create policy crm_play_members_delete_master_admin
on public.crm_play_members
for delete
to authenticated
using ((select public.is_master_or_admin()));

create or replace function public.crm_rebuild_play_members_v1(p_play_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  play_row public.crm_plays%rowtype;
  generated_at timestamptz := pg_catalog.now();
  rules jsonb;
  excluded_ids jsonb;
  minimum_purchases integer;
  maximum_purchases integer;
  minimum_revenue numeric;
  minimum_days integer;
  maximum_days integer;
  first_from date;
  first_to date;
  last_from date;
  last_to date;
  anniversary_month integer;
  fulfillment_filter text;
  v_selection_summary jsonb;
begin
  if caller_id is null or not public.is_master_or_admin() then
    raise exception 'Master or admin access is required to generate a CRM play list'
      using errcode = '42501';
  end if;

  if p_play_id is null or p_play_id <= 0 then
    raise exception 'A valid CRM play is required'
      using errcode = '22023';
  end if;

  select play.*
    into play_row
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_row.id is null then
    raise exception 'CRM play does not exist'
      using errcode = 'P0002';
  end if;

  if play_row.status <> 'draft' then
    raise exception 'Only a draft CRM play can rebuild its client list'
      using errcode = '55000';
  end if;

  rules := coalesce(play_row.rules_snapshot, '{}'::jsonb);
  excluded_ids := case
    when pg_catalog.jsonb_typeof(rules -> 'excluded_client_ids') = 'array'
      then rules -> 'excluded_client_ids'
    else '[]'::jsonb
  end;
  minimum_purchases := greatest(0, coalesce((rules ->> 'min_purchase_count')::integer, 0));
  maximum_purchases := nullif(rules ->> 'max_purchase_count', '')::integer;
  minimum_revenue := greatest(0, coalesce((rules ->> 'min_net_revenue_usd')::numeric, 0));
  minimum_days := nullif(rules ->> 'min_days_since_purchase', '')::integer;
  maximum_days := nullif(rules ->> 'max_days_since_purchase', '')::integer;
  first_from := nullif(rules ->> 'first_purchase_from', '')::date;
  first_to := nullif(rules ->> 'first_purchase_to', '')::date;
  last_from := nullif(rules ->> 'last_purchase_from', '')::date;
  last_to := nullif(rules ->> 'last_purchase_to', '')::date;
  anniversary_month := nullif(rules ->> 'anniversary_month', '')::integer;
  fulfillment_filter := coalesce(nullif(rules ->> 'fulfillment', ''), 'any');

  if maximum_purchases is not null and maximum_purchases < minimum_purchases then
    raise exception 'Maximum purchases cannot be below minimum purchases'
      using errcode = '22023';
  end if;

  if maximum_days is not null and minimum_days is not null and maximum_days < minimum_days then
    raise exception 'Maximum inactive days cannot be below minimum inactive days'
      using errcode = '22023';
  end if;

  if anniversary_month is not null and anniversary_month not between 1 and 12 then
    raise exception 'Anniversary month must be between 1 and 12'
      using errcode = '22023';
  end if;

  if fulfillment_filter not in ('any', 'pickup', 'delivery') then
    raise exception 'Unsupported fulfillment filter'
      using errcode = '22023';
  end if;

  delete from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  insert into public.crm_play_members (
    play_id,
    client_id,
    advisor_id_snapshot,
    eligible_at,
    first_purchase_on,
    last_purchase_on,
    purchase_count,
    net_revenue_usd,
    average_ticket_usd,
    cadence_days,
    cadence_window,
    last_advisor_id,
    last_advisor_name_snapshot,
    last_gift_on,
    days_since_last_purchase,
    used_pickup,
    used_delivery,
    decision_snapshot,
    eligibility_reasons
  )
  select
    p_play_id,
    metric.client_id,
    client_row.primary_advisor_id,
    generated_at,
    metric.first_purchase_on,
    metric.last_purchase_on,
    metric.purchase_count::integer,
    metric.net_revenue_usd,
    metric.average_ticket_usd,
    metric.cadence_days,
    metric.cadence_window_used,
    metric.last_advisor_id,
    metric.last_advisor_name_snapshot,
    metric.last_gift_on,
    metric.days_since_last_purchase,
    coalesce(metric.used_pickup, false),
    coalesce(metric.used_delivery, false),
    pg_catalog.jsonb_build_object(
      'rules', rules - 'excluded_client_ids',
      'generated_at', generated_at,
      'primary_advisor_id', client_row.primary_advisor_id
    ),
    array['Cumple los filtros de la jugada al momento del corte']::text[]
  from public.crm_client_metrics_v1(play_row.metric_window, generated_at) metric
  join public.clients client_row on client_row.id = metric.client_id
  join public.profiles advisor_profile on advisor_profile.id = client_row.primary_advisor_id
  where client_row.is_active
    and advisor_profile.is_active
    and exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = client_row.primary_advisor_id
        and role_row.role = 'advisor'
    )
    and metric.purchase_count >= minimum_purchases
    and (maximum_purchases is null or metric.purchase_count <= maximum_purchases)
    and metric.net_revenue_usd >= minimum_revenue
    and (minimum_days is null or metric.days_since_last_purchase >= minimum_days)
    and (maximum_days is null or metric.days_since_last_purchase <= maximum_days)
    and (first_from is null or metric.first_purchase_on >= first_from)
    and (first_to is null or metric.first_purchase_on <= first_to)
    and (last_from is null or metric.last_purchase_on >= last_from)
    and (last_to is null or metric.last_purchase_on <= last_to)
    and (anniversary_month is null or extract(month from metric.first_purchase_on)::integer = anniversary_month)
    and (
      fulfillment_filter = 'any'
      or (fulfillment_filter = 'pickup' and metric.used_pickup)
      or (fulfillment_filter = 'delivery' and metric.used_delivery)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(excluded_ids) excluded(value)
      where excluded.value ~ '^[0-9]+$'
        and excluded.value::bigint = metric.client_id
    );

  select pg_catalog.jsonb_build_object(
    'total', count(*)::integer,
    'advisor_count', count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', generated_at,
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        )
        order by advisor_totals.member_count desc, advisor_totals.advisor_name
      )
      from (
        select
          grouped.advisor_id_snapshot as advisor_id,
          coalesce(advisor.full_name, 'Asesor sin nombre') as advisor_name,
          count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into v_selection_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  update public.crm_plays play
  set selection_summary = v_selection_summary
  where play.id = p_play_id;

  return v_selection_summary;
end;
$$;

revoke all on function public.crm_rebuild_play_members_v1(bigint)
  from public, anon, authenticated;
grant execute on function public.crm_rebuild_play_members_v1(bigint)
  to authenticated, service_role;

create or replace function public.crm_exclude_play_client_v1(
  p_play_id bigint,
  p_client_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  play_status text;
  rules jsonb;
  excluded_ids jsonb;
  v_selection_summary jsonb;
begin
  if caller_id is null or not public.is_master_or_admin() then
    raise exception 'Master or admin access is required to exclude a CRM play client'
      using errcode = '42501';
  end if;

  if p_play_id is null or p_play_id <= 0 or p_client_id is null or p_client_id <= 0 then
    raise exception 'A valid CRM play and client are required'
      using errcode = '22023';
  end if;

  select play.status, coalesce(play.rules_snapshot, '{}'::jsonb)
    into play_status, rules
  from public.crm_plays play
  where play.id = p_play_id
  for update;

  if play_status is null then
    raise exception 'CRM play does not exist'
      using errcode = 'P0002';
  end if;

  if play_status <> 'draft' then
    raise exception 'Clients can only be excluded while the CRM play is a draft'
      using errcode = '55000';
  end if;

  select coalesce(pg_catalog.jsonb_agg(candidate.client_id order by candidate.client_id), '[]'::jsonb)
    into excluded_ids
  from (
    select distinct existing.value::bigint as client_id
    from pg_catalog.jsonb_array_elements_text(
      case
        when pg_catalog.jsonb_typeof(rules -> 'excluded_client_ids') = 'array'
          then rules -> 'excluded_client_ids'
        else '[]'::jsonb
      end
    ) existing(value)
    where existing.value ~ '^[0-9]+$'
    union
    select p_client_id
  ) candidate;

  update public.crm_plays play
  set rules_snapshot = pg_catalog.jsonb_set(rules, '{excluded_client_ids}', excluded_ids, true)
  where play.id = p_play_id;

  delete from public.crm_play_members member_row
  where member_row.play_id = p_play_id
    and member_row.client_id = p_client_id;

  select pg_catalog.jsonb_build_object(
    'total', count(*)::integer,
    'advisor_count', count(distinct member_row.advisor_id_snapshot)::integer,
    'generated_at', coalesce(
      (select play.selection_summary ->> 'generated_at' from public.crm_plays play where play.id = p_play_id),
      pg_catalog.now()::text
    ),
    'excluded_count', pg_catalog.jsonb_array_length(excluded_ids),
    'by_advisor', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'advisor_id', advisor_totals.advisor_id,
          'advisor_name', advisor_totals.advisor_name,
          'count', advisor_totals.member_count
        )
        order by advisor_totals.member_count desc, advisor_totals.advisor_name
      )
      from (
        select
          grouped.advisor_id_snapshot as advisor_id,
          coalesce(advisor.full_name, 'Asesor sin nombre') as advisor_name,
          count(*)::integer as member_count
        from public.crm_play_members grouped
        left join public.profiles advisor on advisor.id = grouped.advisor_id_snapshot
        where grouped.play_id = p_play_id
        group by grouped.advisor_id_snapshot, advisor.full_name
      ) advisor_totals
    ), '[]'::jsonb)
  )
  into v_selection_summary
  from public.crm_play_members member_row
  where member_row.play_id = p_play_id;

  update public.crm_plays play
  set selection_summary = v_selection_summary
  where play.id = p_play_id;

  return v_selection_summary;
end;
$$;

revoke all on function public.crm_exclude_play_client_v1(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.crm_exclude_play_client_v1(bigint, bigint)
  to authenticated, service_role;

comment on function public.crm_rebuild_play_members_v1(bigint) is
  'Rebuilds a draft CRM play snapshot from current commercial metrics and current active advisor assignments.';

comment on function public.crm_exclude_play_client_v1(bigint, bigint) is
  'Persistently excludes one client from a draft CRM play and refreshes its review summary.';
