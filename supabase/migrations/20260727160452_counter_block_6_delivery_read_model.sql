
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.counter_read_delivery_settlement_detail(
  p_settlement_id bigint default null,
  p_order_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_settlement record;
  v_active_rate numeric(18,6);
  v_state record;
  v_payload jsonb;
begin
  if v_uid is null
     or not (
       public.has_role('counter')
       or public.is_master_or_admin()
     ) then
    raise exception 'counter_access_denied' using errcode = '42501';
  end if;

  if (
    (p_settlement_id is null or p_settlement_id <= 0)
    and
    (p_order_id is null or p_order_id <= 0)
  ) then
    raise exception 'A settlement_id or order_id is required';
  end if;

  select
    settlement.*,
    order_row.order_number,
    order_row.status::text as order_status,
    order_row.eta_minutes,
    order_row.attributed_advisor_id,
    client.full_name as client_name,
    client.phone as client_phone,
    advisor.full_name as advisor_name
  into v_settlement
  from public.delivery_settlements settlement
  join public.orders order_row
    on order_row.id = settlement.order_id
  left join public.clients client
    on client.id = order_row.client_id
  left join public.profiles advisor
    on advisor.id = order_row.attributed_advisor_id
  where (
    p_settlement_id is not null
    and p_settlement_id > 0
    and settlement.id = p_settlement_id
  ) or (
    (p_settlement_id is null or p_settlement_id <= 0)
    and p_order_id is not null
    and p_order_id > 0
    and settlement.order_id = p_order_id
  )
  order by settlement.id desc
  limit 1;

  if not found then
    raise exception 'Delivery settlement not found';
  end if;

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  select *
  into v_state
  from public.get_order_financial_state(
    v_settlement.order_id,
    null,
    v_active_rate
  );

  select jsonb_build_object(
    'id', v_settlement.id,
    'orderId', v_settlement.order_id,
    'displayNumber', lpad(v_settlement.order_id::text, 2, '0'),
    'orderNumber', v_settlement.order_number,
    'orderStatus', v_settlement.order_status,
    'status', v_settlement.status,
    'clientName',
      coalesce(nullif(btrim(v_settlement.client_name), ''), 'Cliente'),
    'clientPhone', v_settlement.client_phone,
    'advisorName',
      nullif(btrim(coalesce(v_settlement.advisor_name, '')), ''),
    'responsibleName', v_settlement.responsible_name,
    'responsiblePhone', v_settlement.responsible_phone,
    'deliveryMode', v_settlement.delivery_mode::text,
    'etaMinutes', v_settlement.eta_minutes,
    'dispatchedAt', v_settlement.dispatched_at,
    'collectionFinalizedAt', v_settlement.collection_finalized_at,
    'settledAt', v_settlement.settled_at,
    'notes', v_settlement.notes,
    'version', v_settlement.version,
    'paymentStatus', coalesce(v_state.payment_status, 'unpaid'),
    'orderPendingUsd', round(coalesce(v_state.pending_usd, 0)::numeric, 2),
    'currencyBreakdown',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'currencyCode', totals.currency_code,
            'expectedCollection', totals.expected_collection,
            'customerCollection', totals.customer_collection,
            'cashReturned', totals.cash_returned,
            'custodyOutstanding',
              greatest(
                round(totals.customer_collection - totals.cash_returned, 2),
                0
              ),
            'cashChangeSent', totals.cash_change_sent,
            'cashChangeReturned', totals.cash_change_returned,
            'digitalChangeDue', totals.digital_change_due,
            'digitalChangeCompleted', totals.digital_change_completed,
            'digitalChangeOutstanding',
              greatest(
                round(
                  totals.digital_change_due
                    - totals.digital_change_completed,
                  2
                ),
                0
              )
          )
          order by totals.currency_code
        )
        from (
          select
            entry.currency_code::text as currency_code,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'expected_collection'
            ), 0)::numeric, 2) as expected_collection,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'customer_collection'
            ), 0)::numeric, 2) as customer_collection,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'cash_return'
            ), 0)::numeric, 2) as cash_returned,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'cash_change_out'
            ), 0)::numeric, 2) as cash_change_sent,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'cash_change_returned'
            ), 0)::numeric, 2) as cash_change_returned,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'digital_change_due'
            ), 0)::numeric, 2) as digital_change_due,
            round(coalesce(sum(entry.amount) filter (
              where entry.entry_type = 'digital_change_completed'
            ), 0)::numeric, 2) as digital_change_completed
          from public.delivery_settlement_entries entry
          where entry.settlement_id = v_settlement.id
          group by entry.currency_code
        ) totals
      ), '[]'::jsonb),
    'entries',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', recent.id,
            'entryType', recent.entry_type,
            'sourceLineKey', recent.source_line_key,
            'currencyCode', recent.currency_code,
            'amount', recent.amount,
            'amountUsdEquivalent', recent.amount_usd_equivalent,
            'moneyAccountId', recent.money_account_id,
            'moneyAccountName', recent.money_account_name,
            'operationDate', recent.operation_date,
            'referenceCode', recent.reference_code,
            'notes', recent.notes,
            'createdByName', recent.created_by_name,
            'createdAt', recent.created_at
          )
          order by recent.created_at desc, recent.id desc
        )
        from (
          select
            entry.id,
            entry.entry_type,
            entry.source_line_key,
            entry.currency_code::text as currency_code,
            entry.amount,
            entry.amount_usd_equivalent,
            entry.money_account_id,
            account.name as money_account_name,
            entry.operation_date,
            entry.reference_code,
            entry.notes,
            coalesce(
              nullif(btrim(creator.full_name), ''),
              'Usuario'
            ) as created_by_name,
            entry.created_at
          from public.delivery_settlement_entries entry
          left join public.money_accounts account
            on account.id = entry.money_account_id
          left join public.profiles creator
            on creator.id = entry.created_by_user_id
          where entry.settlement_id = v_settlement.id
          order by entry.created_at desc, entry.id desc
          limit 100
        ) recent
      ), '[]'::jsonb)
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_delivery_settlement_detail(
  bigint,
  bigint
) from public, anon;

grant execute on function public.counter_read_delivery_settlement_detail(
  bigint,
  bigint
) to authenticated, service_role;

revoke select on table public.delivery_settlements
  from authenticated;
revoke select on table public.delivery_settlement_entries
  from authenticated;

commit;
