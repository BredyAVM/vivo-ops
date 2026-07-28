-- Counter Block 9 transactional verification.
-- Requires the Block 9 migration definitions and always rolls data back.

begin;

do $test$
declare
  v_snapshot jsonb;
  v_ids bigint[];
  v_rejected boolean := false;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
    true
  );

  v_snapshot := public.counter_read_cash_snapshot(2);
  select array_agg((entry ->> 'accountId')::bigint order by (entry ->> 'accountId')::bigint)
  into v_ids
  from jsonb_array_elements(v_snapshot) entry;

  if v_ids <> array[2, 4, 7, 10, 11]::bigint[] then
    raise exception 'Unexpected Counter direct accounts: %', v_ids;
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"74d6bc21-b6cc-42ef-8f4c-ec47dc5d411d","role":"authenticated"}',
    true
  );
  begin
    perform public.counter_read_cash_snapshot(2);
  exception
    when sqlstate '42501' then
      v_rejected := true;
  end;

  if not v_rejected then
    raise exception 'Advisor unexpectedly read Counter cash';
  end if;
end;
$test$;

do $test$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_before numeric;
  v_after numeric;
  v_result jsonb;
  v_retry jsonb;
  v_rejected boolean;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
    true
  );

  select (entry ->> 'balance')::numeric
  into v_before
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;

  v_result := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000001',
    'outflow',
    7,
    5,
    v_today,
    null,
    'B9-LOW',
    'Proveedor prueba',
    'Gasto menor prueba B9',
    null
  );
  if v_result ->> 'status' <> 'confirmed' then
    raise exception 'Expense at or below limit was not confirmed: %', v_result;
  end if;

  v_retry := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000001',
    'outflow',
    7,
    5,
    v_today,
    null,
    'B9-LOW',
    'Proveedor prueba',
    'Gasto menor prueba B9',
    null
  );
  if v_retry ->> 'movement_id' <> v_result ->> 'movement_id' then
    raise exception 'Manual movement idempotency failed';
  end if;

  select (entry ->> 'balance')::numeric
  into v_after
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;
  if v_after <> v_before - 5 then
    raise exception 'Confirmed expense not reflected exactly: before %, after %', v_before, v_after;
  end if;

  v_result := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000002',
    'outflow',
    7,
    21,
    v_today,
    null,
    'B9-HIGH',
    'Proveedor prueba',
    'Gasto mayor prueba B9',
    null
  );
  if v_result ->> 'status' <> 'pending' then
    raise exception 'Expense over limit was not pending: %', v_result;
  end if;

  select (entry ->> 'balance')::numeric
  into v_after
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;
  if v_after <> v_before - 5 then
    raise exception 'Pending expense changed balance';
  end if;

  v_rejected := false;
  begin
    perform public.counter_record_manual_movement(
      '99000000-0000-4000-8000-000000000003',
      'inflow',
      4,
      1,
      v_today,
      1,
      'B9-POS',
      null,
      'POS manual no permitido',
      null
    );
  exception
    when others then
      v_rejected := position('limited to DAR cash' in sqlerrm) > 0;
  end;
  if not v_rejected then
    raise exception 'Counter unexpectedly created a manual POS movement';
  end if;

  v_rejected := false;
  begin
    perform public.counter_record_manual_movement(
      '99000000-0000-4000-8000-000000000004',
      'outflow',
      1,
      1,
      v_today,
      1,
      'B9-BANK',
      null,
      'Banco no permitido',
      null
    );
  exception
    when others then
      v_rejected := position('active DAR cash and POS' in sqlerrm) > 0;
  end;
  if not v_rejected then
    raise exception 'Counter unexpectedly operated an administrative bank';
  end if;

  v_rejected := false;
  begin
    perform public.counter_record_manual_movement(
      '99000000-0000-4000-8000-000000000005',
      'outflow',
      7,
      1,
      v_today - 1,
      null,
      'B9-DATE',
      null,
      'Fecha anterior no permitida',
      null
    );
  exception
    when others then
      v_rejected := position('current Caracas business date' in sqlerrm) > 0;
  end;
  if not v_rejected then
    raise exception 'Counter unexpectedly backdated a manual movement';
  end if;
