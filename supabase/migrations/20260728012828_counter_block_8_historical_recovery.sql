-- Counter Block 8: bounded historical search and on-demand operational detail.
-- No tables are created. Existing Counter reads and payment commands are reused.

begin;

create or replace function public.counter_phone_digits(p_phone text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $function$
  select regexp_replace(p_phone, '[^0-9]', '', 'g');
$function$;

revoke all on function public.counter_phone_digits(text)
  from public, anon, authenticated;
grant execute on function public.counter_phone_digits(text)
  to service_role;

create index if not exists clients_counter_phone_digits_trgm_idx
  on public.clients
  using gin (public.counter_phone_digits(phone) gin_trgm_ops)
  where phone is not null
    and trim(phone) <> '';

create index if not exists orders_receiver_name_search_norm_trgm_idx
  on public.orders
  using gin (public.search_normalize(receiver_name) gin_trgm_ops)
  where receiver_name is not null
    and trim(receiver_name) <> '';

create index if not exists orders_receiver_phone_digits_trgm_idx
  on public.orders
  using gin (public.counter_phone_digits(receiver_phone) gin_trgm_ops)
  where receiver_phone is not null
    and trim(receiver_phone) <> '';

create or replace function public.counter_search_orders(
  p_query text,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_normalized_query text := public.search_normalize(trim(coalesce(p_query, '')));
  v_digits text := regexp_replace(trim(coalesce(p_query, '')), '[^0-9]', '', 'g');
  v_exact_order_id bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
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

  if length(v_query) < 2 then
    return jsonb_build_object('results', '[]'::jsonb, 'nextCursor', null);
  end if;

  v_exact_order_id := case
    when v_query ~ '^[0-9]{1,18}$' then v_query::bigint
    else null
  end;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  with candidate_order_ids as materialized (
    select order_row.id
    from public.orders order_row
    where v_exact_order_id is not null
      and order_row.id = v_exact_order_id

    union

    select order_row.id
    from public.orders order_row
    where length(v_query) >= 3
      and order_row.order_number ilike '%' || v_query || '%'

    union

    select order_row.id
    from public.clients client
    join public.orders order_row on order_row.client_id = client.id
    where public.search_normalize(client.full_name)
            like '%' || v_normalized_query || '%'
       or (
         length(v_digits) >= 3
         and public.counter_phone_digits(client.phone)
               like '%' || v_digits || '%'
       )

    union

    select order_row.id
    from public.orders order_row
    where public.search_normalize(order_row.receiver_name)
            like '%' || v_normalized_query || '%'
       or (
         length(v_digits) >= 3
         and public.counter_phone_digits(order_row.receiver_phone)
               like '%' || v_digits || '%'
       )
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
      client.phone as client_phone
    from candidate_order_ids candidate
    join public.orders order_row on order_row.id = candidate.id
    left join public.clients client on client.id = order_row.client_id
    where (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (order_row.created_at, order_row.id) < (p_cursor_created_at, p_cursor_id)
    )
    order by order_row.created_at desc, order_row.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from matched
    order by created_at desc, id desc
    limit v_limit
  ),
  shaped as (
    select
      page.created_at,
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
        'deliveredAt',
          coalesce(
            nullif(page.extra_fields #>> '{pickup,collected_at}', ''),
            nullif(page.extra_fields #>> '{delivery,completed_at}', ''),
            delivered_event.delivered_at
          ),
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
    left join lateral (
      select max(event_row.created_at)::text as delivered_at
      from public.order_events event_row
      where event_row.order_id = page.id
        and event_row.event = 'delivered'
    ) delivered_event on true
  )
  select jsonb_build_object(
    'results',
      coalesce((
        select jsonb_agg(shaped.payload order by shaped.created_at desc, shaped.id desc)
        from shaped
      ), '[]'::jsonb),
    'nextCursor',
      case
        when (select count(*) from matched) > v_limit then (
          select jsonb_build_object('createdAt', page.created_at, 'id', page.id)
          from page
          order by page.created_at asc, page.id asc
          limit 1
        )
        else null
      end
  )
  into v_payload;

  return v_payload;
end;
$function$;

create or replace function public.counter_read_order_detail(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
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

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'counter_order_invalid';
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select jsonb_build_object(
    'id', order_row.id,
    'order_number', order_row.order_number,
    'status', order_row.status::text,
    'source', order_row.source::text,
    'fulfillment', order_row.fulfillment::text,
    'delivery_address', order_row.delivery_address,
    'delivery_mode', order_row.delivery_mode::text,
    'external_driver_name', order_row.external_driver_name,
    'external_reference', order_row.external_reference,
    'receiver_name', order_row.receiver_name,
    'receiver_phone', order_row.receiver_phone,
    'total_usd', order_row.total_usd,
    'total_bs_snapshot', order_row.total_bs_snapshot,
    'notes', order_row.notes,
    'created_at', order_row.created_at,
    'sent_to_kitchen_at', order_row.sent_to_kitchen_at,
    'kitchen_started_at', order_row.kitchen_started_at,
    'ready_at', order_row.ready_at,
    'delivered_at',
      coalesce(
        nullif(order_row.extra_fields #>> '{pickup,collected_at}', ''),
        nullif(order_row.extra_fields #>> '{delivery,completed_at}', ''),
        delivered_event.delivered_at
      ),
    'extra_fields', coalesce(order_row.extra_fields, '{}'::jsonb),
    'client_name', coalesce(nullif(trim(client.full_name), ''), 'Cliente'),
    'client_phone', client.phone,
    'advisor_name', nullif(trim(advisor.full_name), ''),
    'has_advisor', order_row.attributed_advisor_id is not null,
    'delivery_assignee_kind',
      case
        when order_row.internal_driver_user_id is not null then 'internal'
        when order_row.external_partner_id is not null
          or nullif(trim(order_row.external_driver_name), '') is not null then 'external'
        else null
      end,
    'delivery_assignee_name',
      coalesce(
        nullif(trim(driver.full_name), ''),
        nullif(trim(partner.name), ''),
        nullif(trim(order_row.external_driver_name), '')
      ),
    'confirmed_paid_usd', coalesce(financial.confirmed_paid_usd, 0),
    'pending_usd', coalesce(financial.pending_usd, greatest(coalesce(order_row.total_usd, 0), 0)),
    'payment_status', coalesce(financial.payment_status, 'unpaid'),
    'pending_reports_usd', coalesce(financial.pending_reports_usd, 0),
    'overpaid_usd', coalesce(financial.overpaid_usd, 0),
    'pending_digital_change_usd',
      coalesce((
        select round(sum(obligation.amount_usd_equivalent), 2)
        from public.order_change_obligations obligation
        where obligation.order_id = order_row.id
          and obligation.status = 'pending'
      ), 0),
    'pending_reports_count', coalesce(financial.pending_reports_count, 0),
    'confirmed_reports_count', coalesce(financial.confirmed_reports_count, 0),
    'rejected_reports_count', coalesce(financial.rejected_reports_count, 0),
    'refund_authorizations',
      coalesce((
        select jsonb_agg(authorizations.payload order by authorizations.created_at desc)
        from (
          select
            min(movement.created_at) as created_at,
            jsonb_build_object(
              'movementGroupId', movement.movement_group_id,
              'status',
                case
                  when bool_and(movement.status = 'confirmed') then 'executed'
                  when bool_and(movement.status = 'rejected') then 'rejected'
                  when bool_and(
                    movement.status = 'pending'
                    and not movement.approval_required
                    and movement.reviewed_at is not null
                  ) then 'approved'
                  else 'pending'
                end,
              'amountUsdEquivalent', round(sum(movement.amount_usd_equivalent), 2),
              'createdAt', min(movement.created_at),
              'reviewedAt', max(movement.reviewed_at),
              'lines',
                jsonb_agg(
                  jsonb_build_object(
                    'movementId', movement.id,
                    'moneyAccountId', movement.money_account_id,
                    'accountName', account.name,
                    'currencyCode', movement.currency_code::text,
                    'amount', movement.amount,
                    'amountUsdEquivalent', movement.amount_usd_equivalent
                  )
                  order by movement.id
                )
            ) as payload
          from public.money_movements movement
          join public.counter_command_receipts receipt
            on receipt.command_type = 'request_refund'
           and receipt.order_id = order_row.id
           and receipt.idempotency_key = movement.movement_group_id
          join public.money_accounts account on account.id = movement.money_account_id
          where movement.order_id = order_row.id
          group by movement.movement_group_id
          order by min(movement.created_at) desc
          limit 20
        ) authorizations
      ), '[]'::jsonb),
    'items',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', item.id,
            'qty', item.qty,
            'name', coalesce(nullif(trim(item.product_name_snapshot), ''), 'Producto'),
            'lineTotalUsd', coalesce(item.line_total_usd, 0),
            'lineTotalBs', coalesce(item.line_total_bs_snapshot, 0),
            'notes', item.notes
          )
          order by item.id
        )
        from public.order_items item
        where item.order_id = order_row.id
      ), '[]'::jsonb)
  )
  into v_payload
  from public.orders order_row
  left join public.clients client on client.id = order_row.client_id
  left join public.profiles advisor on advisor.id = order_row.attributed_advisor_id
  left join public.profiles driver on driver.id = order_row.internal_driver_user_id
  left join public.delivery_partners partner on partner.id = order_row.external_partner_id
  left join lateral public.get_order_financial_state(
    order_row.id,
    null,
    v_active_rate
  ) financial on true
  left join lateral (
    select max(event_row.created_at)::text as delivered_at
    from public.order_events event_row
    where event_row.order_id = order_row.id
      and event_row.event = 'delivered'
  ) delivered_event on true
  where order_row.id = p_order_id;

  if v_payload is null then
    raise exception 'counter_order_not_found';
  end if;

  return v_payload;
end;
$function$;

revoke all on function public.counter_search_orders(text, timestamptz, bigint, integer)
  from public, anon;
grant execute on function public.counter_search_orders(text, timestamptz, bigint, integer)
  to authenticated, service_role;

revoke all on function public.counter_read_order_detail(bigint)
  from public, anon;
grant execute on function public.counter_read_order_detail(bigint)
  to authenticated, service_role;

commit;
