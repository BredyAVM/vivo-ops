-- A customer may voluntarily waive a small remainder instead of receiving
-- more change or keeping it in their fund. The cash inflow already exists;
-- this command only releases the corresponding customer-fund liability and
-- leaves an idempotent audit trail.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.counter_command_receipts
  drop constraint counter_command_receipts_type_ck;

alter table public.counter_command_receipts
  add constraint counter_command_receipts_type_ck
  check (command_type in (
    'apply_order_payments',
    'record_manual_movement',
    'request_refund',
    'decide_authorization',
    'execute_refund',
    'dispatch_delivery',
    'record_delivery_return',
    'complete_delivery_digital_change',
    'close_money_account',
    'update_pickup_schedule',
    'change_pickup_items',
    'decide_pickup_change',
    'complete_pickup',
    'create_direct_sale',
    'give_order_change',
    'waive_order_change'
  ));

create or replace function public.counter_order_change_balance_internal(
  p_order_id bigint
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $function$
  with order_client as (
    select
      order_row.id as order_id,
      order_row.client_id,
      greatest(0, coalesce(client.fund_balance_usd, 0))::numeric as client_balance_usd
    from public.orders order_row
    join public.clients client
      on client.id = order_row.client_id
    where order_row.id = p_order_id
  ),
  order_fund as (
    select
      fund.order_id,
      round(coalesce(sum(
        case
          when fund.movement_type = 'credit'
            and fund.reason_code in ('payment_overage_stored', 'retention_overage_stored')
            then fund.amount_usd
          when fund.movement_type = 'debit'
            and fund.reason_code in (
              'counter_change_fund_reversal',
              'client_fund_payout',
              'payment_void_fund_reversal',
              'counter_change_waived'
            )
            then -fund.amount_usd
          when fund.movement_type = 'debit'
            and fund.reason_code = 'counter_change_given'
            and exists (
              select 1
              from public.counter_command_receipts receipt
              join public.money_movements movement
                on movement.order_id = receipt.order_id
               and movement.movement_group_id = receipt.idempotency_key
               and movement.status = 'confirmed'
               and movement.direction = 'outflow'
               and movement.movement_type = 'change_given'
              where receipt.command_type = 'give_order_change'
                and receipt.status = 'completed'
                and receipt.order_id = fund.order_id
                and receipt.idempotency_key = fund.movement_group_id
            )
            then -fund.amount_usd
          else 0
        end
      ), 0), 2) as available_from_order_usd
    from public.client_fund_movements fund
    where fund.order_id = p_order_id
    group by fund.order_id
  )
  select round(greatest(
    0,
    least(
      order_client.client_balance_usd,
      greatest(0, coalesce(order_fund.available_from_order_usd, 0))
    )
  ), 2)
  from order_client
  left join order_fund
    on order_fund.order_id = order_client.order_id;
$function$;

revoke all on function public.counter_order_change_balance_internal(bigint)
  from public, anon, authenticated;
grant execute on function public.counter_order_change_balance_internal(bigint)
  to service_role;

create function public.counter_waive_order_change(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_expected_amount_usd numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_order record;
  v_client_balance numeric(12,2);
  v_available numeric(12,2);
  v_expected numeric(12,2);
  v_request_payload jsonb;
  v_claim record;
  v_receipt_id bigint;
  v_fund_movement_id bigint;
  v_adjustment_id bigint;
  v_event_id bigint;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can waive order change'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  v_expected := round(coalesce(p_expected_amount_usd, 0), 2);
  if v_expected <= 0 then
    raise exception 'Expected waived amount must be greater than zero';
  end if;

  select
    order_row.id,
    order_row.order_number,
    order_row.client_id,
    order_row.status,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Cancelled orders cannot waive a change remainder';
  end if;

  if v_order.client_id is null then
    raise exception 'Order has no client for closing the change remainder';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'expected_amount_usd', v_expected,
    'notes', nullif(btrim(coalesce(p_notes, '')), '')
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'waive_order_change',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select coalesce(client.fund_balance_usd, 0)
  into v_client_balance
  from public.clients client
  where client.id = v_order.client_id
  for update;

  if not found then
    raise exception 'Order client not found';
  end if;

  v_available := coalesce(
    public.counter_order_change_balance_internal(p_order_id),
    0
  );

  if v_available <= 0.005 then
    raise exception 'This order has no change remainder to waive';
  end if;

  if abs(v_available - v_expected) > 0.005 then
    raise exception 'The change remainder changed; review the current amount';
  end if;

  if v_available > 1.005 then
    raise exception 'Counter can only waive change remainders up to 1.00 USD';
  end if;

  if v_available > v_client_balance + 0.005 then
    raise exception 'Client fund changed while closing the change remainder';
  end if;

  update public.clients
  set
    fund_balance_usd = round(fund_balance_usd - v_available, 2),
    updated_at = now()
  where id = v_order.client_id
    and fund_balance_usd + 0.005 >= v_available;

  if not found then
    raise exception 'Client fund changed while closing the change remainder';
  end if;

  insert into public.client_fund_movements (
    client_id,
    movement_type,
    currency_code,
    amount,
    amount_usd,
    money_account_id,
    order_id,
    payment_report_id,
    reason_code,
    notes,
    created_at,
    created_by_user_id,
    movement_group_id
  ) values (
    v_order.client_id,
    'debit',
    'USD',
    v_available,
    v_available,
    null,
    p_order_id,
    null,
    'counter_change_waived',
    coalesce(
      nullif(btrim(coalesce(p_notes, '')), ''),
      format('El cliente cedio el remanente de la orden %s.', v_order.order_number)
    ),
    v_now,
    v_uid,
    p_idempotency_key
  )
  returning id into v_fund_movement_id;

  insert into public.order_admin_adjustments (
    order_id,
    order_item_id,
    adjustment_type,
    reason,
    notes,
    payload,
    created_by_user_id
  ) values (
    p_order_id,
    null,
    'other',
    'Diferencia cedida por el cliente',
    nullif(btrim(coalesce(p_notes, '')), ''),
    jsonb_build_object(
      'kind', 'rounding_gain_close',
      'source', 'counter_change_waived',
      'closed_balance_usd', v_available,
      'client_fund_movement_id', v_fund_movement_id,
      'idempotency_key', p_idempotency_key
    ),
    v_uid
  )
  returning id into v_adjustment_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'counter_change_waived',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'amount_usd', v_available,
      'fund_movement_id', v_fund_movement_id,
      'adjustment_id', v_adjustment_id
    )
  );

  insert into public.order_timeline_events (
    order_id,
    order_number,
    event_type,
    event_group,
    title,
    message,
    severity,
    actor_user_id,
    payload
  ) values (
    p_order_id,
    v_order.order_number,
    'counter_change_waived',
    'payment',
    'Diferencia cedida',
    format(
      'El cliente decidio dejar %s USD y Counter cerro el remanente.',
      v_available
    ),
    'info',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'amount_usd', v_available,
      'fund_movement_id', v_fund_movement_id,
      'adjustment_id', v_adjustment_id
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  ) values (
    v_event_id,
    'master',
    null,
    false
  );

  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    ) values (
      v_event_id,
      null,
      v_order.attributed_advisor_id,
      false
    );
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'idempotency_key', p_idempotency_key,
    'order_id', p_order_id,
    'waived_amount_usd', v_available,
    'fund_movement_id', v_fund_movement_id,
    'adjustment_id', v_adjustment_id,
    'remaining_change_usd', 0
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

comment on function public.counter_waive_order_change(uuid, bigint, numeric, text)
is 'Counter closes a customer-waived change remainder up to USD 1 without a cash outflow or a permanent fund balance.';

revoke all on function public.counter_waive_order_change(uuid, bigint, numeric, text)
  from public, anon;
grant execute on function public.counter_waive_order_change(uuid, bigint, numeric, text)
  to authenticated, service_role;

commit;