end;
$test$;

do $test$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_rate numeric;
  v_result jsonb;
  v_before numeric;
  v_after numeric;
begin
  select rate_bs_per_usd
  into v_rate
  from public.exchange_rates
  where is_active and rate_bs_per_usd > 0
  order by effective_at desc, id desc
  limit 1;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
    true
  );

  select (entry ->> 'balance')::numeric
  into v_before
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 2;

  v_result := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000006',
    'outflow',
    2,
    round(v_rate * 21, 2),
    v_today,
    1,
    'B9-VES',
    null,
    'Gasto VES mayor prueba B9',
    null
  );
  if v_result ->> 'status' <> 'pending'
     or abs((v_result ->> 'exchange_rate_ves_per_usd')::numeric - v_rate) > 0.000001 then
    raise exception 'VES movement did not use the active server rate: %', v_result;
  end if;

  select (entry ->> 'balance')::numeric
  into v_after
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 2;
  if v_after <> v_before then
    raise exception 'Pending VES expense changed balance';
  end if;
end;
$test$;

do $test$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_result jsonb;
  v_before numeric;
  v_after numeric;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"58a6f1cf-0195-4d44-880c-6e68999e0240","role":"authenticated"}',
    true
  );

  v_result := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000007',
    'outflow',
    7,
    12,
    v_today,
    null,
    'B9-SPLIT-A',
    null,
    'Primera parte prueba',
    null
  );
  if v_result ->> 'status' <> 'confirmed' then
    raise exception 'First split test expense was not confirmed: %', v_result;
  end if;

  select (entry ->> 'balance')::numeric
  into v_before
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;

  v_result := public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000008',
    'outflow',
    7,
    9,
    v_today,
    null,
    'B9-SPLIT-B',
    null,
    'Segunda parte prueba',
    null
  );
  if v_result ->> 'status' <> 'pending' then
    raise exception 'Split expense was not held for approval: %', v_result;
  end if;

  select (entry ->> 'balance')::numeric
  into v_after
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;
  if v_after <> v_before then
    raise exception 'Pending split expense changed balance';
  end if;
end;
$test$;

do $test$
declare
  v_rejected boolean := false;
  v_result jsonb;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"833e2079-6bc7-4708-aa9f-1b25ac20a911","role":"authenticated"}',
    true
  );
  begin
    perform public.counter_decide_authorization(
      '99000000-0000-4000-8000-000000000009',
      '99000000-0000-4000-8000-000000000002',
      'approve',
      'Master no debe aprobar gasto manual'
    );
  exception
    when others then
      v_rejected := position('Only Administration' in sqlerrm) > 0;
  end;
  if not v_rejected then
    raise exception 'Master unexpectedly approved a Counter manual expense';
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"8c296814-8b98-48d4-8db1-ce27b4c808eb","role":"authenticated"}',
    true
  );
  v_result := public.counter_decide_authorization(
    '99000000-0000-4000-8000-000000000010',
    '99000000-0000-4000-8000-000000000002',
    'approve',
    'Aprobación administrativa de prueba'
  );
  if v_result ->> 'status' <> 'executed' then
    raise exception 'Administration did not confirm the pending expense: %', v_result;
  end if;
end;
$test$;

