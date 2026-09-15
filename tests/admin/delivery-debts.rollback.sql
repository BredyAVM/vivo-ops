-- Synthetic fixtures only. Append to migration without COMMIT; ALWAYS ROLLBACK.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_accounts(id,name,currency_code,account_kind,is_active) values
  (9000020001,'TEST DEBT USD','USD','cash',true),(9000020002,'TEST DEBT VES','VES','bank',true);
insert into public.delivery_partners(id,name,partner_type,is_active) values
  (9000020001,'TEST DEBT PARTNER','company_dispatch',true),(9000020002,'TEST DEBT OTHER','company_dispatch',true);
insert into public.clients(id,full_name) values(9000020001,'TEST DEBT CLIENT');
insert into public.products(id,name,base_price_usd,base_price_bs,source_price_currency,source_price_amount,is_inventory_item)
values(9000020001,'TEST DEBT PRODUCT',2.61,2200,'VES',2200,false);
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
values(9000020001,'TEST PURCHASE','master','pickup','delivered',9000020001,2.61,2200,
  '{"pricing":{"total_usd":2.61,"total_bs":2200,"fx_rate":842.21},"schedule":{"date":"2026-09-01"}}');
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
values(9000020001,9000020001,9000020001,1,2.61,2.61,'TEST DEBT PRODUCT','VES',2200,2200,2200);
insert into public.orders(id,order_number,source,fulfillment,status,external_partner_id,delivery_mode,extra_fields)
values(9000020002,'TEST DELIVERY ZERO','master','delivery','delivered',9000020001,'external','{"delivery":{"cost_usd":5,"confirmed_delivery_date":"2026-09-10"}}');
set local role authenticated;
do $$
declare d uuid:='00000000-0000-4000-8000-000000020001'; e uuid:='00000000-0000-4000-8000-000000020002';
  pay uuid:='00000000-0000-4000-8000-000000020003'; input jsonb; req jsonb; result jsonb; state jsonb; bad jsonb; failed boolean;
  movement bigint; count_before bigint; fp text; second_pay uuid:='00000000-0000-4000-8000-000000020004';
