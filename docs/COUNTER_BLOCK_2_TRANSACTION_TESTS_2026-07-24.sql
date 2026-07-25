-- Counter Block 2 transactional verification.
--
-- Preconditions:
-- 1. COUNTER_BLOCK_2_ATOMIC_PERSISTENCE_2026-07-24.sql is applied.
-- 2. The project has a pure Counter user, a Master/Admin user and an active
--    direct Counter USD cash account with a closure baseline.
--
-- The entire test runs inside one transaction and ends with ROLLBACK.

begin;

do $test$
declare
  v_counter_id uuid;
  v_supervisor_id uuid;
  v_account_id bigint;
  v_client_id bigint;
  v_pickup_order_id bigint;
  v_rollback_order_id bigint;
  v_delivery_order_id bigint;
  v_payment_key uuid := gen_random_uuid();
  v_payment_result jsonb;
  v_payment_retry jsonb;
  v_before_reports bigint;
  v_after_reports bigint;
  v_failed boolean := false;
  v_manual_key uuid := gen_random_uuid();
  v_manual_result jsonb;
  v_expense_key uuid := gen_random_uuid();
  v_expense_result jsonb;
  v_expense_group_id uuid;
  v_decision_key uuid := gen_random_uuid();
  v_decision_result jsonb;
  v_refund_request_key uuid := gen_random_uuid();
  v_refund_request jsonb;
  v_refund_group_id uuid;
  v_refund_decision_key uuid := gen_random_uuid();
  v_refund_execution_key uuid := gen_random_uuid();
  v_refund_execution jsonb;
  v_dispatch_key uuid := gen_random_uuid();
  v_dispatch_result jsonb;
  v_first_return_key uuid := gen_random_uuid();
  v_second_return_key uuid := gen_random_uuid();
  v_first_return jsonb;
  v_second_return jsonb;
  v_second_return_retry jsonb;
  v_first_closure_key uuid := gen_random_uuid();
  v_second_closure_key uuid := gen_random_uuid();
  v_post_closure_movement_key uuid := gen_random_uuid();
  v_first_closure_at timestamptz;
  v_second_closure_at timestamptz;
  v_anchor_at timestamptz;
  v_opening_amount numeric(12,2);
  v_opening_usd numeric(12,2);
  v_first_expected numeric(12,2);
  v_first_expected_usd numeric(12,2);
  v_first_closure jsonb;
  v_second_closure jsonb;
  v_second_closure_retry jsonb;
  v_test_suffix text := txid_current()::text;
