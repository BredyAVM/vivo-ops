-- Counter payment and change are one continuous cashier experience, but each
-- completed financial fact has its own idempotent command and movement group.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.client_fund_movements
  add column if not exists movement_group_id uuid;

create index if not exists client_fund_movements_group_idx
  on public.client_fund_movements(movement_group_id)
  where movement_group_id is not null;

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
    'give_order_change'
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
              'payment_void_fund_reversal'
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

create or replace function public.counter_read_order_change_balance(
  p_order_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_available numeric(12,2);
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Counter change balance is not available to this user'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.orders order_row
    where order_row.id = p_order_id
  ) then
    raise exception 'Order not found';
  end if;

  v_available := coalesce(
    public.counter_order_change_balance_internal(p_order_id),
    0
  );

  return jsonb_build_object(
    'orderId', p_order_id,
    'availableUsd', round(v_available, 2)
  );
end;
$function$;

revoke all on function public.counter_read_order_change_balance(bigint)
  from public, anon;
grant execute on function public.counter_read_order_change_balance(bigint)
  to authenticated, service_role;

create or replace function public.counter_give_order_change(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_money_account_id bigint,
  p_amount numeric,
  p_operation_date date,
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
  v_account public.money_accounts%rowtype;
  v_client_balance numeric(12,2);
  v_available numeric(12,2);
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_amount_usd numeric(12,2);
  v_request_payload jsonb;
  v_claim record;
  v_receipt_id bigint;
  v_movement_id bigint;
  v_event_id bigint;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Only Counter or Master/Admin can give order change'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'A valid order_id is required';
  end if;

  if p_money_account_id is null or p_money_account_id <= 0 then
    raise exception 'A valid money_account_id is required';
  end if;

  if p_operation_date is null then
    raise exception 'operation_date is required';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    raise exception 'Change amount must be greater than zero';
  end if;

  select
    order_row.id,
    order_row.order_number,
    order_row.client_id,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.client_id is null then
    raise exception 'Order has no client for storing and giving change';
  end if;

  select account.*
  into v_account
  from public.money_accounts account
  where account.id = p_money_account_id
  for update;

  if not found
     or not v_account.is_active
     or v_account.account_kind <> 'cash'
     or not public.is_counter_direct_money_account(p_money_account_id) then
    raise exception 'Change account is not an active direct Counter cash account';
  end if;

  if v_account.currency_code = 'VES' then
    select round(rate.rate_bs_per_usd, 6)
    into v_rate
    from public.exchange_rates rate
    where rate.is_active = true
      and rate.rate_bs_per_usd > 0
    order by rate.effective_at desc, rate.id desc
    limit 1;

    if coalesce(v_rate, 0) <= 0 then
      raise exception 'There is no active exchange rate';
    end if;
  else
    v_rate := null;
  end if;

  v_amount_usd := public.counter_amount_usd(
    v_account.currency_code,
    v_amount,
    v_rate
  );

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'money_account_id', p_money_account_id,
    'amount', v_amount,
    'operation_date', p_operation_date,
    'notes', nullif(btrim(coalesce(p_notes, '')), '')
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'give_order_change',
    p_order_id,
    p_money_account_id,
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

  if v_amount_usd > v_available + 0.005 then
    raise exception 'Change exceeds the amount still available from this order';
  end if;

  if v_amount_usd > v_client_balance + 0.005 then
    raise exception 'Client fund changed while the change operation was running';
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
    v_account.currency_code,
    v_amount,
    v_rate,
    v_amount_usd,
    null,
    null,
    format('Cambio Counter orden %s', v_order.order_number),
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_order_id,
    null,
    p_idempotency_key
  )
  returning id into v_movement_id;

  update public.clients
  set
    fund_balance_usd = round(fund_balance_usd - v_amount_usd, 2),
    updated_at = now()
  where id = v_order.client_id
    and fund_balance_usd + 0.005 >= v_amount_usd;

  if not found then
    raise exception 'Client fund changed while the change operation was running';
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
    v_account.currency_code::text,
    v_amount,
    v_amount_usd,
    p_money_account_id,
    p_order_id,
    null,
    'counter_change_given',
    coalesce(
      nullif(btrim(coalesce(p_notes, '')), ''),
      format('Cambio entregado por Counter en la orden %s.', v_order.order_number)
    ),
    v_now,
    v_uid,
    p_idempotency_key
  );

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'counter_change_given',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'movement_id', v_movement_id,
      'money_account_id', p_money_account_id,
      'currency_code', v_account.currency_code,
      'amount', v_amount,
      'amount_usd_equivalent', v_amount_usd
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
    'counter_change_given',
    'payment',
    'Cambio entregado',
    format(
      'Counter entrego %s %s desde %s.',
      v_amount,
      v_account.currency_code,
      v_account.name
    ),
    'info',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'movement_id', v_movement_id,
      'money_account_id', p_money_account_id,
      'currency_code', v_account.currency_code,
      'amount', v_amount,
      'amount_usd_equivalent', v_amount_usd
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

  v_available := greatest(0, round(v_available - v_amount_usd, 2));
  v_result := jsonb_build_object(
    'ok', true,
    'idempotency_key', p_idempotency_key,
    'order_id', p_order_id,
    'movement_id', v_movement_id,
    'money_account_id', p_money_account_id,
    'account_name', v_account.name,
    'currency_code', v_account.currency_code,
    'amount', v_amount,
    'exchange_rate_ves_per_usd', v_rate,
    'amount_usd_equivalent', v_amount_usd,
    'remaining_change_usd', v_available
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

revoke all on function public.counter_give_order_change(
  uuid,
  bigint,
  bigint,
  numeric,
  date,
  text
) from public, anon;
grant execute on function public.counter_give_order_change(
  uuid,
  bigint,
  bigint,
  numeric,
  date,
  text
) to authenticated, service_role;

create or replace function public.counter_restore_voided_change_fund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_fund public.client_fund_movements%rowtype;
  v_actor uuid;
begin
  if old.status <> 'confirmed'
     or new.status <> 'voided'
     or new.direction <> 'outflow'
     or new.movement_type <> 'change_given'
     or new.movement_group_id is null
     or not exists (
       select 1
       from public.counter_command_receipts receipt
       where receipt.command_type = 'give_order_change'
         and receipt.status = 'completed'
         and receipt.order_id = new.order_id
         and receipt.idempotency_key = new.movement_group_id
     ) then
    return new;
  end if;

  select fund.*
  into v_fund
  from public.client_fund_movements fund
  where fund.movement_type = 'debit'
    and fund.reason_code = 'counter_change_given'
    and fund.order_id = new.order_id
    and fund.movement_group_id = new.movement_group_id
  for update;

  if not found or exists (
    select 1
    from public.client_fund_movements restore
    where restore.movement_type = 'credit'
      and restore.reason_code = 'counter_change_void_restore'
      and restore.order_id = new.order_id
      and restore.movement_group_id = new.movement_group_id
  ) then
    return new;
  end if;

  v_actor := coalesce(new.voided_by_user_id, new.reviewed_by_user_id, new.created_by_user_id);

  update public.clients
  set
    fund_balance_usd = round(fund_balance_usd + v_fund.amount_usd, 2),
    updated_at = now()
  where id = v_fund.client_id;

  if not found then
    raise exception 'Could not restore the client fund for the voided change';
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
    created_by_user_id,
    movement_group_id
  ) values (
    v_fund.client_id,
    'credit',
    v_fund.currency_code,
    v_fund.amount,
    v_fund.amount_usd,
    v_fund.money_account_id,
    v_fund.order_id,
    null,
    'counter_change_void_restore',
    coalesce(
      nullif(btrim(coalesce(new.void_reason, '')), ''),
      'Restitucion automatica por anulacion del cambio de Counter.'
    ),
    v_actor,
    v_fund.movement_group_id
  );

  return new;