begin
  input:='{"responsibleKey":"external:9000020001","date":"2026-09-01","kind":"loan","amount":60,"concept":"TEST prior week loan","confirmed":true}';
  result:=public.create_delivery_debt_v1(d,input); assert result->>'id'=d::text;
  result:=public.create_delivery_debt_v1(d,input); assert (result->>'replayed')::boolean,'create replay';
  foreach bad in array array[input||'{"amount":-1}',input||'{"amount":0.001}',input||'{"amount":"NaN"}',input||'{"date":"2999-01-01"}',input||'{"confirmed":false}'] loop
    failed:=false; begin perform public.create_delivery_debt_v1(gen_random_uuid(),bad); exception when invalid_parameter_value then failed:=true; end;
    assert failed,'invalid debt rejected';
  end loop;
  failed:=false; begin perform public.create_delivery_debt_v1(d,input||'{"amount":61}'); exception when invalid_parameter_value then failed:=true; end; assert failed,'idempotency payload bound';
  perform public.create_delivery_extra_v1(e,'{"responsibleKey":"external:9000020001","date":"2026-09-10","concept":"TEST earned services","amount":100}');
  state:=app_private.delivery_debt_state_v1(d); assert (state->>'balance')::numeric=60;
  assert exists(select 1 from jsonb_array_elements(public.admin_delivery_debts_v1('2026-09-13')->'rows')x where x->>'id'=d::text),'prior week debt carried';
  select x->>'fingerprint' into fp from jsonb_array_elements(public.admin_delivery_extras_v1('2026-09-07','2026-09-13')->'rows')x where x->>'id'=e::text;
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000020001,'amount',80,
    'confirmedUnpaid',true,'items','[]'::jsonb,'extras',jsonb_build_array(jsonb_build_object('id',e,'fingerprint',fp)),
    'deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',20)));
  foreach bad in array array[
    jsonb_set(req,'{deductions,0,amount}','61'), jsonb_set(req,'{deductions,0,amount}','-1'),
    jsonb_set(req,'{deductions,0,amount}','0.001'),jsonb_set(req,'{deductions,0,amount}','"NaN"'),
    req||jsonb_build_object('deductions',(req->'deductions')||(req->'deductions')),
    req||'{"amount":100}',req||'{"paymentDate":"2026-08-31"}'
  ] loop
    failed:=false; begin perform public.pay_delivery_services_v1(gen_random_uuid(),bad); exception when invalid_parameter_value then failed:=true; end;
    assert failed,'invalid deduction/net/date rejected';
  end loop;
  failed:=false; begin perform public.pay_delivery_services_v1(pay,jsonb_set(req,'{deductions,0,fingerprint}','"stale"')); exception when serialization_failure then failed:=true; end; assert failed,'stale debt rejected';
  result:=public.pay_delivery_services_v1(pay,req); movement:=(result->>'movementId')::bigint;
  assert (result->>'totalUsd')::numeric=80 and (result->>'grossUsd')::numeric=100 and (result->>'deductionUsd')::numeric=20,'gross/net';
  assert (select amount=80 from public.money_movements where id=movement),'only net cash expense';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=40,'carry forty';
  result:=public.pay_delivery_services_v1(pay,req); assert (result->>'replayed')::boolean,'payment replay';
  assert (select count(*) from public.delivery_debt_allocations where payment_id=pay)=1,'one installment';
  failed:=false; begin perform public.void_delivery_debt_v1(d,'TEST correction'); exception when invalid_parameter_value then failed:=true; end; assert failed,'cannot void debt with installments';
  -- Different services cannot reuse stale debt balance.
  perform public.create_delivery_extra_v1('00000000-0000-4000-8000-000000020005','{"responsibleKey":"external:9000020001","date":"2026-09-10","concept":"TEST other services","amount":50}');
  select x->>'fingerprint' into fp from jsonb_array_elements(public.admin_delivery_extras_v1('2026-09-07','2026-09-13')->'rows')x where x->>'id'='00000000-0000-4000-8000-000000020005';
  bad:=req||jsonb_build_object('amount',30,'extras',jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000020005','fingerprint',fp)));
  failed:=false; begin perform public.pay_delivery_services_v1(second_pay,bad); exception when serialization_failure then failed:=true; end; assert failed,'cross-period stale installment blocked';
  perform public.void_delivery_service_payment_v1(pay,'TEST reverse installment');
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=60,'reversal restores debt';
  assert (select status='voided' from public.money_movements where id=movement),'net expense reversed';
  perform public.void_delivery_service_payment_v1(pay,'TEST reverse installment');
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=60,'repeated void no extra debt';
  -- Zero payout for a delivery + extra, no fake movement and report still recognizes settlement.
  state:=app_private.delivery_debt_state_v1(d);
  req:=bad||jsonb_build_object('accountId',null,'amount',null,'items',jsonb_build_array(jsonb_build_object('id',9000020002,'fingerprint',public.delivery_service_cost_v1(9000020002)->>'fingerprint')),
    'deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',55)));
  select count(*) into count_before from public.money_movements;
  result:=public.pay_delivery_services_v1(second_pay,req);
  assert result->>'movementId' is null and (result->>'totalUsd')::numeric=0,'zero payout';
  assert (select count(*) from public.money_movements)=count_before,'no zero cash movement';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=5,'zero keeps remaining debt';
  assert exists(select 1 from jsonb_array_elements(public.admin_delivery_services_v1('2026-09-07','2026-09-13')->'rows')x
    where (x->>'id')::bigint=9000020002 and x#>>'{payment,status}'='confirmed' and x#>>'{payment,movementId}' is null),'zero settlement visible';
  perform public.void_delivery_service_payment_v1(second_pay,'TEST reverse zero');
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=60,'zero reversal';
  -- More deductions than gross is refused, never silently capped.
  state:=app_private.delivery_debt_state_v1(d); bad:=req||jsonb_build_object('deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',60)));
  failed:=false; begin perform public.pay_delivery_services_v1(gen_random_uuid(),bad); exception when invalid_parameter_value then failed:=true; end; assert failed,'deduction cannot exceed earned';
end $$;
-- Purchase offsets preserve cash, fund balance and precise order coverage.
do $$
declare d uuid:='00000000-0000-4000-8000-000000020011'; e uuid:='00000000-0000-4000-8000-000000020012';
  pay uuid:='00000000-0000-4000-8000-000000020013'; input jsonb; req jsonb; r jsonb; state jsonb; fp text; balance numeric; failed boolean;
