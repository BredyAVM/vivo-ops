-- Read-only snapshot of installed routines on 2026-10-21, for isolated regression tests only.
CREATE OR REPLACE FUNCTION app_private.capture_order_payment_precision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_state record; v_basis record; v_allocation record; v_rate numeric; v_uid uuid:=auth.uid();
begin
  if new.status<>'confirmed' or new.direction<>'inflow' or new.movement_type<>'order_payment'
    or new.order_id is null then return new; end if;
  if tg_op='UPDATE' then
    if old.status='confirmed' then return new; end if;
    -- Historical confirmations retain their original accounting treatment.
    -- A voided precision payment cannot be silently resurrected or re-priced.
    if exists(select 1 from public.order_payment_precision_allocations a where a.movement_id=new.id) then
      raise exception 'Registra un nuevo pago; no se puede reactivar un pago anulado.' using errcode='22023';
    end if;
  end if;
  if v_uid is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  perform 1 from public.orders o where o.id=new.order_id for update;
  select * into v_basis from public.order_collection_precision_basis_v1(new.order_id);
  if not found then return new; end if;
  select * into v_state from public.get_order_financial_state(new.order_id,new.movement_date,new.exchange_rate_ves_per_usd);
  if not found then raise exception 'Order financial state unavailable'; end if;
  v_rate:=case when new.currency_code='USD' then 1
    when app_private.order_uses_current_usd_v1(new.order_id) then new.exchange_rate_ves_per_usd
    when v_state.delivery_reference_date is null or new.movement_date<=v_state.delivery_reference_date
      then v_state.snapshot_rate_bs_per_usd else new.exchange_rate_ves_per_usd end;
  select * into v_allocation from app_private.collection_payment_allocation_v1(
    v_state.pending_usd,v_state.pending_bs,new.currency_code::text,new.amount,v_rate,
    case when new.currency_code='USD' then 1 else new.exchange_rate_ves_per_usd end);
  insert into public.order_collection_precision_enrollments(order_id,created_by)
    values(new.order_id,v_uid) on conflict(order_id) do nothing;
  insert into public.order_payment_precision_allocations(
    movement_id,order_id,applied_usd,cash_equivalent_usd,rounding_usd,
    pending_before_usd,pending_before_bs,native_amount,currency_code,coverage_rate,operation_date,created_by
  ) values(new.id,new.order_id,v_allocation.applied_usd,new.amount_usd_equivalent,v_allocation.rounding_usd,
    v_state.pending_usd,v_state.pending_bs,new.amount,new.currency_code,v_rate,new.movement_date,v_uid);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.counter_apply_order_payments_block2(p_idempotency_key uuid, p_order_id bigint, p_payment_lines jsonb, p_overpayment_handling text DEFAULT NULL::text, p_change_lines jsonb DEFAULT '[]'::jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

CREATE OR REPLACE FUNCTION public.counter_apply_order_payments(p_idempotency_key uuid, p_order_id bigint, p_payment_lines jsonb, p_overpayment_handling text DEFAULT NULL::text, p_change_lines jsonb DEFAULT '[]'::jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_line jsonb;
  v_normalized_lines jsonb := '[]'::jsonb;
  v_method text;
  v_reference text;
  v_currency text;
  v_operation_date_raw text;
  v_operation_date date;
  v_rate numeric(18,6);
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
  if jsonb_typeof(p_payment_lines) <> 'array' then
    return public.counter_apply_order_payments_block4(
      p_idempotency_key,
      p_order_id,
      p_payment_lines,
      p_overpayment_handling,
      p_change_lines,
      p_notes
    );
  end if;

  for v_line in
    select line
    from jsonb_array_elements(p_payment_lines) line
  loop
    v_method := lower(btrim(v_line ->> 'payment_method'));
    v_reference := nullif(btrim(v_line ->> 'reference_code'), '');

    if v_method = 'pos' and coalesce(v_reference, '') !~ '^[0-9]{4}$' then
      raise exception 'Cada pago por punto requiere los ultimos cuatro digitos de la referencia.';
    end if;

    v_currency := upper(btrim(v_line ->> 'currency_code'));

    if v_currency <> 'VES' then
      v_normalized_lines := v_normalized_lines || jsonb_build_array(v_line);
      continue;
    end if;

    v_operation_date_raw := nullif(btrim(v_line ->> 'operation_date'), '');
    if v_operation_date_raw is null then
      v_operation_date := (now() at time zone 'America/Caracas')::date;
    elsif v_operation_date_raw ~ '^\d{4}-\d{2}-\d{2}$' then
      v_operation_date := v_operation_date_raw::date;
    else
      raise exception 'Indica una fecha de operacion valida en cada pago VES.';
    end if;

    select rate.rate_bs_per_usd
    into v_rate
    from public.exchange_rates rate
    where rate.effective_at < ((v_operation_date + 1)::timestamp at time zone 'America/Caracas')
    order by rate.effective_at desc, rate.id desc
    limit 1;

    if coalesce(v_rate, 0) <= 0 then
      raise exception 'No existe una tasa canonica para la fecha de operacion indicada.';
    end if;

    v_normalized_lines := v_normalized_lines || jsonb_build_array(
      jsonb_set(
        v_line,
        '{exchange_rate_ves_per_usd}',
        to_jsonb(round(v_rate, 6)),
        true
      )
    );
  end loop;

  return public.counter_apply_order_payments_block4(
    p_idempotency_key,
    p_order_id,
    v_normalized_lines,
    p_overpayment_handling,
    p_change_lines,
    p_notes
  );
end;
$function$;
