
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke all on function public.counter_complete_delivery_digital_change(
  uuid,
  bigint,
  jsonb,
  text
) from public, anon, authenticated;

grant execute on function public.counter_complete_delivery_digital_change(
  uuid,
  bigint,
  jsonb,
  text
) to service_role;

create function public.counter_complete_delivery_change_obligation(
  p_idempotency_key uuid,
  p_obligation_id bigint,
  p_money_account_id bigint,
  p_operation_date date,
  p_reference_code text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_obligation public.order_change_obligations%rowtype;
  v_order record;
  v_settlement public.delivery_settlements%rowtype;
  v_account public.money_accounts%rowtype;
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_movement_id bigint;
  v_entry_id bigint;
  v_settlement_status text;
  v_event_id bigint;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if p_obligation_id is null or p_obligation_id <= 0 then
    raise exception 'A valid obligation_id is required';
  end if;

  if p_money_account_id is null or p_money_account_id <= 0 then
    raise exception 'A valid money_account_id is required';
  end if;

  if p_operation_date is null then
    raise exception 'operation_date is required';
  end if;

  select obligation.*
  into v_obligation
  from public.order_change_obligations obligation
  where obligation.id = p_obligation_id
  for update;

  if not found then
    raise exception 'Digital change obligation not found';
  end if;

  if v_obligation.delivery_settlement_id is null
     or v_obligation.delivery_settlement_entry_id is null then
    raise exception 'Obligation is not linked to a delivery settlement';
  end if;

  select
    order_row.id,
    order_row.order_number,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = v_obligation.order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if not (
    public.has_role('admin')
    or (
      v_obligation.responsible_role = 'advisor'
      and v_obligation.responsible_user_id = v_uid
      and public.has_role('advisor')
    )
    or (
      v_obligation.responsible_role = 'master'
      and public.is_master_or_admin()
    )
  ) then
    raise exception
      'Only the responsible advisor or Master/Admin can execute this digital change';
  end if;

  v_request_payload := jsonb_build_object(
    'obligation_id', p_obligation_id,
    'money_account_id', p_money_account_id,
    'operation_date', p_operation_date,
    'reference_code', p_reference_code,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'complete_delivery_digital_change',
    v_obligation.order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  if v_obligation.status <> 'pending' then
    raise exception 'Digital change obligation is no longer pending';
  end if;

  select settlement.*
  into v_settlement
  from public.delivery_settlements settlement
  where settlement.id = v_obligation.delivery_settlement_id
    and settlement.order_id = v_obligation.order_id
  for update;

  if not found or v_settlement.status = 'voided' then
    raise exception 'Active delivery settlement not found';
  end if;

  select account.*
  into v_account
  from public.money_accounts account
  where account.id = p_money_account_id
  for update;

  if not found
     or not v_account.is_active
     or v_account.currency_code <> v_obligation.currency_code
     or v_account.account_kind not in ('bank', 'wallet') then
    raise exception
      'Digital change account must be an active bank or wallet in the obligation currency';
  end if;

  insert into public.money_movements (
    movement_date,
    created_by_user_id,
    confirmed_at,
    confirmed_by_user_id,
    status,
    approval_required,
    approval_required_reason,
    direction,
    movement_type,
    money_account_id,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    reference_code,
    counterparty_name,
    description,
    notes,
    order_id,
    payment_report_id,
    movement_group_id
  ) values (
    p_operation_date,
    v_uid,
    v_now,
    v_uid,
    'confirmed',
    false,
    null,
    'outflow',
    'change_given',
    p_money_account_id,
    v_obligation.currency_code,
    v_obligation.amount,
    v_obligation.exchange_rate_ves_per_usd,
    v_obligation.amount_usd_equivalent,
    nullif(btrim(coalesce(p_reference_code, '')), ''),
    null,
    format('Cambio digital delivery orden %s', v_order.order_number),
    coalesce(
      nullif(btrim(coalesce(p_notes, '')), ''),
      v_obligation.notes
    ),
    v_obligation.order_id,
    null,
    p_idempotency_key
  )
  returning id into v_movement_id;

  insert into public.delivery_settlement_entries (
    settlement_id,
    entry_type,
    source_line_key,
    currency_code,
    amount,
    exchange_rate_ves_per_usd,
    amount_usd_equivalent,
    money_account_id,
    money_movement_id,
    operation_date,
    reference_code,
    notes,
    created_by_user_id
  ) values (
    v_settlement.id,
    'digital_change_completed',
    v_obligation.line_key,
    v_obligation.currency_code,
    v_obligation.amount,
    v_obligation.exchange_rate_ves_per_usd,
    v_obligation.amount_usd_equivalent,
    p_money_account_id,
    v_movement_id,
    p_operation_date,
    nullif(btrim(coalesce(p_reference_code, '')), ''),
    coalesce(
      nullif(btrim(coalesce(p_notes, '')), ''),
      v_obligation.notes
    ),
    v_uid
  )
  returning id into v_entry_id;

  update public.order_change_obligations
  set
    status = 'completed',
    completed_at = v_now,
    completed_by_user_id = v_uid,
    completed_movement_id = v_movement_id
  where id = v_obligation.id;

  v_settlement_status :=
    public.counter_refresh_delivery_settlement_status(
      v_settlement.id,
      v_uid
    );

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    v_obligation.order_id,
    'delivery_digital_change_completed',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement.id,
      'change_obligation_id', v_obligation.id,
      'settlement_entry_id', v_entry_id,
      'movement_id', v_movement_id,
      'settlement_status', v_settlement_status,
      'idempotency_key', p_idempotency_key
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
    v_obligation.order_id,
    v_order.order_number,
    'delivery_digital_change_completed',
    'delivery',
    'Cambio digital completado',
    format(
      'Se confirmo el cambio digital por %s %s.',
      v_obligation.amount,
      v_obligation.currency_code
    ),
    'info',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement.id,
      'change_obligation_id', v_obligation.id,
      'movement_id', v_movement_id,
      'settlement_status', v_settlement_status
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
    'order_id', v_obligation.order_id,
    'delivery_settlement_id', v_settlement.id,
    'change_obligation_id', v_obligation.id,
    'movement_id', v_movement_id,
    'settlement_entry_id', v_entry_id,
    'settlement_status', v_settlement_status
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_complete_delivery_change_obligation(
  uuid,
  bigint,
  bigint,
  date,
  text,
  text
) from public, anon;

grant execute on function public.counter_complete_delivery_change_obligation(
  uuid,
  bigint,
  bigint,
  date,
  text,
  text
) to authenticated, service_role;

commit;
