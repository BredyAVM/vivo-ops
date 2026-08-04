-- Counter Block 4: operational register engine
-- Date: 2026-07-25
--
-- Extends the Block 2 atomic command without duplicating the canonical ledgers:
-- - payment_reports: reported and reviewed payments
-- - money_movements: confirmed money only
-- - client_fund_movements: customer fund
-- - order_change_obligations: digital change that is still owed

begin;

create table public.order_change_obligations (
  id bigint generated always as identity primary key,
  order_id bigint not null
    references public.orders(id) on update restrict on delete restrict,
  command_idempotency_key uuid not null,
  line_key text not null,
  requested_by_user_id uuid not null
    references auth.users(id) on delete restrict,
  responsible_user_id uuid null
    references auth.users(id) on delete set null,
  responsible_role text not null,
  status text not null default 'pending',
  payment_method_code text not null,
  currency_code public.currency_code not null,
  amount numeric(12,2) not null,
  exchange_rate_ves_per_usd numeric(18,6) null,
  amount_usd_equivalent numeric(12,2) not null,
  notes text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  completed_by_user_id uuid null
    references auth.users(id) on delete set null,
  completed_movement_id bigint null
    references public.money_movements(id) on update restrict on delete restrict,
  constraint order_change_obligations_command_line_uk
    unique (command_idempotency_key, line_key),
  constraint order_change_obligations_line_key_ck
    check (nullif(btrim(line_key), '') is not null),
  constraint order_change_obligations_responsible_role_ck
    check (responsible_role in ('advisor', 'master')),
  constraint order_change_obligations_status_ck
    check (status in ('pending', 'completed', 'cancelled')),
  constraint order_change_obligations_method_ck
    check (nullif(btrim(payment_method_code), '') is not null),
  constraint order_change_obligations_amount_ck
    check (amount > 0 and amount_usd_equivalent > 0),
  constraint order_change_obligations_currency_rate_ck
    check (
      (
        currency_code = 'VES'
        and exchange_rate_ves_per_usd is not null
        and exchange_rate_ves_per_usd > 0
      )
      or (
        currency_code = 'USD'
        and exchange_rate_ves_per_usd is null
        and amount_usd_equivalent = amount
      )
    ),
  constraint order_change_obligations_completion_ck
    check (
      (
        status = 'pending'
        and completed_at is null
        and completed_by_user_id is null
        and completed_movement_id is null
      )
      or (
        status = 'completed'
        and completed_at is not null
        and completed_by_user_id is not null
        and completed_movement_id is not null
      )
      or (
        status = 'cancelled'
        and completed_at is not null
        and completed_by_user_id is not null
        and completed_movement_id is null
      )
    )
);

comment on table public.order_change_obligations
is 'Cambio digital prometido al cliente que aun no constituye una salida confirmada de dinero.';

create index order_change_obligations_order_status_created_idx
  on public.order_change_obligations(order_id, status, created_at desc, id desc);

create index order_change_obligations_responsible_pending_idx
  on public.order_change_obligations(responsible_user_id, created_at, id)
  where status = 'pending' and responsible_user_id is not null;

alter table public.order_change_obligations enable row level security;

revoke all on public.order_change_obligations from public, anon, authenticated;
grant select, insert, update, delete on public.order_change_obligations to service_role;

revoke all on sequence public.order_change_obligations_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.order_change_obligations_id_seq to service_role;

-- Preserve the tested Block 2 implementation as the inner payment primitive.
alter function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) rename to counter_apply_order_payments_block2;

revoke all on function public.counter_apply_order_payments_block2(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) from public, anon, authenticated;

grant execute on function public.counter_apply_order_payments_block2(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) to service_role;