begin
  select roles.user_id
  into v_counter_id
  from public.user_roles roles
  group by roles.user_id
  having bool_or(roles.role::text = 'counter')
     and not bool_or(roles.role::text in ('master', 'admin'))
  order by roles.user_id
  limit 1;

  select roles.user_id
  into v_supervisor_id
  from public.user_roles roles
  where roles.role::text in ('master', 'admin')
  order by case when roles.role::text = 'master' then 0 else 1 end, roles.user_id
  limit 1;

  select account.id
  into v_account_id
  from public.money_accounts account
  where account.is_active = true
    and account.currency_code = 'USD'
    and account.account_kind = 'cash'
    and public.is_counter_direct_money_account(account.id)
    and exists (
      select 1
      from public.money_account_closure_baselines baseline
      where baseline.money_account_id = account.id
        and baseline.status = 'active'
    )
  order by account.id
  limit 1;

  if v_counter_id is null or v_supervisor_id is null or v_account_id is null then
    raise exception 'Missing Counter Block 2 test prerequisites';
  end if;

  insert into public.clients (
    full_name,
    phone,
    client_type,
    is_active
  ) values (
    'Counter Block 2 Test',
    '+580000' || v_test_suffix,
    'own',
    true
  )
  returning id into v_client_id;

  insert into public.orders (
    order_number,
    client_id,
    created_by_user_id,
    source,
    fulfillment,
    status,
    total_usd,
    total_bs_snapshot,
    extra_fields
  ) values (
    'CB2-PAY-' || v_test_suffix,
    v_client_id,
    v_counter_id,
    'walk_in',
    'pickup',
    'ready',
    20,
    0,
    jsonb_build_object('pricing', jsonb_build_object('total_usd', 20, 'total_bs', 0))
  )
  returning id into v_pickup_order_id;

  perform set_config('request.jwt.claim.sub', v_counter_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter_id, 'role', 'authenticated')::text,
    true
  );

  v_payment_result := public.counter_apply_order_payments(
    v_payment_key,
    v_pickup_order_id,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'payment-usd',
      'money_account_id', v_account_id,
      'payment_method', 'cash_usd',
      'currency_code', 'USD',
      'amount', 25,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    'change_given',
    jsonb_build_array(jsonb_build_object(
      'line_key', 'change-usd',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 5
    )),
    'Atomic payment test'
  );

  v_payment_retry := public.counter_apply_order_payments(
    v_payment_key,
    v_pickup_order_id,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'payment-usd',
      'money_account_id', v_account_id,
      'payment_method', 'cash_usd',
      'currency_code', 'USD',
      'amount', 25,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    'change_given',
    jsonb_build_array(jsonb_build_object(
      'line_key', 'change-usd',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 5
    )),
    'Atomic payment test'
  );

  if v_payment_result is distinct from v_payment_retry then
    raise exception 'Idempotent payment retry returned a different result';
  end if;

  if (
    select count(*)
    from public.money_movements movement
    where movement.movement_group_id = v_payment_key
  ) <> 2 then
    raise exception 'Idempotent payment retry duplicated or lost ledger movements';
  end if;

  insert into public.orders (
    order_number,
    client_id,
    created_by_user_id,
    source,
    fulfillment,
    status,
    total_usd,
    total_bs_snapshot,
    extra_fields
  ) values (
    'CB2-ROLLBACK-' || v_test_suffix,
    v_client_id,
    v_counter_id,
    'walk_in',
    'pickup',
    'ready',
    100,
    0,
    jsonb_build_object('pricing', jsonb_build_object('total_usd', 100, 'total_bs', 0))
  )
  returning id into v_rollback_order_id;

  select count(*)
  into v_before_reports
  from public.payment_reports report
  where report.order_id = v_rollback_order_id;

  begin
    perform public.counter_apply_order_payments(
      gen_random_uuid(),
      v_rollback_order_id,
      jsonb_build_array(
        jsonb_build_object(
          'line_key', 'valid-first-line',
          'money_account_id', v_account_id,
          'payment_method', 'cash_usd',
          'currency_code', 'USD',
          'amount', 10,
          'operation_date', (now() at time zone 'America/Caracas')::date
        ),
        jsonb_build_object(
          'line_key', 'invalid-second-line',
          'money_account_id', v_account_id,
          'payment_method', 'cash_usd',
          'currency_code', 'VES',
          'amount', 10,
          'exchange_rate_ves_per_usd', 100,
          'operation_date', (now() at time zone 'America/Caracas')::date
        )
      ),
      null,
      '[]'::jsonb,
      'Rollback test'
    );
  exception
    when others then
      v_failed := true;
  end;

  if not v_failed then
    raise exception 'Invalid second payment line did not fail';
  end if;

  select count(*)
  into v_after_reports
  from public.payment_reports report
  where report.order_id = v_rollback_order_id;

  if v_after_reports <> v_before_reports then
    raise exception 'Failed mixed payment left a partial payment report';
  end if;

  v_manual_result := public.counter_record_manual_movement(
    v_manual_key,
    'inflow',
    v_account_id,
    5,
    (now() at time zone 'America/Caracas')::date,
    null,
    null,
    'Counter Block 2 Test',
    'Test manual inflow',
    null
  );

  if v_manual_result ->> 'status' <> 'confirmed' then
    raise exception 'Authorized small manual movement was not confirmed';
  end if;

  if v_manual_result is distinct from public.counter_record_manual_movement(
    v_manual_key,
    'inflow',
    v_account_id,
    5,
    (now() at time zone 'America/Caracas')::date,
    null,
    null,
    'Counter Block 2 Test',
    'Test manual inflow',
    null
  ) then
    raise exception 'Manual movement retry returned a different result';
  end if;

  v_expense_result := public.counter_record_manual_movement(
    v_expense_key,
    'outflow',
    v_account_id,
    25,
    (now() at time zone 'America/Caracas')::date,
    null,
    null,
    'Counter Block 2 Test',
    'Expense above Counter limit',
    null
  );
  v_expense_group_id :=
    (v_expense_result ->> 'movement_group_id')::uuid;

  if v_expense_result ->> 'status' <> 'pending'
     or v_expense_group_id is distinct from v_expense_key then
    raise exception 'Expense above USD 20 did not request authorization';
  end if;

  perform set_config('request.jwt.claim.sub', v_supervisor_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_supervisor_id, 'role', 'authenticated')::text,
    true
  );

  v_decision_result := public.counter_decide_authorization(
    v_decision_key,
    v_expense_group_id,
    'approve',
    'Counter Block 2 test approval'
  );

  if v_decision_result ->> 'status' <> 'executed' then
    raise exception 'Approved over-limit expense was not confirmed atomically';
  end if;

  perform set_config('request.jwt.claim.sub', v_counter_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter_id, 'role', 'authenticated')::text,
    true
  );

  v_refund_request := public.counter_request_refund(
    v_refund_request_key,
    v_pickup_order_id,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'refund-usd',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 2
    )),
    'Counter Block 2 refund test'
  );
  v_refund_group_id :=
    (v_refund_request ->> 'movement_group_id')::uuid;

  if v_refund_request ->> 'status' <> 'pending'
     or v_refund_group_id is distinct from v_refund_request_key then
    raise exception 'Refund request did not persist a pending movement group';
  end if;

  perform set_config('request.jwt.claim.sub', v_supervisor_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_supervisor_id, 'role', 'authenticated')::text,
    true
  );

  perform public.counter_decide_authorization(
    v_refund_decision_key,
    v_refund_group_id,
    'approve',
    'Refund approved for transaction test'
  );

  perform set_config('request.jwt.claim.sub', v_counter_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter_id, 'role', 'authenticated')::text,
    true
  );

  v_refund_execution := public.counter_execute_refund(
    v_refund_execution_key,
    v_refund_group_id,
    (now() at time zone 'America/Caracas')::date,
    'Refund execution test'
  );

  if v_refund_execution ->> 'status' <> 'executed' then
    raise exception 'Approved refund was not executed';
  end if;

  insert into public.orders (
    order_number,
    client_id,
    created_by_user_id,
    source,
    fulfillment,
    delivery_mode,
    internal_driver_user_id,
    status,
    total_usd,
    total_bs_snapshot,
    extra_fields
  ) values (
    'CB2-DELIVERY-' || v_test_suffix,
    v_client_id,
    v_counter_id,
    'walk_in',
    'delivery',
    'internal',
    v_counter_id,
    'ready',
    37,
    0,
    jsonb_build_object('pricing', jsonb_build_object('total_usd', 37, 'total_bs', 0))
  )
  returning id into v_delivery_order_id;

  v_dispatch_result := public.counter_dispatch_delivery(
    v_dispatch_key,
    v_delivery_order_id,
    10,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'expected-usd-50',
      'currency_code', 'USD',
      'amount', 50
    )),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'cash-change-usd-13',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 13
    )),
    '[]'::jsonb,
    'Delivery custody test'
  );

  if v_dispatch_result ->> 'settlement_status' <> 'open' then
    raise exception 'Delivery settlement did not open at dispatch';
  end if;

  v_first_return := public.counter_record_delivery_return(
    v_first_return_key,
    v_delivery_order_id,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'customer-collected-usd-50',
      'currency_code', 'USD',
      'amount', 50
    )),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'first-return-usd-30',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 30,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    false,
    'First partial driver return'
  );

  if v_first_return ->> 'settlement_status' <> 'partial' then
    raise exception 'Partial driver return did not keep the settlement open';
  end if;

  v_second_return := public.counter_record_delivery_return(
    v_second_return_key,
    v_delivery_order_id,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'second-return-usd-20',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 20,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    true,
    'Final driver return on a later shift'
  );

  v_second_return_retry := public.counter_record_delivery_return(
    v_second_return_key,
    v_delivery_order_id,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'second-return-usd-20',
      'money_account_id', v_account_id,
      'currency_code', 'USD',
      'amount', 20,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    true,
    'Final driver return on a later shift'
  );

  if v_second_return ->> 'settlement_status' <> 'settled'
     or v_second_return is distinct from v_second_return_retry then
    raise exception 'Final delivery settlement or its idempotent retry failed';
  end if;

  v_first_closure_at := clock_timestamp();

  select
    closure.closure_at,
    closure.counted_amount,
    closure.counted_amount_usd
  into v_anchor_at, v_opening_amount, v_opening_usd
  from public.money_account_closures closure
  where closure.money_account_id = v_account_id
    and closure.status in ('recorded', 'approved')
    and closure.closure_at < v_first_closure_at
  order by closure.closure_at desc, closure.created_at desc, closure.id desc
  limit 1;

  if not found then
    select
      baseline.baseline_at,
      baseline.counted_amount,
      baseline.counted_amount_usd
    into v_anchor_at, v_opening_amount, v_opening_usd
    from public.money_account_closure_baselines baseline
    where baseline.money_account_id = v_account_id
      and baseline.status = 'active'
      and baseline.baseline_at <= v_first_closure_at
    order by baseline.baseline_at desc, baseline.created_at desc, baseline.id desc
    limit 1;
  end if;

  select
    round(v_opening_amount + coalesce(sum(
      case when movement.direction = 'inflow' then movement.amount else -movement.amount end
    ), 0), 2),
    round(v_opening_usd + coalesce(sum(
      case
        when movement.direction = 'inflow' then movement.amount_usd_equivalent
        else -movement.amount_usd_equivalent
      end
    ), 0), 2)
  into v_first_expected, v_first_expected_usd
  from public.money_movements movement
  where movement.money_account_id = v_account_id
    and movement.status = 'confirmed'
    and movement.movement_date <= (v_first_closure_at at time zone 'America/Caracas')::date
    and coalesce(movement.confirmed_at, movement.created_at) > v_anchor_at
    and coalesce(movement.confirmed_at, movement.created_at) <= v_first_closure_at;

  v_first_closure := public.counter_close_money_account(
    v_first_closure_key,
    v_account_id,
    v_first_closure_at,
    v_first_expected,
    null,
    'First same-day closure test',
    null
  );

  perform public.counter_record_manual_movement(
    v_post_closure_movement_key,
    'inflow',
    v_account_id,
    1,
    (now() at time zone 'America/Caracas')::date,
    null,
    null,
    'Counter Block 2 Test',
    'Movement after same-day closure',
    null
  );

  v_second_closure_at := clock_timestamp();
  v_second_closure := public.counter_close_money_account(
    v_second_closure_key,
    v_account_id,
    v_second_closure_at,
    v_first_expected + 1,
    null,
    'Second same-day closure test',
    null
  );

  v_second_closure_retry := public.counter_close_money_account(
    v_second_closure_key,
    v_account_id,
    v_second_closure_at,
    v_first_expected + 1,
    null,
    'Second same-day closure test',
    null
  );

  if (v_second_closure ->> 'expected_amount')::numeric <> v_first_expected + 1 then
    raise exception 'Second same-day closure omitted the post-closure movement';
  end if;

  if v_second_closure is distinct from v_second_closure_retry then
    raise exception 'Closure retry returned a different result';
  end if;
end;
$test$;

rollback;
