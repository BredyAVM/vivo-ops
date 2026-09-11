-- Append after the proposed migration's BEGIN/body, then ALWAYS ROLLBACK.
-- Dedicated synthetic rows: never change an actual client's money or order.
insert into public.money_accounts(id,name,currency_code,account_kind) values
  (9000000004,'ROLLBACK payment USD','USD','cash'),(9000000005,'ROLLBACK payment VES','VES','cash');
insert into public.clients(id,full_name) values(9000000004,'ROLLBACK payment client');
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
select id,'ROLLBACK-PAYMENT-'||id,'master','pickup','ready',9000000004,10,1000,
  '{"pricing":{"total_usd":10,"total_bs":1000,"fx_rate":100},"unrelated":{"keep":true}}'
from generate_series(9000000004::bigint,9000000012::bigint) id;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
  reported_amount_usd_equivalent,reported_money_account_id,operation_date)
select id,id,auth.uid(),'USD',12,12,9000000004,'2026-09-01' from generate_series(9000000004::bigint,9000000012::bigint) id;
create function app_private.test_payment_late_failure() returns trigger language plpgsql as $$
begin
  if new.order_id between 9000000004 and 9000000012 and current_setting('test.payment.fail',true)='on' then
    raise exception 'synthetic late failure' using errcode='23514';
  end if;
  return new;