create function public.counter_apply_order_payments(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_payment_lines jsonb,
  p_overpayment_handling text default null,
  p_change_lines jsonb default '[]'::jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_existing public.counter_command_receipts%rowtype;
  v_request_payload jsonb;
  v_legacy_result jsonb;
  v_result jsonb;
  v_order record;
  v_line jsonb;
  v_line_key text;
  v_change_mode text;
  v_account_id bigint;
  v_account record;
  v_payment_method text;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_equiv numeric(12,2);
  v_movement_id bigint;
  v_confirmed_payment_usd numeric(12,2) := 0;
  v_pending_payment_usd numeric(12,2) := 0;
  v_cash_change_usd numeric(12,2) := 0;
  v_digital_change_usd numeric(12,2) := 0;
  v_total_change_usd numeric(12,2) := 0;
  v_legacy_fund_usd numeric(12,2) := 0;
  v_fund_reversal_usd numeric(12,2) := 0;
  v_final_fund_usd numeric(12,2) := 0;
  v_movements jsonb := '[]'::jsonb;
  v_obligations jsonb := '[]'::jsonb;
  v_state record;
  v_event_id bigint;
  v_command_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can apply a Counter payment operation';
  end if;

  p_payment_lines := coalesce(p_payment_lines, '[]'::jsonb);
  p_change_lines := coalesce(p_change_lines, '[]'::jsonb);

  if jsonb_typeof(p_payment_lines) <> 'array'
     or jsonb_array_length(p_payment_lines) < 1
     or jsonb_array_length(p_payment_lines) > 12 then
    raise exception 'payment_lines must contain between 1 and 12 lines';
  end if;

  if jsonb_typeof(p_change_lines) <> 'array'
     or jsonb_array_length(p_change_lines) > 12 then
    raise exception 'change_lines must be an array with at most 12 lines';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from jsonb_array_elements(p_change_lines) line
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every change line requires a unique non-empty line_key';
  end if;

  if jsonb_array_length(p_change_lines) > 0
     and p_overpayment_handling is distinct from 'change_given' then
    raise exception 'change_lines require change_given handling';
  end if;

  if jsonb_array_length(p_change_lines) = 0
     and p_overpayment_handling = 'change_given' then
    raise exception 'change_given handling requires change_lines';
  end if;

  if p_overpayment_handling is not null
     and p_overpayment_handling not in ('change_given', 'store_fund') then
    raise exception 'Invalid overpayment handling';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'payment_lines', p_payment_lines,
    'overpayment_handling', p_overpayment_handling,
    'change_lines', p_change_lines,
    'notes', p_notes
  );

  select receipt.*
  into v_existing
  from public.counter_command_receipts receipt
  where receipt.actor_user_id = v_uid
    and receipt.command_type = 'apply_order_payments'
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_payload is distinct from v_request_payload then
      raise exception 'Idempotency key was already used with another payload';
    end if;
    if v_existing.status <> 'completed' then
      raise exception 'Counter command is already in progress';
    end if;
    return v_existing.result_payload;
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

  -- All referenced accounts are locked in one ascending pass before the
  -- Block 2 primitive to keep the lock order deterministic.
  for v_account_id in
    select distinct requested.account_id
    from (
      select (line ->> 'money_account_id')::bigint as account_id
      from jsonb_array_elements(p_payment_lines) line
      union all
      select (line ->> 'money_account_id')::bigint as account_id
      from jsonb_array_elements(p_change_lines) line
      where coalesce(line ->> 'change_mode', 'cash') = 'cash'
    ) requested
    where requested.account_id is not null
    order by requested.account_id
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  v_legacy_result := public.counter_apply_order_payments_block2(
    p_idempotency_key,
    p_order_id,
    p_payment_lines,
    case
      when p_overpayment_handling = 'change_given' then 'store_fund'
      else p_overpayment_handling
    end,
    '[]'::jsonb,
    p_notes
  );

  select
    round(coalesce(sum((report ->> 'amount_usd_equivalent')::numeric)
      filter (where report ->> 'status' = 'confirmed'), 0), 2),
    round(coalesce(sum((report ->> 'amount_usd_equivalent')::numeric)
      filter (where report ->> 'status' = 'pending'), 0), 2)
  into v_confirmed_payment_usd, v_pending_payment_usd
  from jsonb_array_elements(coalesce(v_legacy_result -> 'reports', '[]'::jsonb)) report;

  for v_line in
    select line
    from jsonb_array_elements(p_change_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_change_mode := lower(coalesce(nullif(btrim(v_line ->> 'change_mode'), ''), 'cash'));
    v_payment_method := lower(nullif(btrim(v_line ->> 'payment_method'), ''));
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    if v_change_mode not in ('cash', 'digital_pending') then
      raise exception 'Invalid change mode on line %', v_line_key;
    end if;

    if v_change_mode = 'cash' then
      v_account_id := (v_line ->> 'money_account_id')::bigint;

      select account.*
      into v_account
      from public.money_accounts account
      where account.id = v_account_id;

      if not found
         or not v_account.is_active
         or v_account.currency_code <> v_currency
         or v_account.account_kind <> 'cash'
         or not public.is_counter_direct_money_account(v_account_id) then
        raise exception 'Change account % is not an active direct Counter cash account', v_account_id;
      end if;

      v_cash_change_usd := round(v_cash_change_usd + v_equiv, 2);

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
        (now() at time zone 'America/Caracas')::date,
        v_uid,
        v_command_at,
        v_uid,
        'confirmed',
        false,
        null,
        'outflow',
        'change_given',
        v_account_id,
        v_currency,
        v_amount,
        v_rate,
        v_equiv,
        null,
        null,
        format('Cambio Counter orden %s - linea %s', v_order.order_number, v_line_key),
        coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
        p_order_id,
        null,
        p_idempotency_key
      )
      returning id into v_movement_id;

      v_movements := v_movements || jsonb_build_array(jsonb_build_object(
        'line_key', v_line_key,
        'movement_id', v_movement_id,
        'movement_type', 'change_given',
        'amount_usd_equivalent', v_equiv
      ));
    else
      if v_payment_method is null then
        raise exception 'Digital change line % requires a payment method', v_line_key;
      end if;

      if not exists (
        select 1
        from public.money_account_payment_rules rule
        where rule.role = 'counter'
          and rule.payment_method_code = v_payment_method
          and rule.is_active = true
          and rule.can_report_payment = true
      ) then
        raise exception 'Digital change method % is not enabled for Counter', v_payment_method;
      end if;

      v_digital_change_usd := round(v_digital_change_usd + v_equiv, 2);

      insert into public.order_change_obligations (
        order_id,
        command_idempotency_key,
        line_key,
        requested_by_user_id,
        responsible_user_id,
        responsible_role,
        status,
        payment_method_code,
        currency_code,
        amount,
        exchange_rate_ves_per_usd,
        amount_usd_equivalent,
        notes
      ) values (
        p_order_id,
        p_idempotency_key,
        v_line_key,
        v_uid,
        v_order.attributed_advisor_id,
        case when v_order.attributed_advisor_id is null then 'master' else 'advisor' end,
        'pending',
        v_payment_method,
        v_currency,
        v_amount,
        v_rate,
        v_equiv,
        nullif(btrim(v_line ->> 'notes'), '')
      )
      returning id into v_movement_id;

      v_obligations := v_obligations || jsonb_build_array(jsonb_build_object(
        'line_key', v_line_key,
        'obligation_id', v_movement_id,
        'status', 'pending',
        'payment_method', v_payment_method,
        'amount_usd_equivalent', v_equiv
      ));
    end if;
  end loop;

  v_total_change_usd := round(v_cash_change_usd + v_digital_change_usd, 2);

  if v_total_change_usd > v_confirmed_payment_usd + 0.01 then
    raise exception 'Change cannot exceed the confirmed tender in this operation';
  end if;

  v_legacy_fund_usd := round(
    coalesce(nullif(v_legacy_result ->> 'fund_credit_usd', '')::numeric, 0),
    2
  );
  v_fund_reversal_usd := least(v_legacy_fund_usd, v_total_change_usd);
  v_final_fund_usd := round(greatest(0, v_legacy_fund_usd - v_fund_reversal_usd), 2);

  if v_fund_reversal_usd > 0.005 then
    if v_order.client_id is null then
      raise exception 'Order has no client for reversing the temporary fund credit';
    end if;

    perform client.id
    from public.clients client
    where client.id = v_order.client_id
    for update;

    update public.clients
    set
      fund_balance_usd = round(fund_balance_usd - v_fund_reversal_usd, 2),
      updated_at = now()
    where id = v_order.client_id
      and fund_balance_usd + 0.005 >= v_fund_reversal_usd;

    if not found then
      raise exception 'Client fund changed while the Counter operation was running';
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
      created_by_user_id
    ) values (
      v_order.client_id,
      'debit',
      'USD',
      v_fund_reversal_usd,
      v_fund_reversal_usd,
      null,
      p_order_id,
      null,
      'counter_change_fund_reversal',
      'Reversion del credito temporal reemplazado por cambio de Counter.',
      v_uid
    );
  end if;

  if v_digital_change_usd > 0.005 then
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
      'counter_digital_change_pending',
      'payment',
      'Cambio digital pendiente',
      format('Queda pendiente entregar cambio digital por USD %s.', v_digital_change_usd),
      'warning',
      v_uid,
      jsonb_build_object(
        'idempotency_key', p_idempotency_key,
        'obligations', v_obligations,
        'amount_usd_equivalent', v_digital_change_usd
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
      case when v_order.attributed_advisor_id is null then 'master' else null end,
      v_order.attributed_advisor_id,
      true
    );
  end if;

  update public.order_events event_row
  set meta = event_row.meta || jsonb_build_object(
    'cash_change_usd', v_cash_change_usd,
    'digital_change_pending_usd', v_digital_change_usd,
    'fund_credit_usd', v_final_fund_usd,
    'obligations', v_obligations
  )
  where event_row.order_id = p_order_id
    and event_row.event = 'counter_payment_operation'
    and event_row.meta ->> 'idempotency_key' = p_idempotency_key::text;

  update public.order_timeline_events timeline
  set
    message = format(
      '%s pago(s); cambio efectivo USD %s; cambio digital pendiente USD %s; fondo USD %s.',
      jsonb_array_length(coalesce(v_legacy_result -> 'reports', '[]'::jsonb)),
      v_cash_change_usd,
      v_digital_change_usd,
      v_final_fund_usd
    ),
    payload = timeline.payload || jsonb_build_object(
      'cash_change_usd', v_cash_change_usd,
      'digital_change_pending_usd', v_digital_change_usd,
      'fund_credit_usd', v_final_fund_usd,
      'obligations', v_obligations
    )
  where timeline.order_id = p_order_id
    and timeline.event_type = 'counter_payment_operation'
    and timeline.payload ->> 'idempotency_key' = p_idempotency_key::text;

  select *
  into v_state
  from public.get_order_financial_state(p_order_id, null, null);

  v_result := v_legacy_result || jsonb_build_object(
    'confirmed_payment_usd', v_confirmed_payment_usd,
    'pending_payment_usd', v_pending_payment_usd,
    'cash_change_usd', v_cash_change_usd,
    'digital_change_pending_usd', v_digital_change_usd,
    'change_usd', v_cash_change_usd,
    'fund_credit_usd', v_final_fund_usd,
    'pending_usd', coalesce(v_state.pending_usd, 0),
    'overpaid_usd', coalesce(v_state.overpaid_usd, 0),
    'obligations', v_obligations,
    'movements', coalesce(v_legacy_result -> 'movements', '[]'::jsonb) || v_movements
  );

  update public.counter_command_receipts receipt
  set
    request_payload = v_request_payload,
    result_payload = v_result
  where receipt.actor_user_id = v_uid
    and receipt.command_type = 'apply_order_payments'
    and receipt.idempotency_key = p_idempotency_key;

  return v_result;
