
create index if not exists order_events_counter_delivered_at_idx
  on public.order_events (created_at desc, order_id desc)
  where event = 'delivered';

create or replace function public.counter_list_today_delivered_orders(
  p_cursor_delivered_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 25);
  v_service_date date := (now() at time zone 'America/Caracas')::date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_active_rate numeric;
  v_payload jsonb;
begin
  if (select auth.uid()) is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if (p_cursor_delivered_at is null) <> (p_cursor_id is null) then
    raise exception 'counter_daily_history_cursor_invalid' using errcode = '22023';
  end if;

  v_day_start := v_service_date::timestamp at time zone 'America/Caracas';
  v_day_end := (v_service_date + 1)::timestamp at time zone 'America/Caracas';

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  with delivered_events as materialized (
    select
      event_row.order_id,
      max(event_row.created_at) as delivered_at
    from public.order_events event_row
    where event_row.event = 'delivered'
      and event_row.created_at >= v_day_start
      and event_row.created_at < v_day_end
    group by event_row.order_id
  ),
  matched as materialized (
    select
      order_row.id,
      order_row.order_number,
      order_row.status,
      order_row.fulfillment,
      order_row.receiver_name,
      order_row.receiver_phone,
      order_row.total_usd,
      order_row.total_bs_snapshot,
      order_row.notes,
      order_row.created_at,
      order_row.sent_to_kitchen_at,
      order_row.kitchen_started_at,
      order_row.ready_at,
      order_row.extra_fields,
      client.full_name as client_name,
      client.phone as client_phone,
      delivered_event.delivered_at
    from delivered_events delivered_event
    join public.orders order_row on order_row.id = delivered_event.order_id
    left join public.clients client on client.id = order_row.client_id
    where order_row.status::text = 'delivered'
      and (
        p_cursor_delivered_at is null
        or p_cursor_id is null
        or (delivered_event.delivered_at, order_row.id)
             < (p_cursor_delivered_at, p_cursor_id)
      )
    order by delivered_event.delivered_at desc, order_row.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by delivered_at desc, id desc
    limit v_limit
  ),
  shaped as (
    select
      page.delivered_at,
      page.id,
      jsonb_build_object(
        'id', page.id,
        'displayNumber', page.id::text,
        'orderNumber', page.order_number,
        'status', page.status::text,
        'fulfillment', page.fulfillment::text,
        'clientName', coalesce(nullif(trim(page.client_name), ''), 'Cliente'),
        'clientPhone', page.client_phone,
        'receiverName', nullif(trim(page.receiver_name), ''),
        'receiverPhone', page.receiver_phone,
        'scheduledDate', page.extra_fields #>> '{schedule,date}',
        'scheduledTime',
          case
            when coalesce((page.extra_fields #>> '{schedule,asap}')::boolean, false)
              then 'Lo antes posible'
            else coalesce(
              page.extra_fields #>> '{schedule,time_12}',
              page.extra_fields #>> '{schedule,time_24}'
            )
          end,
        'sentToKitchenAt', page.sent_to_kitchen_at,
        'kitchenStartedAt', page.kitchen_started_at,
        'readyAt', page.ready_at,
        'deliveredAt', page.delivered_at,
        'totalUsd',
          round(coalesce(
            nullif(page.extra_fields #>> '{pricing,total_usd}', '')::numeric,
            page.total_usd,
            0
          ), 2),
        'totalBs',
          round(coalesce(
            nullif(page.extra_fields #>> '{pricing,total_bs}', '')::numeric,
            page.total_bs_snapshot,
            0
          ), 2),
        'confirmedPaidUsd', round(coalesce(financial.confirmed_paid_usd, 0), 2),
        'balanceUsd',
          round(coalesce(
            financial.pending_usd,
            greatest(coalesce(page.total_usd, 0), 0)
          ), 2),
        'paymentStatus', coalesce(financial.payment_status, 'unpaid'),
        'pendingReportsCount', coalesce(financial.pending_reports_count, 0),
        'itemCount', coalesce(item_summary.item_count, 0),
        'productSummary', coalesce(item_summary.product_summary, '[]'::jsonb),
        'note', page.notes,
        'createdAt', page.created_at
      ) as payload
    from page
    left join lateral public.get_order_financial_state(
      page.id,
      null,
      v_active_rate
    ) financial on true
    left join lateral (
      select
        count(*)::integer as item_count,
        coalesce(
          jsonb_agg(
            concat(
              'x',
              trim(to_char(item.qty, 'FM999999990.##')),
              ' ',
              coalesce(nullif(trim(item.product_name_snapshot), ''), 'Producto')
            )
            order by item.id
          ) filter (where item.position <= 3),
          '[]'::jsonb
        ) as product_summary
      from (
        select
          order_item.id,
          order_item.qty,
          order_item.product_name_snapshot,
          row_number() over (order by order_item.id) as position
        from public.order_items order_item
        where order_item.order_id = page.id
      ) item
    ) item_summary on true
  )
  select jsonb_build_object(
    'serviceDate', v_service_date::text,
    'results',
      coalesce((
        select jsonb_agg(shaped.payload order by shaped.delivered_at desc, shaped.id desc)
        from shaped
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object(
            'deliveredAt', page.delivered_at,
            'id', page.id
          )
          from page
          order by page.delivered_at asc, page.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_list_today_delivered_orders(timestamptz, bigint, integer)
  from public, anon;
grant execute on function public.counter_list_today_delivered_orders(timestamptz, bigint, integer)
  to authenticated, service_role;

comment on function public.counter_list_today_delivered_orders(timestamptz, bigint, integer)
  is 'Returns only orders delivered during the current America/Caracas service day for Counter, loaded on demand with keyset pagination.';
