-- Repair the one legacy combined payment/change pair that was fully voided
-- before the sequential Counter flow recorded a later independent payment.
-- The pair remains in the ledger for audit, but its reason codes no longer make
-- it look like an active stored overpayment.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $repair$
declare
  v_legacy_pair record;
  v_legacy_pair_count integer;
  v_receipt record;
  v_receipt_count integer;
begin
  select count(*)
  into v_legacy_pair_count
  from (
    select credit.id
    from public.client_fund_movements credit
    join public.client_fund_movements debit
      on debit.order_id = credit.order_id
     and debit.created_at = credit.created_at
     and debit.movement_type = 'debit'
     and debit.reason_code = 'counter_change_fund_reversal'
     and debit.amount_usd = credit.amount_usd
    join public.counter_command_receipts receipt
      on receipt.order_id = credit.order_id
     and receipt.command_type = 'apply_order_payments'
     and receipt.created_at = credit.created_at
    where credit.movement_type = 'credit'
      and credit.reason_code = 'payment_overage_stored'
      and exists (
        select 1
        from public.money_movements movement
        where movement.order_id = receipt.order_id
          and movement.movement_group_id = receipt.idempotency_key
      )
      and not exists (
        select 1
        from public.money_movements movement
        where movement.order_id = receipt.order_id
          and movement.movement_group_id = receipt.idempotency_key
          and movement.status <> 'voided'
      )
  ) candidate;

  if v_legacy_pair_count = 0 then
    return;
  end if;

  if v_legacy_pair_count > 1 then
    raise exception
      'Expected at most one fully voided legacy Counter fund pair, found %',
      v_legacy_pair_count;
  end if;

  select
    credit.id as credit_id,
    debit.id as debit_id,
    credit.order_id,
    credit.amount_usd,
    receipt.idempotency_key
  into strict v_legacy_pair
  from public.client_fund_movements credit
  join public.client_fund_movements debit
    on debit.order_id = credit.order_id
   and debit.created_at = credit.created_at
   and debit.movement_type = 'debit'
   and debit.reason_code = 'counter_change_fund_reversal'
   and debit.amount_usd = credit.amount_usd
  join public.counter_command_receipts receipt
    on receipt.order_id = credit.order_id
   and receipt.command_type = 'apply_order_payments'
   and receipt.created_at = credit.created_at
  where credit.movement_type = 'credit'
    and credit.reason_code = 'payment_overage_stored'
    and exists (
      select 1
      from public.money_movements movement
      where movement.order_id = receipt.order_id
        and movement.movement_group_id = receipt.idempotency_key
    )
    and not exists (
      select 1
      from public.money_movements movement
      where movement.order_id = receipt.order_id
        and movement.movement_group_id = receipt.idempotency_key
        and movement.status <> 'voided'
    );

  update public.client_fund_movements
  set
    reason_code = 'voided_counter_overage_stored',
    notes = concat_ws(
      E'\n',
      nullif(notes, ''),
      'Clasificado como legado anulado al habilitar el flujo secuencial de Counter.'
    )
  where id = v_legacy_pair.credit_id;

  update public.client_fund_movements
  set
    reason_code = 'voided_counter_change_fund_reversal',
    notes = concat_ws(
      E'\n',
      nullif(notes, ''),
      'Clasificado como legado anulado al habilitar el flujo secuencial de Counter.'
    )
  where id = v_legacy_pair.debit_id;

  select count(*)
  into v_receipt_count
  from public.counter_command_receipts receipt
  cross join lateral public.get_order_financial_state(receipt.order_id) financial
  where receipt.command_type = 'apply_order_payments'
    and receipt.status = 'completed'
    and receipt.created_at >= timestamptz '2026-08-26 18:56:26+00'
    and receipt.order_id = v_legacy_pair.order_id
    and financial.overpaid_usd > 0.005
    and coalesce((receipt.result_payload ->> 'fund_credit_usd')::numeric, 0) <= 0.005
    and exists (
      select 1
      from public.money_movements payment
      where payment.order_id = receipt.order_id
        and payment.movement_group_id = receipt.idempotency_key
        and payment.status = 'confirmed'
        and payment.direction = 'inflow'
        and payment.movement_type = 'order_payment'
    )
    and not exists (
      select 1
      from public.client_fund_movements fund
      where fund.order_id = receipt.order_id
        and fund.movement_type = 'credit'
        and fund.reason_code in ('payment_overage_stored', 'retention_overage_stored')
        and (
          fund.movement_group_id = receipt.idempotency_key
          or fund.created_at = receipt.created_at
        )
    );

  if v_receipt_count <> 1 then
    raise exception
      'Expected exactly one active sequential Counter overpayment to repair, found %',
      v_receipt_count;
  end if;

  select
    receipt.id as receipt_id,
    receipt.order_id,
    receipt.idempotency_key,
    receipt.actor_user_id,
    order_row.client_id,
    round(financial.overpaid_usd, 2) as amount_usd
  into strict v_receipt
  from public.counter_command_receipts receipt
  join public.orders order_row
    on order_row.id = receipt.order_id
  cross join lateral public.get_order_financial_state(receipt.order_id) financial
  where receipt.command_type = 'apply_order_payments'
    and receipt.status = 'completed'
    and receipt.created_at >= timestamptz '2026-08-26 18:56:26+00'
    and receipt.order_id = v_legacy_pair.order_id
    and order_row.client_id is not null
    and financial.overpaid_usd > 0.005
    and coalesce((receipt.result_payload ->> 'fund_credit_usd')::numeric, 0) <= 0.005
    and exists (
      select 1
      from public.money_movements payment
      where payment.order_id = receipt.order_id
        and payment.movement_group_id = receipt.idempotency_key
        and payment.status = 'confirmed'
        and payment.direction = 'inflow'
        and payment.movement_type = 'order_payment'
    )
    and not exists (
      select 1
      from public.client_fund_movements fund
      where fund.order_id = receipt.order_id
        and fund.movement_type = 'credit'
        and fund.reason_code in ('payment_overage_stored', 'retention_overage_stored')
        and (
          fund.movement_group_id = receipt.idempotency_key
          or fund.created_at = receipt.created_at
        )
    );

  perform 1
  from public.orders order_row
  where order_row.id = v_receipt.order_id
  for update;

  perform 1
  from public.clients client
  where client.id = v_receipt.client_id
  for update;

  update public.clients
  set
    fund_balance_usd = round(coalesce(fund_balance_usd, 0) + v_receipt.amount_usd, 2),
    updated_at = now()
  where id = v_receipt.client_id;

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
    created_by_user_id,
    movement_group_id
  ) values (
    v_receipt.client_id,
    'credit',
    'USD',
    v_receipt.amount_usd,
    v_receipt.amount_usd,
    null,
    v_receipt.order_id,
    null,
    'payment_overage_stored',
    'Excedente restaurado para continuar el cambio secuencial de Counter.',
    v_receipt.actor_user_id,
    v_receipt.idempotency_key
  );

  update public.counter_command_receipts receipt
  set result_payload = jsonb_set(
    receipt.result_payload,
    '{fund_credit_usd}',
    to_jsonb(v_receipt.amount_usd),
    true
  )
  where receipt.id = v_receipt.receipt_id;

  update public.order_events event_row
  set meta = jsonb_set(
    event_row.meta,
    '{fund_credit_usd}',
    to_jsonb(v_receipt.amount_usd),
    true
  )
  where event_row.order_id = v_receipt.order_id
    and event_row.event = 'counter_payment_operation'
    and event_row.meta ->> 'idempotency_key' = v_receipt.idempotency_key::text;

  update public.order_timeline_events timeline
  set payload = jsonb_set(
    timeline.payload,
    '{fund_credit_usd}',
    to_jsonb(v_receipt.amount_usd),
    true
  )
  where timeline.order_id = v_receipt.order_id
    and timeline.event_type = 'counter_payment_operation'
    and timeline.payload ->> 'idempotency_key' = v_receipt.idempotency_key::text;
end;
$repair$;

commit;
