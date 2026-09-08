-- Counter may return the closest available denomination even when it is
-- slightly greater than the order's stored overpayment. The uncovered part is
-- not a waiver: it reopens the order balance and remains collectible.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  v_fund_debit_usd numeric(12,2);
  v_fund_debit_amount numeric(12,2);
  v_advance_usd numeric(12,2);
  v_tender_remaining_usd numeric(12,2);
  v_pending_usd numeric(12,2);
  v_request_payload jsonb;
  v_claim record;
  v_receipt_id bigint;
  v_movement_id bigint;
  v_event_id bigint;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Debes iniciar sesion para entregar cambio'
      using errcode = '42501';
  end if;

  if not (public.has_role('counter') or public.is_master_or_admin()) then
    raise exception 'Solo Counter o Master/Admin pueden entregar cambio'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'La entrega de cambio no tiene una clave valida';
  end if;

  if p_order_id is null or p_order_id <= 0 then
    raise exception 'La orden indicada no es valida';
  end if;

  if p_money_account_id is null or p_money_account_id <= 0 then
    raise exception 'Selecciona una caja valida para entregar el cambio';
  end if;

  if p_operation_date is null then
    raise exception 'La fecha de la entrega de cambio es obligatoria';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    raise exception 'El monto del cambio debe ser mayor que cero';
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
    raise exception 'No se encontro la orden';
  end if;

  if v_order.client_id is null then
    raise exception 'La orden no tiene un cliente asociado';
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
    raise exception 'Selecciona una caja de efectivo activa de Counter';
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
      raise exception 'No hay una tasa activa para calcular el cambio';
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
    raise exception 'No se encontro el cliente de la orden';
  end if;

  v_available := coalesce(
    public.counter_order_change_balance_internal(p_order_id),
    0
  );

  -- A change advance may never become an unrelated cash withdrawal. The total
  -- remains bounded by confirmed order tender after prior
  -- change deliveries and confirmed refunds.
  select round(coalesce(sum(
    case
      when movement.status = 'confirmed'
        and movement.direction = 'inflow'
        and movement.movement_type = 'order_payment'
        then coalesce(movement.amount_usd_equivalent, 0)
      when movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'change_given'
        then -coalesce(movement.amount_usd_equivalent, 0)
      when movement.status = 'confirmed'
        and movement.direction = 'outflow'
        and movement.movement_type = 'withdrawal'
        and exists (
          select 1
          from public.counter_command_receipts receipt
          where receipt.command_type = 'request_refund'
            and receipt.order_id = movement.order_id
            and receipt.idempotency_key = movement.movement_group_id
        )
        then -coalesce(movement.amount_usd_equivalent, 0)
      else 0
    end
  ), 0), 2)
  into v_tender_remaining_usd
  from public.money_movements movement
  where movement.order_id = p_order_id;

  v_tender_remaining_usd := greatest(0, coalesce(v_tender_remaining_usd, 0));

  if v_amount_usd > v_tender_remaining_usd + 0.005 then
    raise exception 'El cambio no puede superar el dinero confirmado que aun conserva esta orden';
  end if;

  v_fund_debit_usd := round(least(
    v_amount_usd,
    greatest(0, v_available),
    greatest(0, v_client_balance)
  ), 2);
  v_advance_usd := greatest(0, round(v_amount_usd - v_fund_debit_usd, 2));
  v_fund_debit_amount := case
    when v_account.currency_code = 'VES'
      then least(v_amount, round(v_fund_debit_usd * v_rate, 2))
    else v_fund_debit_usd
  end;

  insert into public.money_movements (
    movement_date, created_by_user_id, confirmed_at, confirmed_by_user_id,
    status, approval_required, approval_required_reason, direction,
    movement_type, money_account_id, currency_code, amount,
    exchange_rate_ves_per_usd, amount_usd_equivalent, reference_code,
    counterparty_name, description, notes, order_id, payment_report_id,
    movement_group_id
  ) values (
    p_operation_date, v_uid, v_now, v_uid, 'confirmed', false, null, 'outflow',
    'change_given', p_money_account_id, v_account.currency_code, v_amount,
    v_rate, v_amount_usd, null, null,
    format('Cambio Counter orden %s', v_order.order_number),
    nullif(btrim(coalesce(p_notes, '')), ''), p_order_id, null,
    p_idempotency_key
  )
  returning id into v_movement_id;

  if v_fund_debit_usd > 0.005 then
    update public.clients
    set
      fund_balance_usd = round(fund_balance_usd - v_fund_debit_usd, 2),
      updated_at = now()
    where id = v_order.client_id
      and fund_balance_usd + 0.005 >= v_fund_debit_usd;

    if not found then
      raise exception 'El fondo del cliente cambio mientras se registraba la entrega';
    end if;

    insert into public.client_fund_movements (
      client_id, movement_type, currency_code, amount, amount_usd,
      money_account_id, order_id, payment_report_id, reason_code, notes,
      created_at, created_by_user_id, movement_group_id
    ) values (
      v_order.client_id, 'debit', v_account.currency_code::text,
      v_fund_debit_amount, v_fund_debit_usd, p_money_account_id, p_order_id,
      null, 'counter_change_given',
      coalesce(
        nullif(btrim(coalesce(p_notes, '')), ''),
        format('Cambio entregado por Counter en la orden %s.', v_order.order_number)
      ),
      v_now, v_uid, p_idempotency_key
    );
  end if;

  insert into public.order_events (order_id, event, performed_by, meta)
  values (
    p_order_id,
    'counter_change_given',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'movement_id', v_movement_id,
      'money_account_id', p_money_account_id,
      'currency_code', v_account.currency_code,
      'amount', v_amount,
      'amount_usd_equivalent', v_amount_usd,
      'fund_backed_change_usd', v_fund_debit_usd,
      'advance_change_usd', v_advance_usd
    )
  );

  insert into public.order_timeline_events (
    order_id, order_number, event_type, event_group, title, message, severity,
    actor_user_id, payload
  ) values (
    p_order_id,
    v_order.order_number,
    'counter_change_given',
    'payment',
    case when v_advance_usd > 0.005
      then 'Cambio entregado con saldo pendiente'
      else 'Cambio entregado'
    end,
    case when v_advance_usd > 0.005
      then format(
        'Counter entrego %s %s desde %s; la orden conserva %s USD por cobrar.',
        v_amount, v_account.currency_code, v_account.name, v_advance_usd
      )
      else format(
        'Counter entrego %s %s desde %s.',
        v_amount, v_account.currency_code, v_account.name
      )
    end,
    case when v_advance_usd > 0.005 then 'warning' else 'info' end,
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'movement_id', v_movement_id,
      'money_account_id', p_money_account_id,
      'currency_code', v_account.currency_code,
      'amount', v_amount,
      'amount_usd_equivalent', v_amount_usd,
      'fund_backed_change_usd', v_fund_debit_usd,
      'advance_change_usd', v_advance_usd
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id, target_role, target_user_id, requires_action
  ) values (
    v_event_id, 'master', null, v_advance_usd > 0.005
  );

  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients (
      event_id, target_role, target_user_id, requires_action
    ) values (
      v_event_id, null, v_order.attributed_advisor_id, v_advance_usd > 0.005
    );
  end if;

  v_available := coalesce(
    public.counter_order_change_balance_internal(p_order_id),
    0
  );

  select round(state.pending_usd, 2)
  into v_pending_usd
  from public.get_order_financial_state(p_order_id, p_operation_date, v_rate) state;

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
    'fund_backed_change_usd', v_fund_debit_usd,
    'advance_change_usd', v_advance_usd,
    'remaining_change_usd', round(v_available, 2),
    'pending_usd', coalesce(v_pending_usd, 0)
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

comment on function public.counter_give_order_change(
  uuid, bigint, bigint, numeric, date, text
) is 'Entrega cambio como salida independiente. Si la denominacion supera el excedente disponible, debita solo el fondo respaldado y deja la diferencia como saldo cobrable de la orden.';

revoke all on function public.counter_give_order_change(
  uuid, bigint, bigint, numeric, date, text
) from public, anon;
grant execute on function public.counter_give_order_change(
  uuid, bigint, bigint, numeric, date, text
) to authenticated, service_role;

commit;