end;
$function$;

drop trigger if exists counter_restore_voided_change_fund_trigger
  on public.money_movements;
create trigger counter_restore_voided_change_fund_trigger
after update of status on public.money_movements
for each row
execute function public.counter_restore_voided_change_fund();

revoke all on function public.counter_restore_voided_change_fund()
  from public, anon, authenticated;
grant execute on function public.counter_restore_voided_change_fund()
  to service_role;

create or replace function public.get_order_financial_state(
  p_order_id bigint,
  p_operation_date date default null,
  p_active_bs_rate numeric default null
)
returns table (
  order_id bigint,
  order_number text,
  order_status text,
  total_usd numeric,
  total_bs numeric,
  snapshot_rate_bs_per_usd numeric,
  confirmed_paid_usd numeric,
  confirmed_paid_bs_snapshot numeric,
  pending_reports_usd numeric,
  pending_reports_bs_snapshot numeric,
  rejected_reports_usd numeric,
  voided_movements_count integer,
  rejected_reports_count integer,
  pending_reports_count integer,
  confirmed_reports_count integer,
  client_fund_used_usd numeric,
  pending_usd numeric,
  pending_bs numeric,
  overpaid_usd numeric,
  collection_mode text,
  payment_status text,
  delivery_reference_date date,
  effective_operation_date date
)
language sql
stable
set search_path = ''
as $function$
with base as (
  select *
  from public.get_order_financial_state_block3(
    p_order_id,
    p_operation_date,
    p_active_bs_rate
  )
),
adjustments as (
  select
    round(coalesce(sum(movement.amount_usd_equivalent) filter (
      where movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'withdrawal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.command_type = 'request_refund'
            and receipt.order_id = movement.order_id
            and receipt.idempotency_key = movement.movement_group_id
        )
    ), 0), 2) as refund_usd,
    round(coalesce(sum(
      case
        when movement.currency_code = 'VES' then movement.amount
        else movement.amount_usd_equivalent * coalesce(base.snapshot_rate_bs_per_usd, 0)
      end
    ) filter (
      where movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'withdrawal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.command_type = 'request_refund'
            and receipt.order_id = movement.order_id
            and receipt.idempotency_key = movement.movement_group_id
        )
    ), 0), 2) as refund_bs_snapshot,
    round(coalesce((
      select sum(fund.amount_usd)
      from public.client_fund_movements fund
      where fund.order_id = p_order_id
        and fund.movement_type = 'debit'
        and fund.reason_code = 'counter_change_fund_reversal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.order_id = fund.order_id
            and receipt.command_type = 'apply_order_payments'
            and receipt.status = 'completed'
            and receipt.created_at = fund.created_at
            and exists (
              select 1
              from public.money_movements payment
              where payment.order_id = fund.order_id
                and payment.movement_group_id = receipt.idempotency_key
                and payment.status = 'confirmed'
                and payment.direction = 'inflow'
                and payment.movement_type = 'order_payment'
            )
            and exists (
              select 1
              from public.money_movements change_movement
              where change_movement.order_id = fund.order_id
                and change_movement.movement_group_id = receipt.idempotency_key
                and change_movement.status = 'confirmed'
                and change_movement.direction = 'outflow'
                and change_movement.movement_type = 'change_given'
            )
        )
    ), 0), 2) as legacy_change_usd,
    round(coalesce((
      select sum(fund.amount_usd)
      from public.client_fund_movements fund
      where fund.order_id = p_order_id
        and fund.movement_type = 'debit'
        and fund.reason_code = 'counter_change_given'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          join public.money_movements change_movement
            on change_movement.order_id = receipt.order_id
           and change_movement.movement_group_id = receipt.idempotency_key
           and change_movement.status = 'confirmed'
           and change_movement.direction = 'outflow'
           and change_movement.movement_type = 'change_given'
          where receipt.command_type = 'give_order_change'
            and receipt.status = 'completed'
            and receipt.order_id = fund.order_id
            and receipt.idempotency_key = fund.movement_group_id
        )
    ), 0), 2) as independent_change_usd
  from base
  left join public.money_movements movement
    on movement.order_id = base.order_id
  group by base.snapshot_rate_bs_per_usd
),
adjusted as (
  select
    base.*,
    greatest(0, round(
      base.confirmed_paid_usd
      + adjustments.legacy_change_usd
      + adjustments.independent_change_usd
      - adjustments.refund_usd,
      2
    )) as adjusted_paid_usd,
    greatest(0, round(
      base.confirmed_paid_bs_snapshot
      + (adjustments.legacy_change_usd + adjustments.independent_change_usd)
        * base.snapshot_rate_bs_per_usd
      - adjustments.refund_bs_snapshot,
      2
    )) as adjusted_paid_bs
  from base
  cross join adjustments
),
balances as (
  select
    adjusted.*,
    greatest(0, round(adjusted.total_usd - adjusted.adjusted_paid_usd, 2)) as adjusted_pending_usd,
    greatest(0, round(adjusted.adjusted_paid_usd - adjusted.total_usd, 2)) as adjusted_overpaid_usd
  from adjusted
)
select
  balances.order_id,
  balances.order_number,
  balances.order_status,
  balances.total_usd,
  balances.total_bs,
  balances.snapshot_rate_bs_per_usd,
  balances.adjusted_paid_usd,
  balances.adjusted_paid_bs,
  balances.pending_reports_usd,
  balances.pending_reports_bs_snapshot,
  balances.rejected_reports_usd,
  balances.voided_movements_count,
  balances.rejected_reports_count,
  balances.pending_reports_count,
  balances.confirmed_reports_count,
  balances.client_fund_used_usd,
  balances.adjusted_pending_usd,
  case
    when balances.adjusted_pending_usd <= 0.005 then 0
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then round(balances.adjusted_pending_usd * p_active_bs_rate, 2)
    when balances.total_bs > 0
      then greatest(0, round(balances.total_bs - balances.adjusted_paid_bs, 2))
    when coalesce(p_active_bs_rate, 0) > 0
      then round(balances.adjusted_pending_usd * p_active_bs_rate, 2)
    else 0
  end,
  balances.adjusted_overpaid_usd,
  case
    when balances.adjusted_pending_usd <= 0.005 then 'closed'
    when balances.delivery_reference_date is not null
      and balances.effective_operation_date > balances.delivery_reference_date
      and coalesce(p_active_bs_rate, 0) > 0
      then 'post_delivery_usd'
    else 'snapshot_quote'
  end,
  case
    when balances.order_status = 'cancelled' then 'cancelled'
    when balances.adjusted_overpaid_usd > 0.005 then 'overpaid'
    when balances.pending_reports_count > 0 then 'pending_review'
    when balances.adjusted_pending_usd <= 0.005 then 'paid'
    when balances.adjusted_paid_usd > 0.005 then 'partial'
    else 'unpaid'
  end,
  balances.delivery_reference_date,
  balances.effective_operation_date
from balances;
$function$;

comment on function public.get_order_financial_state(bigint, date, numeric)
is 'Estado financiero canonico por orden. Mantiene separados cobros y cada entrega de cambio Counter sin alterar el pago aplicado.';

revoke all on function public.get_order_financial_state(bigint, date, numeric)
  from public, anon;
grant execute on function public.get_order_financial_state(bigint, date, numeric)
  to authenticated, service_role;

commit;