end $$;
create trigger test_payment_late_failure before insert on public.order_timeline_events
for each row execute function app_private.test_payment_late_failure();
set local role authenticated;
do $$
declare req jsonb; r jsonb; r2 jsonb; failed boolean; before_balance numeric; n bigint; k text;
begin
  req := jsonb_build_object('reportId',9000000004,'orderId',9000000004,'clientId',9000000004,
    'accountId',9000000004,'currency','USD','amount',12,'rate',null,'date','2026-09-02',
    'handling','store_fund','changeLines','[]'::jsonb,'overrideOperationDate',true);
  select fund_balance_usd into before_balance from public.clients where id=9000000004;
  perform set_config('test.payment.fail','on',true);
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req); exception when check_violation then failed:=true; end;
  assert failed, 'late failure injected';
  assert (select status='pending' and operation_date='2026-09-01' and confirmed_movement_id is null from public.payment_reports where id=9000000004), 'report and date rolled back';
  assert not exists(select 1 from public.money_movements where order_id=9000000004), 'money rolled back';
  assert not exists(select 1 from public.client_fund_movements where order_id=9000000004), 'fund ledger rolled back';
  assert (select fund_balance_usd=before_balance from public.clients where id=9000000004), 'client balance rolled back';
  assert not exists(select 1 from public.payment_confirmation_operations where report_id=9000000004), 'receipt rolled back';
  perform set_config('test.payment.fail','off',true);
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (r#>>'{payload,fund_credit_usd}')::numeric=2, 'only excess stored';
  assert (select fund_balance_usd=before_balance+2 from public.clients where id=9000000004), 'fund updated once';
  assert (select pending_usd=0 and overpaid_usd=0 from public.get_order_financial_state(9000000004)), 'canonical balance settled';
  assert (select payload=r->'payload' from public.order_timeline_events where id=(r->>'eventId')::bigint), 'durable visible event';
  r2:=public.confirm_payment_report_atomic_v1(req);
  assert r2->>'replayed'='true' and r2->>'movementId'=r->>'movementId', 'same receipt replayed';
  assert (select count(*)=1 from public.money_movements where order_id=9000000004), 'retry cannot duplicate money';
  assert (select fund_balance_usd=before_balance+2 from public.clients where id=9000000004), 'retry cannot duplicate fund';
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req||'{"amount":13}'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'changed retry payload rejected';
  req := req||'{"reportId":9000000005,"orderId":9000000005,"amount":12,"handling":"change_given","changeLines":[{"accountId":9000000004,"currency":"USD","amount":1,"rate":null}]}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (r#>>'{payload,change_usd}')::numeric=1 and (r#>>'{payload,fund_credit_usd}')::numeric=1, 'partial change and remainder fund';
  assert (select count(*)=2 and count(distinct movement_group_id)=1 from public.money_movements where order_id=9000000005), 'principal and change grouped';
  assert (select pending_usd=0 and overpaid_usd=0 from public.get_order_financial_state(9000000005)), 'change not double counted';
  req := req||'{"reportId":9000000006,"orderId":9000000006,"changeLines":[{"accountId":9000000004,"currency":"USD","amount":3,"rate":null}]}';
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req); exception when invalid_parameter_value then failed:=true; end;
  assert failed and not exists(select 1 from public.money_movements where order_id=9000000006), 'excess change fails with no payment left';
  req := req||'{"handling":"store_fund","changeLines":[],"amount":14}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (r#>>'{payload,fund_credit_usd}')::numeric=4, 'confirmed amount determines excess, not original reported amount';
  req := req||'{"reportId":9000000007,"orderId":9000000007,"amount":10.50,"handling":"close_difference"}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (select total_usd=10.5 and total_bs_snapshot=1050 and extra_fields#>>'{unrelated,keep}'='true' from public.orders where id=9000000007), 'rounding and metadata';
  assert exists(select 1 from public.order_admin_adjustments where id=(r#>>'{payload,adjustment_id}')::bigint), 'rounding audit in same operation';
  req := req||'{"reportId":9000000008,"orderId":9000000008,"amount":12}';
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req); exception when invalid_parameter_value then failed:=true; end;
  assert failed and (select status='pending' from public.payment_reports where id=9000000008), 'rounding over limit fails before committing payment';
  foreach k in array array['{"orderId":9000000009}','{"clientId":9000000009}','{"amount":"NaN"}','{"amount":0}','{"amount":0.001}'] loop
    failed:=false;
    begin perform public.confirm_payment_report_atomic_v1(req||'{"handling":"store_fund"}'||k::jsonb); exception when invalid_parameter_value then failed:=true; end;
    assert failed, 'mismatched ownership or invalid amount rejected';
  end loop;
  req := req||'{"amount":10,"handling":null,"overrideOperationDate":false}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert r#>>'{payload,movement_date}'='2026-09-01', 'original operation date preserved by default';
  req := req||'{"reportId":9000000009,"orderId":9000000009,"amount":1000,"currency":"VES","rate":100,"accountId":9000000005}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (select amount=1000 and amount_usd_equivalent=10 from public.money_movements where id=(r->>'movementId')::bigint), 'VES conversion';
  req := req||'{"reportId":9000000010,"orderId":9000000010,"amount":12,"currency":"USD","rate":null,"accountId":9000000004,"requireExplicitHandling":true}';
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'Ops explicit handling required';
  req := req||'{"handling":"change_given","requireExactChange":true,"changeLines":[{"accountId":9000000004,"currency":"USD","amount":1}]}';
  failed:=false;
  begin perform public.confirm_payment_report_atomic_v1(req); exception when invalid_parameter_value then failed:=true; end;
  assert failed and not exists(select 1 from public.money_movements where order_id=9000000010), 'Ops exact change enforced atomically';
  req := req||'{"reportId":9000000012,"orderId":9000000012,"amount":1,"handling":null,"changeLines":[]}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (select pending_usd=9 and confirmed_paid_usd=1 from public.get_order_financial_state(9000000012)), 'a smaller confirmed amount does not falsely close the order using reported snapshot amounts';
  assert (select reported_amount=12 from public.payment_reports where id=9000000012), 'original report evidence preserved';
  failed:=false;
  begin delete from public.payment_confirmation_operations where report_id=9000000004; exception when insufficient_privilege then failed:=true; end;
  assert failed, 'receipt is not client-writable';
end $$;
reset role;
-- Roles without financial confirmation authority, and Counter on someone else's report.
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(
    select 1 from public.user_roles a where a.user_id=r.user_id and a.role in ('admin','master')) loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.confirm_payment_report_atomic_v1('{"reportId":9000000011,"accountId":9000000004,"amount":12,"currency":"USD","changeLines":[]}');
    exception when insufficient_privilege then failed:=true; end;
    assert failed, 'unassigned role / foreign Counter report denied';
    reset role;
  end loop;
end $$;
-- Positive Master and Counter paths use only the synthetic financial rows.
do $$ declare u uuid; r jsonb; failed boolean; begin
  select user_id into u from public.user_roles x where role='master' and not exists(
    select 1 from public.user_roles a where a.user_id=x.user_id and a.role='admin') limit 1;
  if u is not null then
    perform set_config('request.jwt.claim.sub',u::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.confirm_payment_report_atomic_v1('{"reportId":9000000010,"accountId":9000000004,"amount":10.5,"currency":"USD","handling":"close_difference","changeLines":[]}');
    exception when insufficient_privilege then failed:=true; end;
    assert failed, 'Master cannot close rounding gains';
    r:=public.confirm_payment_report_atomic_v1('{"reportId":9000000010,"accountId":9000000004,"amount":10,"currency":"USD","changeLines":[]}');
    assert (r->>'movementId')::bigint>0, 'Master can confirm';
    reset role;
  end if;
  select user_id into u from public.user_roles x where role='counter' and not exists(
    select 1 from public.user_roles a where a.user_id=x.user_id and a.role in ('admin','master')) limit 1;
  if u is not null then
    update public.money_accounts set name='ROLLBACK DAR cash' where id=9000000004;
    insert into public.money_account_payment_rules(money_account_id,role,payment_method_code,can_confirm_payment,auto_confirms_report,review_required,is_active)
    select 9000000004,'counter',payment_method_code,true,true,false,true from public.money_account_payment_rules
    where role='counter' and is_active limit 1;
    update public.payment_reports set created_by_user_id=u where id=9000000011;
    perform set_config('request.jwt.claim.sub',u::text,true);
    set local role authenticated;
    r:=public.confirm_payment_report_atomic_v1('{"reportId":9000000011,"accountId":9000000004,"amount":12,"currency":"USD","changeLines":[]}');
    assert (r#>>'{payload,fund_credit_usd}')::numeric=2, 'Counter own report and fund remain operational';
    reset role;
  end if;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.confirm_payment_report_atomic_v1('{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'missing session denied';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.confirm_payment_report_atomic_v1('{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous denied';
end $$;
reset role;
select 'payment confirmation rollback assertions passed' as result;