do $test$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_page_one jsonb;
  v_page_two jsonb;
  v_cursor jsonb;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
    true
  );

  perform public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000011',
    'inflow',
    7,
    1,
    v_today,
    null,
    'B9-PAGE-1',
    null,
    'Página uno prueba',
    null
  );
  perform public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000012',
    'inflow',
    7,
    2,
    v_today,
    null,
    'B9-PAGE-2',
    null,
    'Página dos prueba',
    null
  );
  perform public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000013',
    'inflow',
    7,
    3,
    v_today,
    null,
    'B9-PAGE-3',
    null,
    'Página tres prueba',
    null
  );

  v_page_one := public.counter_read_cash_movements(7, null, null, 2);
  v_cursor := v_page_one -> 'nextCursor';
  if jsonb_array_length(v_page_one -> 'results') <> 2 or v_cursor is null then
    raise exception 'First cash movement page is invalid: %', v_page_one;
  end if;

  v_page_two := public.counter_read_cash_movements(
    7,
    (v_cursor ->> 'createdAt')::timestamptz,
    (v_cursor ->> 'id')::bigint,
    2
  );
  if exists (
    select 1
    from jsonb_array_elements(v_page_one -> 'results') first_page
    join jsonb_array_elements(v_page_two -> 'results') second_page
      on first_page ->> 'id' = second_page ->> 'id'
  ) then
    raise exception 'Cash movement pages overlap';
  end if;
end;
$test$;

do $test$
declare
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_expected numeric;
  v_after numeric;
  v_at timestamptz;
  v_key uuid := '99000000-0000-4000-8000-000000000014';
  v_result jsonb;
  v_retry jsonb;
  v_rejected boolean := false;
  v_movements_before bigint;
  v_movements_after bigint;
  v_rate numeric;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"0e4553ea-9050-452c-94e7-07a81a771135","role":"authenticated"}',
    true
  );

  select (entry ->> 'closureExpectedAmount')::numeric
  into v_expected
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;

  v_at := clock_timestamp();
  select count(*) into v_movements_before from public.money_movements;
  v_result := public.counter_close_money_account(
    v_key,
    7,
    v_at,
    v_expected,
    null,
    'Prueba cierre B9',
    null
  );
  v_retry := public.counter_close_money_account(
    v_key,
    7,
    v_at,
    v_expected,
    null,
    'Prueba cierre B9',
    null
  );
  select count(*) into v_movements_after from public.money_movements;
  if v_result ->> 'closure_id' <> v_retry ->> 'closure_id'
     or (v_result ->> 'difference_amount')::numeric <> 0
     or v_movements_before <> v_movements_after then
    raise exception 'Cash closure was not exact/idempotent or created money: %, %', v_result, v_retry;
  end if;

  perform public.counter_record_manual_movement(
    '99000000-0000-4000-8000-000000000015',
    'inflow',
    7,
    2,
    v_today,
    null,
    'B9-AFTER-CLOSE',
    null,
    'Movimiento posterior al cierre',
    null
  );
  select (entry ->> 'balance')::numeric
  into v_after
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 7;
  if v_after <> v_expected + 2 then
    raise exception 'Same-day post-closure movement was lost: expected %, found %', v_expected + 2, v_after;
  end if;

  begin
    perform public.counter_close_money_account(
      '99000000-0000-4000-8000-000000000016',
      7,
      clock_timestamp(),
      v_after + 1,
      null,
      'Diferencia no permitida',
      null
    );
  exception
    when others then
      v_rejected := position('requires zero difference' in sqlerrm) > 0;
  end;
  if not v_rejected then
    raise exception 'Non-zero cash closure unexpectedly succeeded';
  end if;

  select rate_bs_per_usd
  into v_rate
  from public.exchange_rates
  where is_active and rate_bs_per_usd > 0
  order by effective_at desc, id desc
  limit 1;
  select (entry ->> 'closureExpectedAmount')::numeric
  into v_expected
  from jsonb_array_elements(public.counter_read_cash_snapshot(2)) entry
  where (entry ->> 'accountId')::bigint = 11;

  select count(*) into v_movements_before from public.money_movements;
  v_result := public.counter_close_money_account(
    '99000000-0000-4000-8000-000000000017',
    11,
    clock_timestamp(),
    v_expected,
    v_rate,
    'Prueba cierre POS B9',
    null
  );
  select count(*) into v_movements_after from public.money_movements;
  if (v_result ->> 'difference_amount')::numeric <> 0
     or v_movements_before <> v_movements_after then
    raise exception 'POS closure created a transfer or did not close at zero: %', v_result;
  end if;
end;
$test$;

rollback;