begin
  select fund_balance_usd into balance from public.clients where id=9000020001;
  input:='{"responsibleKey":"external:9000020001","date":"2026-09-01","kind":"order","amount":2.61,"orderId":9000020001,"clientId":9000020001,"concept":"TEST purchase","confirmed":true}';
  perform public.create_delivery_debt_v1(d,input);
  failed:=false; begin perform public.create_delivery_debt_v1(gen_random_uuid(),input); exception when unique_violation then failed:=true; end; assert failed,'same purchase cannot create two debts';
  perform public.create_delivery_extra_v1(e,'{"responsibleKey":"external:9000020001","date":"2026-09-10","concept":"TEST purchase service","amount":10}');
  select x->>'fingerprint' into fp from jsonb_array_elements(public.admin_delivery_extras_v1('2026-09-07','2026-09-13')->'rows')x where x->>'id'=e::text;
  state:=app_private.delivery_debt_state_v1(d);
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000020002,'amount',739,'rate',100,
    'confirmedUnpaid',true,'items','[]'::jsonb,'extras',jsonb_build_array(jsonb_build_object('id',e,'fingerprint',fp)),
    'deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',2.61)));
  r:=public.pay_delivery_services_v1(pay,req);
  assert (r->>'totalUsd')::numeric=7.39 and (r->>'amount')::numeric=739,'VES net exact';
  assert (select pending_usd=0 from public.get_order_financial_state(9000020001)),'purchase closed with precise basis';
  assert not exists(select 1 from public.money_movements where order_id=9000020001),'no fake cash to purchase';
  assert (select fund_balance_usd is not distinct from balance from public.clients where id=9000020001),'fund net unchanged';
  assert (select sum(case when movement_type='credit' then amount_usd else -amount_usd end)=0 from public.client_fund_movements where movement_group_id=pay),'paired ledger zero';
  assert (select rounding_usd>0 and rounding_usd<.01 from public.delivery_debt_allocations where payment_id=pay),'subcent audited';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=0,'same canonical debt settled';
  perform public.void_delivery_service_payment_v1(pay,'TEST purchase reverse');
  assert (select abs(pending_usd-2200/842.21)<.000000001 from public.get_order_financial_state(9000020001)),'precise debt restored';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=2.61,'purchase reopened';
  assert (select sum(case when movement_type='credit' then amount_usd else -amount_usd end)=0 from public.client_fund_movements where movement_group_id=pay),'reversal fund net zero';
  perform public.void_delivery_debt_v1(d,'TEST remove purchase link');
end $$;
reset role;
-- An ordinary order payment changes the linked debt; an existing expense must
-- match net, not gross. Protect the live offset from legacy edits/deletions.
do $$ declare d uuid:='00000000-0000-4000-8000-000000020021'; e uuid:='00000000-0000-4000-8000-000000020022';
  pay uuid:='00000000-0000-4000-8000-000000020023'; state jsonb; old_state jsonb; fp text; req jsonb; r jsonb; failed boolean; mid bigint;
