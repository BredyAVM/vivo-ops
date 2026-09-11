create or replace function public.crm_rebuild_play_members_v1(p_play_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  play_row public.crm_plays%rowtype;
  generated_at timestamptz := pg_catalog.now();
  rules jsonb;
  excluded_ids jsonb;
  included_advisor_ids jsonb;
  advisor_filter_enabled boolean;
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
  anniversary_mode text;
  last_gift_from date;
  last_gift_to date;
  include_never_gifted boolean;
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

  if not exists (
    select 1 from public.crm_play_benefits option_row
    where option_row.play_id = p_play_id
  ) then
    raise exception 'At least one benefit option is required before generating the list'
      using errcode = '22023';
  end if;

  rules := coalesce(play_row.rules_snapshot, '{}'::jsonb);
  excluded_ids := case
    when pg_catalog.jsonb_typeof(rules -> 'excluded_client_ids') = 'array'
      then rules -> 'excluded_client_ids'
    else '[]'::jsonb
  end;
  advisor_filter_enabled := rules ? 'included_advisor_ids';
  included_advisor_ids := case
    when pg_catalog.jsonb_typeof(rules -> 'included_advisor_ids') = 'array'
      then rules -> 'included_advisor_ids'
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
  anniversary_mode := coalesce(
    nullif(rules ->> 'anniversary_mode', ''),
    case when anniversary_month is null then 'any' else 'include' end
  );
  last_gift_from := nullif(rules ->> 'last_gift_from', '')::date;
  last_gift_to := nullif(rules ->> 'last_gift_to', '')::date;
  include_never_gifted := coalesce((rules ->> 'include_never_gifted')::boolean, true);
  fulfillment_filter := coalesce(nullif(rules ->> 'fulfillment', ''), 'any');

  if maximum_purchases is not null and maximum_purchases < minimum_purchases then
    raise exception 'Maximum purchases cannot be below minimum purchases'
      using errcode = '22023';
  end if;

  if maximum_days is not null and minimum_days is not null and maximum_days < minimum_days then
    raise exception 'Maximum inactive days cannot be below minimum inactive days'
      using errcode = '22023';
  end if;

  if first_from is not null and first_to is not null and first_to < first_from then
    raise exception 'First purchase date range is invalid'
      using errcode = '22023';
  end if;

  if last_from is not null and last_to is not null and last_to < last_from then
    raise exception 'Last purchase date range is invalid'
      using errcode = '22023';
  end if;

  if last_gift_from is not null and last_gift_to is not null and last_gift_to < last_gift_from then
    raise exception 'Last gift date range is invalid'
      using errcode = '22023';
  end if;

  if anniversary_month is not null and anniversary_month not between 1 and 12 then
    raise exception 'Anniversary month must be between 1 and 12'
      using errcode = '22023';
  end if;

  if anniversary_mode not in ('any', 'include', 'exclude') then
    raise exception 'Unsupported anniversary filter mode'
      using errcode = '22023';
  end if;

  if anniversary_mode <> 'any' and anniversary_month is null then
    raise exception 'An anniversary month is required for this filter'
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
    and (
      not advisor_filter_enabled
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(included_advisor_ids) included_advisor(value)
        where included_advisor.value = client_row.primary_advisor_id::text
      )
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
    and (
      anniversary_mode = 'any'
      or (
        anniversary_mode = 'include'
        and extract(month from metric.first_purchase_on)::integer = anniversary_month
      )
      or (
        anniversary_mode = 'exclude'
        and extract(month from metric.first_purchase_on)::integer <> anniversary_month
      )
    )
    and (
      (
        metric.last_gift_on is null
        and include_never_gifted
      )
      or (
        metric.last_gift_on is not null
        and (last_gift_from is null or metric.last_gift_on >= last_gift_from)
        and (last_gift_to is null or metric.last_gift_on <= last_gift_to)
      )
    )
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
    'advisor_filter_enabled', advisor_filter_enabled,
    'included_advisor_count', case
      when advisor_filter_enabled then pg_catalog.jsonb_array_length(included_advisor_ids)
      else null
    end,
    'gifted_client_count', count(*) filter (where member_row.last_gift_on is not null),
    'benefit_count', (
      select count(*)::integer
      from public.crm_play_benefits option_row
      where option_row.play_id = p_play_id
    ),
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

comment on function public.crm_rebuild_play_members_v1(bigint) is
  'Rebuilds a draft CRM play preview using client criteria and an optional persisted advisor allowlist.';
