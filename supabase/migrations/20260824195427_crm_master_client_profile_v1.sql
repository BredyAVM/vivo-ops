-- Lightweight, on-demand commercial profile for the Master client drawer.
--
-- The function returns one JSON document for one client. This keeps the client
-- list fast while still combining historical facts, delivered live orders and
-- current operational orders when a user explicitly opens a client.

create or replace function public.crm_master_client_profile_v1(
  p_client_id bigint,
  p_purchase_window integer default 6,
  p_recent_limit integer default 5,
  p_as_of timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  result jsonb;
begin
  if caller_id is null or not public.is_master_or_admin() then
    raise exception 'Master or admin access is required for the client commercial profile'
      using errcode = '42501';
  end if;

  if p_client_id is null or p_client_id <= 0 then
    raise exception 'A valid client id is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.clients client_row
    where client_row.id = p_client_id
  ) then
    raise exception 'Client does not exist'
      using errcode = 'P0002';
  end if;

  with parameters as materialized (
    select
      greatest(2, least(coalesce(p_purchase_window, 6), 50))::integer
        as purchase_window,
      greatest(1, least(coalesce(p_recent_limit, 5), 20))::integer
        as recent_limit,
      coalesce(p_as_of, pg_catalog.now()) as as_of,
      (coalesce(p_as_of, pg_catalog.now()) at time zone 'America/Caracas')::date
        as as_of_date
  ),
  eligible_facts as materialized (
    select fact.*
    from public.commercial_order_facts fact
    cross join parameters
    where fact.client_id = p_client_id
      and fact.purchased_at <= parameters.as_of
  ),
  purchase_facts as materialized (
    select fact.*
    from eligible_facts fact
    where fact.event_kind = 'purchase'
      and fact.net_total_usd > 0
  ),
  ranked_purchases as materialized (
    select
      fact.*,
      pg_catalog.row_number() over (
        order by fact.purchased_at desc, fact.fact_key desc
      ) as purchase_rank
    from purchase_facts fact
  ),
  purchase_metrics as materialized (
    select
      min((fact.purchased_at at time zone 'America/Caracas')::date)
        as first_purchase_on,
      max((fact.purchased_at at time zone 'America/Caracas')::date)
        as last_purchase_on,
      count(*)::bigint as purchase_count,
      coalesce(pg_catalog.round(sum(fact.net_total_usd), 2), 0::numeric)
        as net_revenue_usd,
      pg_catalog.round(avg(fact.net_total_usd), 2) as average_ticket_usd,
      (array_agg(
        fact.attributed_advisor_id
        order by fact.purchased_at desc, fact.fact_key desc
      ) filter (where fact.attributed_advisor_id is not null))[1]
        as last_advisor_id,
      (array_agg(
        fact.advisor_name_snapshot
        order by fact.purchased_at desc, fact.fact_key desc
      ) filter (
        where nullif(pg_catalog.btrim(fact.advisor_name_snapshot), '') is not null
      ))[1] as last_advisor_name_snapshot,
      count(*) filter (where fact.fact_origin = 'historical')::bigint
        as historical_purchase_count,
      count(*) filter (where fact.fact_origin = 'live')::bigint
        as live_purchase_count,
      coalesce(pg_catalog.round(sum(fact.net_total_usd) filter (
        where fact.fact_origin = 'historical'
      ), 2), 0::numeric) as historical_revenue_usd,
      coalesce(pg_catalog.round(sum(fact.net_total_usd) filter (
        where fact.fact_origin = 'live'
      ), 2), 0::numeric) as live_revenue_usd
    from purchase_facts fact
  ),
  recent_dates as materialized (
    select
      (fact.purchased_at at time zone 'America/Caracas')::date as purchase_on,
      lead((fact.purchased_at at time zone 'America/Caracas')::date) over (
        order by fact.purchased_at desc, fact.fact_key desc
      ) as prior_purchase_on
    from ranked_purchases fact
    cross join parameters
    where fact.purchase_rank <= parameters.purchase_window
  ),
  cadence as materialized (
    select
      pg_catalog.round(avg((recent.purchase_on - recent.prior_purchase_on)::numeric), 2)
        as cadence_days
    from recent_dates recent
    where recent.prior_purchase_on is not null
  ),
  gift_metrics as materialized (
    select
      max((fact.purchased_at at time zone 'America/Caracas')::date) filter (
        where fact.event_kind = 'gift_only'
          or cardinality(fact.gift_tags) > 0
      ) as last_gift_on,
      count(*) filter (
        where fact.event_kind = 'gift_only'
          or cardinality(fact.gift_tags) > 0
      )::bigint as gift_event_count
    from eligible_facts fact
  ),
  channel_metrics as materialized (
    select
      coalesce(bool_or(fact.fulfillment = 'pickup'), false) as used_pickup,
      coalesce(bool_or(fact.fulfillment = 'delivery'), false) as used_delivery
    from eligible_facts fact
  ),
  recent_activity as materialized (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'fact_key', recent.fact_key,
          'origin', recent.fact_origin,
          'source_control', recent.source_control,
          'purchased_at', recent.purchased_at,
          'event_kind', recent.event_kind,
          'net_total_usd', recent.net_total_usd,
          'fulfillment', recent.fulfillment,
          'advisor_name', recent.advisor_name_snapshot,
          'has_gift', (
            recent.event_kind = 'gift_only'
            or cardinality(recent.gift_tags) > 0
          )
        )
        order by recent.purchased_at desc, recent.fact_key desc
      ),
      '[]'::jsonb
    ) as items
    from (
      select fact.*
      from eligible_facts fact
      cross join parameters
      order by fact.purchased_at desc, fact.fact_key desc
      limit (select recent_limit from parameters)
    ) recent
  ),
  pending_orders as materialized (
    select
      count(*)::bigint as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', pending.id,
            'order_number', pending.order_number,
            'status', pending.status,
            'created_at', pending.created_at,
            'scheduled_date', pending.scheduled_date,
            'total_usd', pending.total_usd,
            'fulfillment', pending.fulfillment,
            'advisor_name', pending.advisor_name
          )
          order by pending.created_at desc, pending.id desc
        )
        from (
          select
            order_row.id,
            order_row.order_number,
            order_row.status::text as status,
            order_row.created_at,
            case
              when order_row.extra_fields #>> '{schedule,date}'
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                then order_row.extra_fields #>> '{schedule,date}'
              else null
            end as scheduled_date,
            pg_catalog.round(order_row.total_usd, 2) as total_usd,
            order_row.fulfillment::text as fulfillment,
            advisor_profile.full_name as advisor_name
          from public.orders order_row
          left join public.profiles advisor_profile
            on advisor_profile.id = order_row.attributed_advisor_id
          where order_row.client_id = p_client_id
            and order_row.status not in ('delivered', 'cancelled')
          order by order_row.created_at desc, order_row.id desc
          limit (select recent_limit from parameters)
        ) pending
      ), '[]'::jsonb) as items
    from public.orders order_count
    where order_count.client_id = p_client_id
      and order_count.status not in ('delivered', 'cancelled')
  )
  select pg_catalog.jsonb_build_object(
    'client_id', p_client_id,
    'generated_at', parameters.as_of,
    'purchase_window', parameters.purchase_window,
    'metrics', pg_catalog.jsonb_build_object(
      'first_purchase_on', purchase_metric.first_purchase_on,
      'last_purchase_on', purchase_metric.last_purchase_on,
      'purchase_count', purchase_metric.purchase_count,
      'net_revenue_usd', purchase_metric.net_revenue_usd,
      'average_ticket_usd', purchase_metric.average_ticket_usd,
      'cadence_days', cadence_metric.cadence_days,
      'last_advisor_id', purchase_metric.last_advisor_id,
      'last_advisor_name', purchase_metric.last_advisor_name_snapshot,
      'last_gift_on', gift_metric.last_gift_on,
      'gift_event_count', gift_metric.gift_event_count,
      'days_since_last_purchase', case
        when purchase_metric.last_purchase_on is null then null
        else (parameters.as_of_date - purchase_metric.last_purchase_on)::integer
      end,
      'used_pickup', channel_metric.used_pickup,
      'used_delivery', channel_metric.used_delivery,
      'historical_purchase_count', purchase_metric.historical_purchase_count,
      'live_purchase_count', purchase_metric.live_purchase_count,
      'historical_revenue_usd', purchase_metric.historical_revenue_usd,
      'live_revenue_usd', purchase_metric.live_revenue_usd
    ),
    'classification', pg_catalog.jsonb_build_object(
      'is_new_client', (
        purchase_metric.first_purchase_on is not null
        and (parameters.as_of_date - purchase_metric.first_purchase_on) between 0 and 30
      ),
      'needs_contact', (
        purchase_metric.last_purchase_on is null
        or (parameters.as_of_date - purchase_metric.last_purchase_on) >= 60
      ),
      'outside_rhythm', (
        cadence_metric.cadence_days is not null
        and cadence_metric.cadence_days > 0
        and purchase_metric.last_purchase_on is not null
        and (parameters.as_of_date - purchase_metric.last_purchase_on)
          > cadence_metric.cadence_days
      )
    ),
    'recent_activity', recent.items,
    'pending_order_count', pending.total_count,
    'pending_orders', pending.items
  )
  into result
  from parameters
  cross join purchase_metrics purchase_metric
  cross join cadence cadence_metric
  cross join gift_metrics gift_metric
  cross join channel_metrics channel_metric
  cross join recent_activity recent
  cross join pending_orders pending;

  return result;
end;
$$;

revoke all on function public.crm_master_client_profile_v1(
  bigint, integer, integer, timestamptz
) from public, anon, authenticated;

grant execute on function public.crm_master_client_profile_v1(
  bigint, integer, integer, timestamptz
) to authenticated;

comment on function public.crm_master_client_profile_v1(
  bigint, integer, integer, timestamptz
) is
  'Returns one fresh commercial client profile for Master/Admin: CRM metrics, classification reasons, recent historical/live facts and pending operational orders.';
