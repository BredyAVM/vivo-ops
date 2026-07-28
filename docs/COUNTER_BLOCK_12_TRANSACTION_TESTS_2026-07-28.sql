-- Counter Block 12 security-boundary verification.
--
-- Preconditions:
-- 1. COUNTER_BLOCK_12_CERTIFICATION_HARDENING_2026-07-28.sql is applied.
-- 2. At least one active user has Counter without Master/Admin.
--
-- The test is read-only and still runs inside a transaction for isolation.

begin;

select set_config(
  'counter.block12_user_id',
  (
    select roles.user_id::text
    from public.user_roles roles
    group by roles.user_id
    having bool_or(roles.role::text = 'counter')
       and not bool_or(roles.role::text in ('master', 'admin'))
    order by roles.user_id
    limit 1
  ),
  true
);

do $test$
begin
  if nullif(current_setting('counter.block12_user_id', true), '') is null then
    raise exception 'Missing Counter Block 12 test user';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.counter_dispatch_order(bigint,integer)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated still executes the obsolete dispatch RPC';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.counter_dispatch_delivery(uuid,bigint,integer,jsonb,jsonb,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated lost the canonical delivery RPC';
  end if;
end;
$test$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    current_setting('counter.block12_user_id'),
    'role',
    'authenticated'
  )::text,
  true
);

set local role authenticated;

do $test$
begin
  if not exists (
    select 1
    from public.money_accounts account
    where account.is_active = true
  ) then
    raise exception 'Counter has no configured direct money accounts';
  end if;

  if exists (
    select 1
    from public.money_accounts account
    where account.is_active = true
      and not public.is_counter_direct_money_account(account.id)
  ) then
    raise exception 'Counter can still read a non-operational money account';
  end if;

  perform public.counter_read_configuration();
end;
$test$;

reset role;

rollback;

-- Core operational smoke. Every fixture and ledger entry is rolled back.

begin;

do $test$
declare
  v_counter uuid;
  v_account bigint;
  v_client bigint;
  v_pickup bigint;
  v_old bigint;
  v_delivery bigint;
  v_key uuid := gen_random_uuid();
  v_complete_key uuid := gen_random_uuid();
  v_old_key uuid := gen_random_uuid();
  v_dispatch_key uuid := gen_random_uuid();
  v_return_one_key uuid := gen_random_uuid();
  v_return_two_key uuid := gen_random_uuid();
  v_result jsonb;
  v_retry jsonb;
  v_suffix text := txid_current()::text;