begin
  perform public.create_delivery_debt_v1(d,'{"responsibleKey":"external:9000020001","date":"2026-09-01","kind":"order","amount":2.61,"orderId":9000020001,"clientId":9000020001,"concept":"TEST live purchase","confirmed":true}');
  old_state:=app_private.delivery_debt_state_v1(d);
  insert into public.money_movements(movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,order_id,status)
  values('2026-09-14',auth.uid(),now(),auth.uid(),'inflow','order_payment',9000020001,'USD',1,1,9000020001,'confirmed');
  state:=app_private.delivery_debt_state_v1(d);
  assert (state->>'balance')::numeric=1.61 and state->>'fingerprint'<>old_state->>'fingerprint','ordinary payment reduces linked debt';
  perform public.create_delivery_extra_v1(e,'{"responsibleKey":"external:9000020001","date":"2026-09-10","concept":"TEST linked expense service","amount":10}');
  select x->>'fingerprint' into fp from jsonb_array_elements(public.admin_delivery_extras_v1('2026-09-07','2026-09-13')->'rows')x where x->>'id'=e::text;
  insert into public.money_movements(movement_date,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,status,created_by_user_id,confirmed_at,confirmed_by_user_id)
  values('2026-09-14','outflow','expense_payment',9000020001,'USD',9.39,9.39,'confirmed',auth.uid(),now(),auth.uid()) returning id into mid;
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','existingMovementId',mid,'confirmedUnpaid',true,
    'items','[]'::jsonb,'extras',jsonb_build_array(jsonb_build_object('id',e,'fingerprint',fp)),
    'deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',.61)));
  r:=public.pay_delivery_services_v1(pay,req);
  assert (r->>'totalUsd')::numeric=9.39 and (r->>'linkedExisting')::boolean,'existing exact net expense linked';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=1,'partial purchase still owes one dollar';
  failed:=false; begin update public.orders set total_usd=5 where id=9000020001; exception when invalid_parameter_value then failed:=true; end; assert failed,'price guarded';
  failed:=false; begin update public.orders set status='cancelled' where id=9000020001; exception when invalid_parameter_value then failed:=true; end; assert failed,'cancellation guarded';
  failed:=false; begin delete from public.client_fund_movements where movement_group_id=pay; exception when invalid_parameter_value then failed:=true; end; assert failed,'fund evidence immutable';
  failed:=false; begin
    insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,order_id,reason_code,created_by_user_id,movement_group_id)
    values(9000020001,'credit','USD',.61,.61,9000020001,'order_fund_restore',auth.uid(),pay);
    exception when invalid_parameter_value then failed:=true; end; assert failed,'cannot forge early restoration';
  perform public.void_delivery_service_payment_v1(pay,'TEST existing expense reverse');
  assert (select status='confirmed' from public.money_movements where id=mid),'existing net expense preserved';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=1.61,'external payment retained on reverse';
end $$;
-- Fault at the last linking step rolls back debt, cash and compensation together.
create function app_private.test_debt_last_step() returns trigger language plpgsql as $$
begin if new.payment_id is not null then raise exception 'TEST DEBT LAST STEP'; end if; return new; end $$;
create trigger test_debt_last_step before update on public.delivery_extra_services for each row execute function app_private.test_debt_last_step();
set local role authenticated;
do $$ declare d uuid:='00000000-0000-4000-8000-000000020001'; e uuid:='00000000-0000-4000-8000-000000020002';
  fp text; state jsonb; req jsonb; failed boolean:=false; count_before bigint;
begin
  select x->>'fingerprint' into fp from jsonb_array_elements(public.admin_delivery_extras_v1('2026-09-07','2026-09-13')->'rows')x where x->>'id'=e::text;
  state:=app_private.delivery_debt_state_v1(d);
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000020001,'amount',80,'confirmedUnpaid',true,
    'items','[]'::jsonb,'extras',jsonb_build_array(jsonb_build_object('id',e,'fingerprint',fp)),
    'deductions',jsonb_build_array(jsonb_build_object('id',d,'fingerprint',state->>'fingerprint','amount',20)));
  select count(*) into count_before from public.money_movements;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000020099',req); exception when raise_exception then
    if sqlerrm<>'TEST DEBT LAST STEP' then raise; end if; failed:=true; end;
  assert failed,'last step fault executed';
  assert (select count(*) from public.money_movements)=count_before,'failed payment leaves no cash';
  assert (app_private.delivery_debt_state_v1(d)->>'balance')::numeric=60,'failed payment leaves no installment';
  assert not exists(select 1 from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000020099'),'no receipt on failure';
end $$;
reset role;
drop trigger test_debt_last_step on public.delivery_extra_services;
drop function app_private.test_debt_last_step();
-- An unauthenticated or non-admin caller cannot read debt history or mutate it.
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.admin_delivery_debts_v1('2026-09-13'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anon blocked';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='advisor' and user_id not in(select user_id from public.user_roles where role='admin') limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  assert not exists(select 1 from public.delivery_debts),'advisor cannot read debts';
  begin perform public.admin_delivery_debts_v1('2026-09-13'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor report blocked'; failed:=false;
  begin perform public.create_delivery_debt_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor create blocked';
end $$;
reset role;
select 'delivery debt scenarios passed; rollback required' as result;
