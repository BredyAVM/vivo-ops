create or replace function public.counter_apply_order_payments(
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
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_order record;
  v_line jsonb;
  v_line_key text;
  v_account_id bigint;
  v_account record;
  v_method text;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_operation_date date;
  v_reference text;
  v_bank_name text;
  v_payer_name text;
  v_line_notes text;
  v_report_notes text;
  v_report_payer text;
  v_equiv numeric(12,2);
  v_rule record;
  v_report_id bigint;
  v_movement_id bigint;
  v_duplicate record;
  v_state record;
  v_auto_confirm boolean;
  v_reports jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
  v_change_total_usd numeric(12,2) := 0;
  v_fund_credit_usd numeric(12,2) := 0;
  v_overpaid_usd numeric(12,2) := 0;
  v_client_balance numeric;
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
      from jsonb_array_elements(p_payment_lines) line
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every payment line requires a unique non-empty line_key';
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

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'payment_lines', p_payment_lines,
    'overpayment_handling', p_overpayment_handling,
    'change_lines', p_change_lines,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'apply_order_payments',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.status,
    order_row.client_id,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Payments cannot be added to a cancelled order';
  end if;

  -- Account rows are always locked in ascending id order. Other Block 2
  -- commands follow the same rule.
  for v_account_id in
    select distinct requested.account_id
    from (
      select (line ->> 'money_account_id')::bigint as account_id
      from jsonb_array_elements(p_payment_lines) line
      union
      select (line ->> 'money_account_id')::bigint as account_id
      from jsonb_array_elements(p_change_lines) line
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

  for v_line in
    select line
    from jsonb_array_elements(p_payment_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_account_id := (v_line ->> 'money_account_id')::bigint;
    v_method := lower(btrim(v_line ->> 'payment_method'));
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_operation_date := coalesce(
      nullif(btrim(v_line ->> 'operation_date'), '')::date,
      (now() at time zone 'America/Caracas')::date
    );
    v_reference := nullif(btrim(v_line ->> 'reference_code'), '');
    v_bank_name := nullif(btrim(v_line ->> 'bank_name'), '');
    v_payer_name := nullif(btrim(v_line ->> 'payer_name'), '');
    v_line_notes := nullif(btrim(v_line ->> 'notes'), '');

    select account.*
    into v_account
    from public.money_accounts account
    where account.id = v_account_id;

    if not v_account.is_active or v_account.currency_code <> v_currency then
      raise exception 'Payment account % is inactive or uses another currency', v_account_id;
    end if;

    select
      rule.can_report_payment,
      rule.can_confirm_payment,
      rule.auto_confirms_report,
      rule.review_required
    into v_rule
    from public.money_account_payment_rules rule
    where rule.money_account_id = v_account_id
      and rule.role = 'counter'
      and rule.payment_method_code = v_method
      and rule.is_active = true
    order by rule.id
    limit 1;

    if not found or not v_rule.can_report_payment then
      raise exception 'Counter payment method % is not enabled for account %', v_method, v_account_id;
    end if;

    if v_method in ('payment_mobile', 'transfer') then
      if v_reference is null or v_bank_name is null then
        raise exception 'Payment method % requires reference and bank', v_method;
      end if;
    elsif v_method in ('zelle', 'wallet_usd') then
      if v_reference is null or v_payer_name is null then
        raise exception 'Payment method % requires reference and holder name', v_method;
      end if;
    end if;

    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    -- A VES payment that exactly or partially covers the snapshot debt keeps
    -- the order quote instead of silently repricing it at today's rate.
    if v_currency = 'VES' then
      select *
      into v_state
      from public.get_order_financial_state(
        p_order_id,
        v_operation_date,
        v_rate
      );

      if found and v_state.collection_mode = 'snapshot_quote' then
        if abs(v_amount - v_state.pending_bs) <= 0.01
           and v_state.pending_usd > 0.005 then
          v_equiv := round(v_state.pending_usd, 2);
        elsif v_amount < v_state.pending_bs
          and v_state.snapshot_rate_bs_per_usd > 0 then
          v_equiv := round(v_amount / v_state.snapshot_rate_bs_per_usd, 2);
        elsif abs(v_amount - v_state.total_bs) <= 0.01
          and v_state.total_usd > 0.005 then
          v_equiv := round(v_state.total_usd, 2);
        end if;
      end if;
    end if;

    if v_equiv <= 0 then
      raise exception 'Payment line % rounds to an invalid USD equivalent', v_line_key;
    end if;

    select *
    into v_duplicate
    from public.find_active_payment_duplicate(
      v_account_id,
      v_operation_date,
      v_currency,
      v_amount,
      v_reference,
      null
    )
    limit 1;

    if found then
      raise exception
        'Possible duplicate payment on order %',
        coalesce(v_duplicate.order_number, '#' || v_duplicate.order_id::text);
    end if;

    v_report_payer := case
      when v_method in ('payment_mobile', 'transfer') then v_bank_name
      else v_payer_name
    end;
    v_report_notes := nullif(concat_ws(
      E'\n',
      format('Metodo: %s', v_method),
      format('Fecha operacion: %s', v_operation_date),
      case when v_bank_name is not null then format('Banco: %s', v_bank_name) end,
      case when v_payer_name is not null then format('Titular: %s', v_payer_name) end,
      v_line_notes,
      nullif(btrim(p_notes), '')
    ), '');

    insert into public.payment_reports (
      order_id,
      status,
      created_by_user_id,
      reported_currency_code,
      reported_amount,
      reported_exchange_rate_ves_per_usd,
      reported_amount_usd_equivalent,
      reported_money_account_id,
      reference_code,
      payer_name,
      notes,
      operation_date
    ) values (
      p_order_id,
      'pending',
      v_uid,
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_reference,
      v_report_payer,
      v_report_notes,
      v_operation_date
    )
    returning id into v_report_id;

    v_auto_confirm := (
      v_rule.can_confirm_payment
      and v_rule.auto_confirms_report
      and not v_rule.review_required
    );
    v_movement_id := null;

    if v_auto_confirm then
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
        v_operation_date,
        v_uid,
        v_command_at,
        v_uid,
        'confirmed',
        false,
        null,
        'inflow',
        'order_payment',
        v_account_id,
        v_currency,
        v_amount,
        v_rate,
        v_equiv,
        v_reference,
        v_report_payer,
        format('Pago Counter orden %s - linea %s', v_order.order_number, v_line_key),
        v_line_notes,
        p_order_id,
        v_report_id,
        p_idempotency_key
      )
      returning id into v_movement_id;

      update public.payment_reports
      set
        status = 'confirmed',
        reviewed_at = v_command_at,
        reviewed_by_user_id = v_uid,
        review_notes = 'Auto confirmado por Counter en operacion atomica.',
        confirmed_movement_id = v_movement_id
      where id = v_report_id;

      v_movements := v_movements || jsonb_build_array(jsonb_build_object(
        'line_key', v_line_key,
        'movement_id', v_movement_id,
        'movement_type', 'order_payment'
      ));
    end if;

    v_reports := v_reports || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'report_id', v_report_id,
      'status', case when v_auto_confirm then 'confirmed' else 'pending' end,
      'movement_id', v_movement_id,
      'amount_usd_equivalent', v_equiv
    ));
  end loop;

  select *
  into v_state
  from public.get_order_financial_state(p_order_id, null, null);

  v_overpaid_usd := case
    when found then round(coalesce(v_state.overpaid_usd, 0), 2)
    else 0
  end;

  if v_overpaid_usd > 0.005 then
    if p_overpayment_handling not in ('change_given', 'store_fund') then
      raise exception 'An overpayment requires change_given or store_fund handling';
    end if;

    if p_overpayment_handling = 'change_given' then
      if jsonb_array_length(p_change_lines) = 0 then
        raise exception 'change_lines are required when handling an overpayment as change';
      end if;

      for v_line in
        select line
        from jsonb_array_elements(p_change_lines) line
      loop
        v_line_key := btrim(v_line ->> 'line_key');
        v_account_id := (v_line ->> 'money_account_id')::bigint;
        v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
        v_amount := round((v_line ->> 'amount')::numeric, 2);
        v_rate := case
          when v_currency = 'VES'
            then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
          else null
        end;
        v_line_notes := nullif(btrim(v_line ->> 'notes'), '');

        select account.*
        into v_account
        from public.money_accounts account
        where account.id = v_account_id;

        if not v_account.is_active
           or v_account.currency_code <> v_currency
           or v_account.account_kind <> 'cash'
           or not public.is_counter_direct_money_account(v_account_id) then
          raise exception 'Change account % is not an active direct Counter cash account', v_account_id;
        end if;

        v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);
        v_change_total_usd := round(v_change_total_usd + v_equiv, 2);

        if v_change_total_usd > v_overpaid_usd + 0.01 then
          raise exception 'Cash change cannot exceed the confirmed overpayment';
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
          coalesce(v_line_notes, nullif(btrim(p_notes), '')),
          p_order_id,
          null,
          p_idempotency_key
        )
        returning id into v_movement_id;

        v_movements := v_movements || jsonb_build_array(jsonb_build_object(
          'line_key', v_line_key,
          'movement_id', v_movement_id,
          'movement_type', 'change_given'
        ));
      end loop;

      v_fund_credit_usd := round(greatest(0, v_overpaid_usd - v_change_total_usd), 2);
    else
      if jsonb_array_length(p_change_lines) > 0 then
        raise exception 'change_lines must be empty when handling an overpayment as store_fund';
      end if;
      v_fund_credit_usd := v_overpaid_usd;
    end if;

    if v_fund_credit_usd > 0.005 then
      if v_order.client_id is null then
        raise exception 'Order has no client for storing the remaining overpayment';
      end if;

      select client.fund_balance_usd
      into v_client_balance
      from public.clients client
      where client.id = v_order.client_id
      for update;

      if not found then
        raise exception 'Order client not found';
      end if;

      update public.clients
      set
        fund_balance_usd = round(coalesce(v_client_balance, 0) + v_fund_credit_usd, 2),
        updated_at = now()
      where id = v_order.client_id;

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
        'credit',
        'USD',
        v_fund_credit_usd,
        v_fund_credit_usd,
        null,
        p_order_id,
        null,
        'payment_overage_stored',
        coalesce(nullif(btrim(p_notes), ''), 'Excedente guardado por operacion atomica de Counter.'),
        v_uid
      );
    end if;
  elsif jsonb_array_length(p_change_lines) > 0 then
    raise exception 'Change cannot be recorded without a confirmed overpayment';
  end if;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'counter_payment_operation',
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'reports', v_reports,
      'change_usd', v_change_total_usd,
      'fund_credit_usd', v_fund_credit_usd
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
    'counter_payment_operation',
    'payment',
    'Operacion de pago registrada',
    format(
      '%s linea(s) procesadas; cambio USD %s; fondo USD %s.',
      jsonb_array_length(v_reports),
      v_change_total_usd,
      v_fund_credit_usd
    ),
    case
      when exists (
        select 1
        from jsonb_array_elements(v_reports) report
        where report ->> 'status' = 'pending'
      ) then 'warning'
      else 'info'
    end,
    v_uid,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'reports', v_reports,
      'movements', v_movements,
      'change_usd', v_change_total_usd,
      'fund_credit_usd', v_fund_credit_usd
    )
  )
  returning id into v_event_id;

  insert into public.order_timeline_event_recipients (
    event_id,
    target_role,
    target_user_id,
    requires_action
  )
  values (
    v_event_id,
    'master',
    null,
    exists (
      select 1
      from jsonb_array_elements(v_reports) report
      where report ->> 'status' = 'pending'
    )
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
    'order_id', p_order_id,
    'reports', v_reports,
    'movements', v_movements,
    'overpaid_usd', v_overpaid_usd,
    'change_usd', v_change_total_usd,
    'fund_credit_usd', v_fund_credit_usd
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_record_manual_movement(
  p_idempotency_key uuid,
  p_direction public.movement_direction,
  p_money_account_id bigint,
  p_amount numeric,
  p_movement_date date,
  p_exchange_rate_ves_per_usd numeric default null,
  p_reference_code text default null,
  p_counterparty_name text default null,
  p_description text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_is_supervisor boolean;
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_account record;
  v_amount numeric(12,2) := round(p_amount, 2);
  v_rate numeric(18,6);
  v_equiv numeric(12,2);
  v_movement_type public.movement_type;
  v_status public.money_movement_status;
  v_movement_id bigint;
  v_command_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_is_supervisor := public.is_master_or_admin();
  if not v_is_supervisor and not public.has_role('counter') then
    raise exception 'Only Counter or Master/Admin can record a Counter manual movement';
  end if;

  if p_movement_date is null then
    raise exception 'movement_date is required';
  end if;

  v_request_payload := jsonb_build_object(
    'direction', p_direction,
    'money_account_id', p_money_account_id,
    'amount', p_amount,
    'movement_date', p_movement_date,
    'exchange_rate_ves_per_usd', p_exchange_rate_ves_per_usd,
    'reference_code', p_reference_code,
    'counterparty_name', p_counterparty_name,
    'description', p_description,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'record_manual_movement',
    null,
    p_money_account_id,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select account.*
  into v_account
  from public.money_accounts account
  where account.id = p_money_account_id
  for update;

  if not found or not v_account.is_active then
    raise exception 'Money account is missing or inactive';
  end if;

  if not v_is_supervisor and not public.is_counter_direct_money_account(p_money_account_id) then
    raise exception 'Counter can only use an active direct Counter account';
  end if;

  v_rate := case
    when v_account.currency_code = 'VES'
      then round(p_exchange_rate_ves_per_usd, 6)
    else null
  end;
  v_equiv := public.counter_amount_usd(v_account.currency_code, v_amount, v_rate);
  v_movement_type := case
    when p_direction = 'inflow' then 'other_income'::public.movement_type
    else 'expense_payment'::public.movement_type
  end;

  if p_direction = 'outflow'
     and not v_is_supervisor
     and v_equiv > 20.00 then
    v_status := 'pending';
  else
    v_status := 'confirmed';
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
    p_movement_date,
    v_uid,
    case when v_status = 'confirmed' then v_command_at else null end,
    case when v_status = 'confirmed' then v_uid else null end,
    v_status,
    v_status = 'pending',
    case
      when v_status = 'pending'
        then 'Gasto operativo Counter superior a USD 20 o su equivalente'
      else null
    end,
    p_direction,
    v_movement_type,
    p_money_account_id,
    v_account.currency_code,
    v_amount,
    v_rate,
    v_equiv,
    nullif(btrim(p_reference_code), ''),
    nullif(btrim(p_counterparty_name), ''),
    nullif(btrim(p_description), ''),
    nullif(btrim(p_notes), ''),
    null,
    null,
    p_idempotency_key
  )
  returning id into v_movement_id;

  v_result := jsonb_build_object(
    'ok', true,
    'movement_id', v_movement_id,
    'movement_group_id', p_idempotency_key,
    'status', v_status,
    'approval_required', v_status = 'pending',
    'amount_usd_equivalent', v_equiv
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_decide_authorization(
  p_idempotency_key uuid,
  p_movement_group_id uuid,
  p_decision text,
  p_decision_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_group record;
  v_movement_id bigint;
  v_account_id bigint;
  v_movement_ids jsonb;
  v_command_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can decide Counter authorizations';
  end if;

  p_decision := lower(btrim(p_decision));
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject';
  end if;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id;

  if v_group.movement_count = 0 then
    raise exception 'Authorization movement group not found';
  end if;

  if v_group.order_count > 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type not in ('expense_payment', 'withdrawal') then
    raise exception 'Movement group is not a valid Counter authorization';
  end if;

  v_request_payload := jsonb_build_object(
    'movement_group_id', p_movement_group_id,
    'decision', p_decision,
    'decision_notes', p_decision_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'decide_authorization',
    v_group.order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  if v_group.order_id is not null then
    perform order_row.id
    from public.orders order_row
    where order_row.id = v_group.order_id
    for update;
  end if;

  for v_account_id in
    select distinct movement.money_account_id
    from public.money_movements movement
    where movement.movement_group_id = p_movement_group_id
    order by movement.money_account_id
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;
  end loop;

  perform movement.id
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id
  order by movement.id
  for update;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type,
    bool_and(
      movement.status = 'pending'
      and movement.approval_required
      and movement.reviewed_at is null
      and movement.reviewed_by_user_id is null
    ) as awaits_decision
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_movement_group_id;

  if v_group.movement_count = 0
     or v_group.order_count > 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type not in ('expense_payment', 'withdrawal') then
    raise exception 'Movement group is not a valid Counter authorization';
  end if;

  if not v_group.awaits_decision then
    raise exception 'Only pending authorization movements can be decided';
  end if;

  if v_group.movement_type = 'expense_payment'
     and (v_group.movement_count <> 1 or v_group.order_id is not null) then
    raise exception 'Counter expense authorization must contain one unlinked movement';
  end if;

  if v_group.movement_type = 'withdrawal'
     and v_group.order_id is null then
    raise exception 'Counter refund authorization must be linked to one order';
  end if;

  if p_decision = 'reject' then
    update public.money_movements
    set
      status = 'rejected',
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      rejected_at = v_command_at,
      rejected_by_user_id = v_uid,
      rejection_reason = coalesce(
        nullif(btrim(p_decision_notes), ''),
        'Solicitud rechazada por Master/Admin'
      ),
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending';

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'rejected'
    );
  elsif v_group.movement_type = 'expense_payment' then
    update public.money_movements
    set
      status = 'confirmed',
      confirmed_at = v_command_at,
      confirmed_by_user_id = v_uid,
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending'
    returning id into v_movement_id;

    if not found then
      raise exception 'Pending expense movement not found';
    end if;

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'executed',
      'movement_id', v_movement_id
    );
  else
    update public.money_movements
    set
      reviewed_at = v_command_at,
      reviewed_by_user_id = v_uid,
      approval_required = false,
      approval_required_reason = null
    where movement_group_id = p_movement_group_id
      and status = 'pending';

    select coalesce(jsonb_agg(movement.id order by movement.id), '[]'::jsonb)
    into v_movement_ids
    from public.money_movements movement
    where movement.movement_group_id = p_movement_group_id;

    v_result := jsonb_build_object(
      'ok', true,
      'movement_group_id', p_movement_group_id,
      'status', 'approved',
      'movement_ids', v_movement_ids
    );
  end if;

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_execute_refund(
  p_idempotency_key uuid,
  p_refund_group_id uuid,
  p_operation_date date default null,
  p_execution_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_group record;
  v_order record;
  v_account_id bigint;
  v_movements jsonb := '[]'::jsonb;
  v_total_usd numeric(12,2);
  v_refundable_usd numeric(12,2);
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
    raise exception 'Only Counter or Master/Admin can execute an approved refund';
  end if;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_refund_group_id;

  if v_group.movement_count = 0
     or v_group.order_count <> 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type <> 'withdrawal' then
    raise exception 'Refund movement group not found';
  end if;

  p_operation_date := coalesce(
    p_operation_date,
    (now() at time zone 'America/Caracas')::date
  );
  v_request_payload := jsonb_build_object(
    'refund_group_id', p_refund_group_id,
    'operation_date', p_operation_date,
    'execution_notes', p_execution_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'execute_refund',
    v_group.order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = v_group.order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  for v_account_id in
    select distinct movement.money_account_id
    from public.money_movements movement
    where movement.movement_group_id = p_refund_group_id
    order by movement.money_account_id
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  perform movement.id
  from public.money_movements movement
  where movement.movement_group_id = p_refund_group_id
  order by movement.id
  for update;

  select
    min(movement.order_id) as order_id,
    count(*) as movement_count,
    count(distinct movement.order_id) filter (where movement.order_id is not null)
      as order_count,
    count(distinct movement.movement_type) as movement_type_count,
    min(movement.movement_type::text) as movement_type,
    bool_and(
      movement.status = 'pending'
      and not movement.approval_required
      and movement.reviewed_at is not null
      and movement.reviewed_by_user_id is not null
    ) as is_approved,
    round(sum(movement.amount_usd_equivalent), 2) as amount_usd_equivalent
  into v_group
  from public.money_movements movement
  where movement.movement_group_id = p_refund_group_id;

  if v_group.movement_count = 0
     or v_group.order_count <> 1
     or v_group.movement_type_count <> 1
     or v_group.movement_type <> 'withdrawal' then
    raise exception 'Refund movement group not found';
  end if;

  if not v_group.is_approved then
    raise exception 'Refund must be approved before execution';
  end if;

  if exists (
    select 1
    from public.money_movements movement
    join public.money_accounts account
      on account.id = movement.money_account_id
    where movement.movement_group_id = p_refund_group_id
      and (
        not account.is_active
        or account.currency_code <> movement.currency_code
        or account.account_kind <> 'cash'
        or not public.is_counter_direct_money_account(account.id)
      )
  ) then
    raise exception 'Refund group contains an invalid Counter cash account';
  end if;

  v_total_usd := v_group.amount_usd_equivalent;

  select round(
    coalesce(sum(
      case
        when movement.direction = 'inflow'
          and movement.movement_type = 'order_payment'
          then movement.amount_usd_equivalent
        when movement.direction = 'outflow'
          and movement.movement_type = 'change_given'
          then -movement.amount_usd_equivalent
        when movement.direction = 'outflow'
          and movement.movement_type = 'withdrawal'
          then -movement.amount_usd_equivalent
        else 0
      end
    ), 0),
    2
  )
  into v_refundable_usd
  from public.money_movements movement
  where movement.order_id = v_group.order_id
    and movement.status = 'confirmed';

  if v_total_usd > greatest(v_refundable_usd, 0) + 0.01 then
    raise exception 'Approved refund now exceeds the remaining refundable amount';
  end if;

  update public.money_movements
  set
    movement_date = p_operation_date,
    status = 'confirmed',
    confirmed_at = v_command_at,
    confirmed_by_user_id = v_uid,
    notes = case
      when nullif(btrim(p_execution_notes), '') is null then notes
      else concat_ws(' | ', notes, btrim(p_execution_notes))
    end
  where movement_group_id = p_refund_group_id
    and status = 'pending';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'movement_id', movement.id,
        'amount_usd_equivalent', movement.amount_usd_equivalent
      )
      order by movement.id
    ),
    '[]'::jsonb
  )
  into v_movements
  from public.money_movements movement
  where movement.movement_group_id = p_refund_group_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    v_group.order_id,
    'counter_refund_executed',
    v_uid,
    jsonb_build_object(
      'refund_group_id', p_refund_group_id,
      'idempotency_key', p_idempotency_key,
      'movements', v_movements
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
    v_group.order_id,
    v_order.order_number,
    'counter_refund_executed',
    'payment',
    'Devolucion ejecutada',
    format('Counter ejecuto una devolucion autorizada por USD %s.', v_total_usd),
    'warning',
    v_uid,
    jsonb_build_object(
      'refund_group_id', p_refund_group_id,
      'movements', v_movements
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
    'movement_group_id', p_refund_group_id,
    'status', 'executed',
    'movements', v_movements,
    'amount_usd_equivalent', v_total_usd
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_dispatch_delivery(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_eta_minutes integer default null,
  p_expected_collection_lines jsonb default '[]'::jsonb,
  p_cash_change_lines jsonb default '[]'::jsonb,
  p_digital_change_lines jsonb default '[]'::jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_order record;
  v_delivery_mode public.delivery_mode;
  v_responsible_name text;
  v_responsible_phone text;
  v_settlement_id bigint;
  v_settlement_status text;
  v_line jsonb;
  v_line_key text;
  v_account_id bigint;
  v_account record;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_equiv numeric(12,2);
  v_operation_date date;
  v_movement_id bigint;
  v_entries jsonb := '[]'::jsonb;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can dispatch a delivery';
  end if;

  if p_eta_minutes is not null
     and (p_eta_minutes < 1 or p_eta_minutes > 1440) then
    raise exception 'ETA must be between 1 and 1440 minutes';
  end if;

  p_expected_collection_lines := coalesce(p_expected_collection_lines, '[]'::jsonb);
  p_cash_change_lines := coalesce(p_cash_change_lines, '[]'::jsonb);
  p_digital_change_lines := coalesce(p_digital_change_lines, '[]'::jsonb);

  if jsonb_typeof(p_expected_collection_lines) <> 'array'
     or jsonb_array_length(p_expected_collection_lines) > 12
     or jsonb_typeof(p_cash_change_lines) <> 'array'
     or jsonb_array_length(p_cash_change_lines) > 12
     or jsonb_typeof(p_digital_change_lines) <> 'array'
     or jsonb_array_length(p_digital_change_lines) > 12 then
    raise exception 'Delivery settlement lines must be arrays with at most 12 lines each';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from (
        select line from jsonb_array_elements(p_expected_collection_lines) line
        union all
        select line from jsonb_array_elements(p_cash_change_lines) line
        union all
        select line from jsonb_array_elements(p_digital_change_lines) line
      ) combined
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every dispatch settlement line requires a unique non-empty line_key';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'eta_minutes', p_eta_minutes,
    'expected_collection_lines', p_expected_collection_lines,
    'cash_change_lines', p_cash_change_lines,
    'digital_change_lines', p_digital_change_lines,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'dispatch_delivery',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.fulfillment,
    order_row.status,
    order_row.delivery_mode,
    order_row.internal_driver_user_id,
    order_row.external_partner_id,
    order_row.external_driver_name,
    order_row.external_driver_phone,
    order_row.attributed_advisor_id,
    order_row.extra_fields
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.fulfillment <> 'delivery' then
    raise exception 'Only a delivery order can be dispatched';
  end if;

  if v_order.status <> 'ready' then
    raise exception 'Delivery can only be dispatched from ready';
  end if;

  v_delivery_mode := v_order.delivery_mode;
  if v_delivery_mode = 'internal' then
    if v_order.internal_driver_user_id is null then
      raise exception 'Delivery has no internal driver assigned';
    end if;

    select profile.full_name
    into v_responsible_name
    from public.profiles profile
    where profile.id = v_order.internal_driver_user_id;

    v_responsible_name := coalesce(
      nullif(btrim(v_responsible_name), ''),
      'Motorizado interno'
    );
  elsif v_delivery_mode = 'external' then
    select partner.name
    into v_responsible_name
    from public.delivery_partners partner
    where partner.id = v_order.external_partner_id;

    v_responsible_name := coalesce(
      nullif(btrim(v_order.external_driver_name), ''),
      nullif(btrim(v_responsible_name), ''),
      'Motorizado externo'
    );
    v_responsible_phone := nullif(btrim(v_order.external_driver_phone), '');
  else
    raise exception 'Delivery has no valid internal or external assignment';
  end if;

  if exists (
    select 1
    from public.delivery_settlements settlement
    where settlement.order_id = p_order_id
  ) then
    raise exception 'Delivery settlement already exists for this order';
  end if;

  for v_account_id in
    select distinct (line ->> 'money_account_id')::bigint
    from jsonb_array_elements(p_cash_change_lines) line
    order by (line ->> 'money_account_id')::bigint
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  insert into public.delivery_settlements (
    order_id,
    status,
    delivery_mode,
    responsible_user_id,
    responsible_partner_id,
    responsible_name,
    responsible_phone,
    dispatched_by_user_id,
    dispatched_at,
    notes
  ) values (
    p_order_id,
    'open',
    v_delivery_mode,
    case when v_delivery_mode = 'internal' then v_order.internal_driver_user_id else null end,
    case when v_delivery_mode = 'external' then v_order.external_partner_id else null end,
    v_responsible_name,
    v_responsible_phone,
    v_uid,
    v_now,
    nullif(btrim(p_notes), '')
  )
  returning id into v_settlement_id;

  for v_line in
    select line
    from jsonb_array_elements(p_expected_collection_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement_id,
      'expected_collection',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'expected_collection',
      'currency_code', v_currency,
      'amount', v_amount
    ));
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_digital_change_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement_id,
      'digital_change_due',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'digital_change_due',
      'currency_code', v_currency,
      'amount', v_amount
    ));
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_cash_change_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_account_id := (v_line ->> 'money_account_id')::bigint;
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_operation_date := coalesce(
      nullif(btrim(v_line ->> 'operation_date'), '')::date,
      (v_now at time zone 'America/Caracas')::date
    );

    select account.*
    into v_account
    from public.money_accounts account
    where account.id = v_account_id;

    if not v_account.is_active
       or v_account.currency_code <> v_currency
       or v_account.account_kind <> 'cash'
       or not public.is_counter_direct_money_account(v_account_id) then
      raise exception 'Cash change account % is not an active direct Counter cash account', v_account_id;
    end if;

    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

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
      v_operation_date,
      v_uid,
      v_now,
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
      nullif(btrim(v_line ->> 'reference_code'), ''),
      v_responsible_name,
      format('Cambio en custodia para delivery %s', v_order.order_number),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      p_order_id,
      null,
      p_idempotency_key
    )
    returning id into v_movement_id;

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
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
      v_settlement_id,
      'cash_change_out',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_movement_id,
      v_operation_date,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'cash_change_out',
      'currency_code', v_currency,
      'amount', v_amount,
      'movement_id', v_movement_id
    ));
  end loop;

  update public.orders
  set
    status = 'out_for_delivery',
    eta_minutes = p_eta_minutes,
    extra_fields = coalesce(extra_fields, '{}'::jsonb)
      || jsonb_build_object(
        'delivery',
        coalesce(extra_fields -> 'delivery', '{}'::jsonb)
          || jsonb_build_object(
            'eta_minutes', p_eta_minutes,
            'eta_recorded_at', v_now,
            'settlement_id', v_settlement_id
          )
      )
  where id = p_order_id;

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'out_for_delivery',
    v_uid,
    jsonb_build_object(
      'delivery_mode', v_delivery_mode,
      'responsible_name', v_responsible_name,
      'eta_minutes', p_eta_minutes,
      'delivery_settlement_id', v_settlement_id,
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
    p_order_id,
    v_order.order_number,
    'out_for_delivery',
    'delivery',
    'Orden en camino',
    case
      when p_eta_minutes is null
        then format('La orden salio con %s.', v_responsible_name)
      else format(
        'La orden salio con %s y ETA de %s min.',
        v_responsible_name,
        p_eta_minutes
      )
    end,
    'info',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement_id,
      'delivery_eta_minutes', p_eta_minutes,
      'settlement_entries', v_entries
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

  if v_order.internal_driver_user_id is not null
     and v_order.internal_driver_user_id is distinct from v_order.attributed_advisor_id then
    insert into public.order_timeline_event_recipients (
      event_id,
      target_role,
      target_user_id,
      requires_action
    ) values (
      v_event_id,
      null,
      v_order.internal_driver_user_id,
      false
    );
  end if;

  if jsonb_array_length(p_expected_collection_lines) = 0
     and jsonb_array_length(p_cash_change_lines) = 0 then
    update public.delivery_settlements
    set
      collection_finalized_by_user_id = v_uid,
      collection_finalized_at = v_now,
      updated_at = v_now
    where id = v_settlement_id;
  end if;

  v_settlement_status := public.counter_refresh_delivery_settlement_status(
    v_settlement_id,
    v_uid
  );

  v_result := jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_status', 'out_for_delivery',
    'delivery_settlement_id', v_settlement_id,
    'settlement_status', v_settlement_status,
    'entries', v_entries
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_record_delivery_return(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_customer_collection_lines jsonb default '[]'::jsonb,
  p_cash_return_lines jsonb default '[]'::jsonb,
  p_collection_final boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_order record;
  v_settlement public.delivery_settlements%rowtype;
  v_line jsonb;
  v_line_key text;
  v_account_id bigint;
  v_account record;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_operation_date date;
  v_reference text;
  v_equiv numeric(12,2);
  v_state record;
  v_duplicate record;
  v_report_id bigint;
  v_movement_id bigint;
  v_entries jsonb := '[]'::jsonb;
  v_settlement_status text;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_master_or_admin()
    or public.has_role('counter')
  ) then
    raise exception 'Only Counter or Master/Admin can record a delivery return';
  end if;

  p_customer_collection_lines := coalesce(p_customer_collection_lines, '[]'::jsonb);
  p_cash_return_lines := coalesce(p_cash_return_lines, '[]'::jsonb);

  if jsonb_typeof(p_customer_collection_lines) <> 'array'
     or jsonb_array_length(p_customer_collection_lines) > 12
     or jsonb_typeof(p_cash_return_lines) <> 'array'
     or jsonb_array_length(p_cash_return_lines) > 12 then
    raise exception 'Delivery return lines must be arrays with at most 12 lines each';
  end if;

  if jsonb_array_length(p_customer_collection_lines) = 0
     and jsonb_array_length(p_cash_return_lines) = 0
     and not p_collection_final then
    raise exception 'Delivery return must add a line or finalize collection';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from (
        select line from jsonb_array_elements(p_customer_collection_lines) line
        union all
        select line from jsonb_array_elements(p_cash_return_lines) line
      ) combined
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every delivery return line requires a unique non-empty line_key';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'customer_collection_lines', p_customer_collection_lines,
    'cash_return_lines', p_cash_return_lines,
    'collection_final', p_collection_final,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'record_delivery_return',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.status,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.status not in ('out_for_delivery', 'delivered') then
    raise exception 'Delivery return requires an order in transit or already delivered';
  end if;

  select settlement.*
  into v_settlement
  from public.delivery_settlements settlement
  where settlement.order_id = p_order_id
  for update;

  if not found then
    raise exception 'Delivery settlement not found';
  end if;

  if v_settlement.status = 'voided' then
    raise exception 'Voided delivery settlement cannot receive returns';
  end if;

  if v_settlement.status = 'settled' then
    raise exception 'Settled delivery cannot receive additional returns';
  end if;

  if p_collection_final and v_settlement.collection_finalized_at is not null then
    raise exception 'Delivery collection was already finalized';
  end if;

  if v_settlement.collection_finalized_at is not null
     and jsonb_array_length(p_customer_collection_lines) > 0 then
    raise exception 'Customer collection cannot change after it was finalized';
  end if;

  for v_account_id in
    select distinct (line ->> 'money_account_id')::bigint
    from jsonb_array_elements(p_cash_return_lines) line
    order by (line ->> 'money_account_id')::bigint
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_customer_collection_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
      currency_code,
      amount,
      exchange_rate_ves_per_usd,
      amount_usd_equivalent,
      reference_code,
      notes,
      created_by_user_id
    ) values (
      v_settlement.id,
      'customer_collection',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'customer_collection',
      'currency_code', v_currency,
      'amount', v_amount
    ));
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_cash_return_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_account_id := (v_line ->> 'money_account_id')::bigint;
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_operation_date := coalesce(
      nullif(btrim(v_line ->> 'operation_date'), '')::date,
      (v_now at time zone 'America/Caracas')::date
    );
    v_reference := nullif(btrim(v_line ->> 'reference_code'), '');

    select account.*
    into v_account
    from public.money_accounts account
    where account.id = v_account_id;

    if not v_account.is_active
       or v_account.currency_code <> v_currency
       or v_account.account_kind <> 'cash'
       or not public.is_counter_direct_money_account(v_account_id) then
      raise exception 'Cash return account % is not an active direct Counter cash account', v_account_id;
    end if;

    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

    if v_currency = 'VES' then
      select *
      into v_state
      from public.get_order_financial_state(
        p_order_id,
        v_operation_date,
        v_rate
      );

      if found and v_state.collection_mode = 'snapshot_quote' then
        if abs(v_amount - v_state.pending_bs) <= 0.01
           and v_state.pending_usd > 0.005 then
          v_equiv := round(v_state.pending_usd, 2);
        elsif v_amount < v_state.pending_bs
          and v_state.snapshot_rate_bs_per_usd > 0 then
          v_equiv := round(v_amount / v_state.snapshot_rate_bs_per_usd, 2);
        elsif abs(v_amount - v_state.total_bs) <= 0.01
          and v_state.total_usd > 0.005 then
          v_equiv := round(v_state.total_usd, 2);
        end if;
      end if;
    end if;

    if v_equiv <= 0 then
      raise exception 'Cash return line % rounds to an invalid USD equivalent', v_line_key;
    end if;

    select *
    into v_duplicate
    from public.find_active_payment_duplicate(
      v_account_id,
      v_operation_date,
      v_currency,
      v_amount,
      v_reference,
      null
    )
    limit 1;

    if found then
      raise exception
        'Possible duplicate delivery return payment on order %',
        coalesce(v_duplicate.order_number, '#' || v_duplicate.order_id::text);
    end if;

    insert into public.payment_reports (
      order_id,
      status,
      created_by_user_id,
      reported_currency_code,
      reported_amount,
      reported_exchange_rate_ves_per_usd,
      reported_amount_usd_equivalent,
      reported_money_account_id,
      reference_code,
      payer_name,
      notes,
      operation_date
    ) values (
      p_order_id,
      'pending',
      v_uid,
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_reference,
      v_settlement.responsible_name,
      coalesce(
        nullif(btrim(v_line ->> 'notes'), ''),
        nullif(btrim(p_notes), ''),
        'Retorno de efectivo de delivery'
      ),
      v_operation_date
    )
    returning id into v_report_id;

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
      v_operation_date,
      v_uid,
      v_now,
      v_uid,
      'confirmed',
      false,
      null,
      'inflow',
      'order_payment',
      v_account_id,
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_reference,
      v_settlement.responsible_name,
      format('Retorno delivery orden %s - linea %s', v_order.order_number, v_line_key),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      p_order_id,
      v_report_id,
      p_idempotency_key
    )
    returning id into v_movement_id;

    update public.payment_reports
    set
      status = 'confirmed',
      reviewed_at = v_now,
      reviewed_by_user_id = v_uid,
      review_notes = 'Efectivo de delivery recibido y confirmado por Counter.',
      confirmed_movement_id = v_movement_id
    where id = v_report_id;

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
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
      'cash_return',
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_movement_id,
      v_operation_date,
      v_reference,
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'cash_return',
      'currency_code', v_currency,
      'amount', v_amount,
      'report_id', v_report_id,
      'movement_id', v_movement_id
    ));
  end loop;

  if exists (
    with by_currency as (
      select
        entry.currency_code,
        coalesce(sum(entry.amount) filter (
          where entry.entry_type = 'customer_collection'
        ), 0) as collected,
        coalesce(sum(entry.amount) filter (
          where entry.entry_type = 'cash_return'
        ), 0) as returned
      from public.delivery_settlement_entries entry
      where entry.settlement_id = v_settlement.id
      group by entry.currency_code
    )
    select 1
    from by_currency
    where returned - collected > 0.009
  ) then
    raise exception 'Cash returned cannot exceed the amount reported as collected from the customer';
  end if;

  if p_collection_final then
    update public.delivery_settlements
    set
      collection_finalized_by_user_id = v_uid,
      collection_finalized_at = v_now,
      updated_at = v_now
    where id = v_settlement.id;
  end if;

  v_settlement_status := public.counter_refresh_delivery_settlement_status(
    v_settlement.id,
    v_uid
  );

  insert into public.order_events (
    order_id,
    event,
    performed_by,
    meta
  ) values (
    p_order_id,
    'delivery_cash_return_recorded',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement.id,
      'settlement_status', v_settlement_status,
      'collection_final', p_collection_final,
      'entries', v_entries,
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
    p_order_id,
    v_order.order_number,
    'delivery_cash_return_recorded',
    'delivery',
    'Retorno de delivery registrado',
    format(
      'Se registraron %s linea(s). Estado de liquidacion: %s.',
      jsonb_array_length(v_entries),
      v_settlement_status
    ),
    case
      when v_settlement_status = 'discrepancy' then 'warning'
      else 'info'
    end,
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement.id,
      'settlement_status', v_settlement_status,
      'collection_final', p_collection_final,
      'entries', v_entries
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
    v_settlement_status = 'discrepancy'
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
    'order_id', p_order_id,
    'delivery_settlement_id', v_settlement.id,
    'settlement_status', v_settlement_status,
    'collection_final', p_collection_final,
    'entries', v_entries
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;

create or replace function public.counter_complete_delivery_digital_change(
  p_idempotency_key uuid,
  p_order_id bigint,
  p_completion_lines jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_claim record;
  v_receipt_id bigint;
  v_request_payload jsonb;
  v_result jsonb;
  v_order record;
  v_settlement public.delivery_settlements%rowtype;
  v_line jsonb;
  v_line_key text;
  v_account_id bigint;
  v_account record;
  v_currency public.currency_code;
  v_amount numeric(12,2);
  v_rate numeric(18,6);
  v_operation_date date;
  v_equiv numeric(12,2);
  v_movement_id bigint;
  v_entries jsonb := '[]'::jsonb;
  v_settlement_status text;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_master_or_admin() then
    raise exception 'Only Master/Admin can confirm execution of digital change';
  end if;

  p_completion_lines := coalesce(p_completion_lines, '[]'::jsonb);
  if jsonb_typeof(p_completion_lines) <> 'array'
     or jsonb_array_length(p_completion_lines) < 1
     or jsonb_array_length(p_completion_lines) > 12 then
    raise exception 'completion_lines must contain between 1 and 12 lines';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(line ->> 'line_key'), '') as line_key, count(*) as uses
      from jsonb_array_elements(p_completion_lines) line
      group by nullif(btrim(line ->> 'line_key'), '')
    ) keys
    where keys.line_key is null or keys.uses > 1
  ) then
    raise exception 'Every digital change line requires a unique non-empty line_key';
  end if;

  v_request_payload := jsonb_build_object(
    'order_id', p_order_id,
    'completion_lines', p_completion_lines,
    'notes', p_notes
  );

  select *
  into v_claim
  from public.counter_claim_command(
    p_idempotency_key,
    'complete_delivery_digital_change',
    p_order_id,
    null,
    v_request_payload
  );

  if v_claim.existing_result is not null then
    return v_claim.existing_result;
  end if;
  v_receipt_id := v_claim.receipt_id;

  select
    order_row.id,
    order_row.order_number,
    order_row.status,
    order_row.attributed_advisor_id
  into v_order
  from public.orders order_row
  where order_row.id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  select settlement.*
  into v_settlement
  from public.delivery_settlements settlement
  where settlement.order_id = p_order_id
  for update;

  if not found or v_settlement.status = 'voided' then
    raise exception 'Active delivery settlement not found';
  end if;

  for v_account_id in
    select distinct (line ->> 'money_account_id')::bigint
    from jsonb_array_elements(p_completion_lines) line
    order by (line ->> 'money_account_id')::bigint
  loop
    perform account.id
    from public.money_accounts account
    where account.id = v_account_id
    for update;

    if not found then
      raise exception 'Money account % not found', v_account_id;
    end if;
  end loop;

  for v_line in
    select line
    from jsonb_array_elements(p_completion_lines) line
  loop
    v_line_key := btrim(v_line ->> 'line_key');
    v_account_id := (v_line ->> 'money_account_id')::bigint;
    v_currency := upper(btrim(v_line ->> 'currency_code'))::public.currency_code;
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_rate := case
      when v_currency = 'VES'
        then round((v_line ->> 'exchange_rate_ves_per_usd')::numeric, 6)
      else null
    end;
    v_operation_date := coalesce(
      nullif(btrim(v_line ->> 'operation_date'), '')::date,
      (v_now at time zone 'America/Caracas')::date
    );

    select account.*
    into v_account
    from public.money_accounts account
    where account.id = v_account_id;

    if not v_account.is_active
       or v_account.currency_code <> v_currency
       or v_account.account_kind not in ('bank', 'wallet') then
      raise exception 'Digital change account % must be an active bank or wallet account', v_account_id;
    end if;

    v_equiv := public.counter_amount_usd(v_currency, v_amount, v_rate);

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
      v_operation_date,
      v_uid,
      v_now,
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
      nullif(btrim(v_line ->> 'reference_code'), ''),
      null,
      format('Cambio digital delivery orden %s', v_order.order_number),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      p_order_id,
      null,
      p_idempotency_key
    )
    returning id into v_movement_id;

    insert into public.delivery_settlement_entries (
      settlement_id,
      entry_type,
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
      v_currency,
      v_amount,
      v_rate,
      v_equiv,
      v_account_id,
      v_movement_id,
      v_operation_date,
      nullif(btrim(v_line ->> 'reference_code'), ''),
      coalesce(nullif(btrim(v_line ->> 'notes'), ''), nullif(btrim(p_notes), '')),
      v_uid
    );

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'line_key', v_line_key,
      'entry_type', 'digital_change_completed',
      'currency_code', v_currency,
      'amount', v_amount,
      'movement_id', v_movement_id
    ));
  end loop;

  if exists (
    with by_currency as (
      select
        entry.currency_code,
        coalesce(sum(entry.amount) filter (
          where entry.entry_type = 'digital_change_due'
        ), 0) as due,
        coalesce(sum(entry.amount) filter (
          where entry.entry_type = 'digital_change_completed'
        ), 0) as completed
      from public.delivery_settlement_entries entry
      where entry.settlement_id = v_settlement.id
      group by entry.currency_code
    )
    select 1
    from by_currency
    where completed - due > 0.009
  ) then
    raise exception 'Completed digital change cannot exceed the recorded digital change due';
  end if;

  v_settlement_status := public.counter_refresh_delivery_settlement_status(
    v_settlement.id,
    v_uid
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
    'delivery_digital_change_completed',
    'delivery',
    'Cambio digital completado',
    format(
      'Master/Admin confirmo %s linea(s) de cambio digital.',
      jsonb_array_length(v_entries)
    ),
    'info',
    v_uid,
    jsonb_build_object(
      'delivery_settlement_id', v_settlement.id,
      'settlement_status', v_settlement_status,
      'entries', v_entries
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
    'order_id', p_order_id,
    'delivery_settlement_id', v_settlement.id,
    'settlement_status', v_settlement_status,
    'entries', v_entries
  );

  return public.counter_complete_command(v_receipt_id, v_result);
end;
$function$;