begin
  select roles.user_id
  into v_counter
  from public.user_roles roles
  group by roles.user_id
  having bool_or(roles.role::text = 'counter')
     and not bool_or(roles.role::text in ('master', 'admin'))
  order by roles.user_id
  limit 1;

  select account.id
  into v_account
  from public.money_accounts account
  where account.is_active = true
    and account.currency_code = 'USD'
    and account.account_kind = 'cash'
    and public.is_counter_direct_money_account(account.id)
  order by account.id
  limit 1;

  if v_counter is null or v_account is null then
    raise exception 'Missing Counter Block 12 flow prerequisites';
  end if;

  insert into public.clients (
    full_name,
    phone,
    client_type,
    is_active
  ) values (
    'Counter Block 12 rollback test',
    '+580012' || v_suffix,
    'own',
    true
  )
  returning id into v_client;

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
    'CB12-PICKUP-' || v_suffix,
    v_client,
    v_counter,
    'walk_in',
    'pickup',
    'ready',
    20,
    0,
    jsonb_build_object(
      'pricing',
      jsonb_build_object('total_usd', 20, 'total_bs', 0)
    )
  )
  returning id into v_pickup;

  perform set_config('request.jwt.claim.sub', v_counter::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_counter, 'role', 'authenticated')::text,
    true
  );

  v_result := public.counter_apply_order_payments(
    v_key,
    v_pickup,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'cash-25',
      'money_account_id', v_account,
      'payment_method', 'cash_usd',
      'currency_code', 'USD',
      'amount', 25,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    'change_given',
    jsonb_build_array(jsonb_build_object(
      'line_key', 'change-5',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 5
    )),
    'Block 12 payment and change smoke'
  );

  v_retry := public.counter_apply_order_payments(
    v_key,
    v_pickup,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'cash-25',
      'money_account_id', v_account,
      'payment_method', 'cash_usd',
      'currency_code', 'USD',
      'amount', 25,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    'change_given',
    jsonb_build_array(jsonb_build_object(
      'line_key', 'change-5',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 5
    )),
    'Block 12 payment and change smoke'
  );

  if v_result is distinct from v_retry then
    raise exception 'Payment retry changed its result';
  end if;

  if (
    select count(*)
    from public.money_movements
    where movement_group_id = v_key
  ) <> 2 then
    raise exception 'Payment retry duplicated or lost ledger movements';
  end if;

  v_result := public.counter_complete_pickup(
    v_complete_key,
    v_pickup,
    'Block 12 pickup completion'
  );
  v_retry := public.counter_complete_pickup(
    v_complete_key,
    v_pickup,
    'Block 12 pickup completion'
  );

  if v_result ->> 'status' <> 'delivered'
     or v_result is distinct from v_retry then
    raise exception 'Pickup completion or retry failed';
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
    'CB12-OLD-' || v_suffix,
    v_client,
    v_counter,
    'walk_in',
    'pickup',
    'delivered',
    10,
    0,
    jsonb_build_object(
      'pricing',
      jsonb_build_object('total_usd', 10, 'total_bs', 0)
    )
  )
  returning id into v_old;

  v_result := public.counter_apply_order_payments(
    v_old_key,
    v_old,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'old-cash-10',
      'money_account_id', v_account,
      'payment_method', 'cash_usd',
      'currency_code', 'USD',
      'amount', 10,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    null,
    '[]'::jsonb,
    'Block 12 delivered-order payment'
  );

  if coalesce((v_result ->> 'pending_usd')::numeric, 0) <> 0 then
    raise exception 'Delivered order payment did not settle the balance';
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
    'CB12-DELIVERY-' || v_suffix,
    v_client,
    v_counter,
    'walk_in',
    'delivery',
    'internal',
    v_counter,
    'ready',
    37,
    0,
    jsonb_build_object(
      'pricing',
      jsonb_build_object('total_usd', 37, 'total_bs', 0)
    )
  )
  returning id into v_delivery;

  v_result := public.counter_dispatch_delivery(
    v_dispatch_key,
    v_delivery,
    10,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'collect-50',
      'currency_code', 'USD',
      'amount', 50
    )),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'cash-change-13',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 13
    )),
    '[]'::jsonb,
    'Block 12 delivery smoke'
  );

  if v_result ->> 'settlement_status' <> 'open'
     or (
       select status::text
       from public.orders
       where id = v_delivery
     ) <> 'out_for_delivery'
     or (
       select count(*)
       from public.delivery_settlements
       where order_id = v_delivery
     ) <> 1 then
    raise exception 'Canonical delivery dispatch did not open custody atomically';
  end if;

  v_result := public.counter_record_delivery_return(
    v_return_one_key,
    v_delivery,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'collected-50',
      'currency_code', 'USD',
      'amount', 50
    )),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'return-30',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 30,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    false,
    'Block 12 partial return'
  );

  if v_result ->> 'settlement_status' <> 'partial' then
    raise exception 'Partial delivery return did not stay open';
  end if;

  v_result := public.counter_record_delivery_return(
    v_return_two_key,
    v_delivery,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'return-20',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 20,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    true,
    'Block 12 final return'
  );
  v_retry := public.counter_record_delivery_return(
    v_return_two_key,
    v_delivery,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'line_key', 'return-20',
      'money_account_id', v_account,
      'currency_code', 'USD',
      'amount', 20,
      'operation_date', (now() at time zone 'America/Caracas')::date
    )),
    true,
    'Block 12 final return'
  );

  if v_result ->> 'settlement_status' <> 'settled'
     or v_result is distinct from v_retry then
    raise exception 'Final delivery settlement or retry failed';
  end if;
end;
$test$;

select jsonb_build_object(
  'payment_change_idempotency', true,
  'pickup_completion', true,
  'delivered_order_payment', true,
  'delivery_custody_partial_final', true
) as block12_flow_smoke;

rollback;