end;
$function$;

revoke all on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) from public, anon;

grant execute on function public.counter_apply_order_payments(
  uuid,
  bigint,
  jsonb,
  text,
  jsonb,
  text
) to authenticated, service_role;

-- Wrap the financial state so confirmed Counter refunds and the temporary
-- fund reversal used by mixed change are reflected without counting generic
-- withdrawals from other financial workflows.
alter function public.get_order_financial_state(
  bigint,
  date,
  numeric
) rename to get_order_financial_state_block3;

create function public.get_order_financial_state(
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
    ), 0), 2) as change_fund_reversal_usd
  from base
  left join public.money_movements movement
    on movement.order_id = base.order_id
  group by base.snapshot_rate_bs_per_usd
),
adjusted as (
  select
    base.*,
    greatest(
      0,
      round(
        base.confirmed_paid_usd
        + adjustments.change_fund_reversal_usd
        - adjustments.refund_usd,
        2
      )
    ) as adjusted_paid_usd,
    greatest(
      0,
      round(
        base.confirmed_paid_bs_snapshot
        + adjustments.change_fund_reversal_usd * base.snapshot_rate_bs_per_usd
        - adjustments.refund_bs_snapshot,
        2
      )
    ) as adjusted_paid_bs
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
is 'Estado financiero canonico por orden, incluyendo devoluciones Counter confirmadas y reversiones temporales de fondo por cambio mixto.';

create or replace function public.get_orders_financial_state(
  p_order_ids bigint[],
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
security definer
set search_path = ''
as $function$
  select state.*
  from unnest(coalesce(p_order_ids, array[]::bigint[])) ids(order_id)
  cross join lateral public.get_order_financial_state(
    ids.order_id,
    p_operation_date,
    p_active_bs_rate
  ) state;
$function$;

revoke all on function public.get_order_financial_state(bigint, date, numeric)
  from public, anon;
grant execute on function public.get_order_financial_state(bigint, date, numeric)
  to authenticated, service_role;

revoke all on function public.get_orders_financial_state(bigint[], date, numeric)
  from public, anon;
grant execute on function public.get_orders_financial_state(bigint[], date, numeric)
  to authenticated, service_role;

create or replace function public.counter_read_active_queue(
  p_limit integer default 120
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 120), 1), 120);
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

  select rate.rate_bs_per_usd
  into v_active_rate
  from public.exchange_rates rate
  where rate.is_active = true
  order by rate.effective_at desc, rate.id desc
  limit 1;

  with selected_orders as materialized (
    select order_row.*
    from public.orders order_row
    where order_row.status in ('confirmed', 'in_kitchen', 'ready', 'out_for_delivery')
       or (order_row.status = 'created' and order_row.source = 'walk_in')
    order by order_row.ready_at asc nulls last, order_row.created_at asc, order_row.id asc
    limit v_limit
  ),
  financial as materialized (
    select state.*
    from public.get_orders_financial_state(
      coalesce((select array_agg(selected.id) from selected_orders selected), array[]::bigint[]),
      null,
      v_active_rate
    ) state
  ),
  shaped as (
    select
      selected.ready_at,
      selected.created_at,
      selected.id,
      jsonb_build_object(
        'id', selected.id,
        'order_number', selected.order_number,
        'status', selected.status::text,
        'source', selected.source::text,
        'fulfillment', selected.fulfillment::text,
        'delivery_address', selected.delivery_address,
        'delivery_mode', selected.delivery_mode::text,
        'external_driver_name', selected.external_driver_name,
        'external_reference', selected.external_reference,
        'total_usd', selected.total_usd,
        'total_bs_snapshot', selected.total_bs_snapshot,
        'notes', selected.notes,
        'created_at', selected.created_at,
        'ready_at', selected.ready_at,
        'extra_fields', coalesce(selected.extra_fields, '{}'::jsonb),
        'client_name', coalesce(nullif(trim(client.full_name), ''), 'Cliente'),
        'client_phone', client.phone,
        'advisor_name', nullif(trim(advisor.full_name), ''),
        'has_advisor', selected.attributed_advisor_id is not null,
        'delivery_assignee_kind',
          case
            when selected.internal_driver_user_id is not null then 'internal'
            when selected.external_partner_id is not null
              or nullif(trim(selected.external_driver_name), '') is not null then 'external'
            else null
          end,
        'delivery_assignee_name',
          coalesce(
            nullif(trim(driver.full_name), ''),
            nullif(trim(partner.name), ''),
            nullif(trim(selected.external_driver_name), '')
          ),
        'confirmed_paid_usd', coalesce(financial.confirmed_paid_usd, 0),
        'pending_usd', coalesce(financial.pending_usd, greatest(coalesce(selected.total_usd, 0), 0)),
        'payment_status', coalesce(financial.payment_status, 'unpaid'),
        'pending_reports_usd', coalesce(financial.pending_reports_usd, 0),
        'overpaid_usd', coalesce(financial.overpaid_usd, 0),
        'pending_reports_count', coalesce(financial.pending_reports_count, 0),
        'confirmed_reports_count', coalesce(financial.confirmed_reports_count, 0),
        'rejected_reports_count', coalesce(financial.rejected_reports_count, 0)
      ) as payload
    from selected_orders selected
    left join financial on financial.order_id = selected.id
    left join public.clients client on client.id = selected.client_id
    left join public.profiles advisor on advisor.id = selected.attributed_advisor_id
    left join public.profiles driver on driver.id = selected.internal_driver_user_id
    left join public.delivery_partners partner on partner.id = selected.external_partner_id
  )
  select coalesce(
    jsonb_agg(shaped.payload order by shaped.ready_at asc nulls last, shaped.created_at asc, shaped.id asc),
    '[]'::jsonb
  )
  into v_payload
  from shaped;

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
    'total_usd', order_row.total_usd,
    'total_bs_snapshot', order_row.total_bs_snapshot,
    'notes', order_row.notes,
    'created_at', order_row.created_at,
    'ready_at', order_row.ready_at,
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
  where order_row.id = p_order_id;

  if v_payload is null then
    raise exception 'counter_order_not_found';
  end if;

  return v_payload;
end;
$function$;

revoke all on function public.counter_read_active_queue(integer)
  from public, anon;
grant execute on function public.counter_read_active_queue(integer)
  to authenticated, service_role;

revoke all on function public.counter_read_order_detail(bigint)
  from public, anon;
grant execute on function public.counter_read_order_detail(bigint)
  to authenticated, service_role;

commit;
