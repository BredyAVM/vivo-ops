-- Run inside a transaction AFTER the migration, ALWAYS end with ROLLBACK.
-- Synthetic parent rows; real accounts are read only. Money rows are rolled back.
insert into public.advisor_commission_periods(id,name,date_from,date_to)
values(9000000001,'ROLLBACK commission test','1900-01-01','1900-01-15');
insert into public.advisor_commission_closures(id,period_id,advisor_user_id,status,payable_usd,snapshot)
select 9000000001,9000000001,user_id,'closed',100,
  jsonb_build_object('version',2,'totals',jsonb_build_object('payableUsd',100),
    'advisor',jsonb_build_object('name','ROLLBACK TEST'),
    'settlement',jsonb_build_object('formulaVersion','advisor-settlement-v1'),
    'commissionWorkflow',jsonb_build_object('conformity',jsonb_build_object('status','confirmed')))
from public.user_roles where role='admin' limit 1;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
-- Inject a late failure (after money inserts) and prove the command rolls all back.
create function app_private.test_commission_receipt_failure() returns trigger language plpgsql as $fn$
begin
  if new.request_id='11111111-1111-4111-8111-111111111111' then raise exception 'test late failure' using errcode='23514'; end if;
  return new;
end;
$fn$;
create trigger test_commission_receipt_failure before insert on public.commission_payment_operations
for each row execute function app_private.test_commission_receipt_failure();
set local role authenticated;
do $test$
declare
  a bigint; b bigint; r jsonb; k uuid:=gen_random_uuid(); n bigint; fail boolean;
begin
  select id into a from public.money_accounts where currency_code='USD' and is_active limit 1;
  select id into b from public.money_accounts where currency_code='VES' and is_active limit 1;
  select count(*) into n from public.money_movements;
  fail:=false;
  begin perform public.record_commission_payment_v1('11111111-1111-4111-8111-111111111111',9000000001,a,40,2,null,current_date,null);
  exception when check_violation then fail:=true; end;
  assert fail and (select count(*)=n from public.money_movements), 'late failure rolled back both movements';
  assert (select count(*)=0 from public.commission_payment_operations where closure_id=9000000001), 'late failure no receipt';
  r:=public.record_commission_payment_v1(k,9000000001,a,40,2,null,current_date,null);
  assert (r->>'remainingUsd')::numeric=60 and not (r->>'fullyPaid')::boolean, 'partial payment';
  assert (select status='closed' from public.advisor_commission_closures where id=9000000001), 'partial state';
  assert (select count(*)=1 from public.commission_payment_operations where closure_id=9000000001), 'one receipt';
  r:=public.record_commission_payment_v1(k,9000000001,a,40,2,null,current_date,null);
  assert (r->>'replayed')::boolean, 'retry replay';
  assert (select count(*)=1 from public.commission_payment_operations where closure_id=9000000001), 'no retry duplicate';
  fail:=false;
  begin perform public.record_commission_payment_v1(k,9000000001,a,41,2,null,current_date,null);
  exception when invalid_parameter_value then fail:=true; end;
  assert fail, 'key collision must fail';
  fail:=false;
  begin perform public.record_commission_payment_v1(gen_random_uuid(),9000000001,a,61,0,null,current_date,null);
  exception when invalid_parameter_value then fail:=true; end;
  assert fail, 'overpayment rejected';
  fail:=false;
  begin update public.advisor_commission_closures set status='paid' where id=9000000001;
  exception when check_violation then fail:=true; end;
  assert fail, 'manual paid cannot bypass amount';
  fail:=false;
  begin update public.advisor_commission_closures set payable_usd=120 where id=9000000001;
  exception when check_violation then fail:=true; end;
  assert fail, 'locked payable';
  fail:=false;
  begin insert into public.advisor_commission_deductions(closure_id,deduction_type,description,amount_usd)
    values(9000000001,'manual_expense','ROLLBACK',1);
  exception when check_violation then fail:=true; end;
  assert fail, 'deduction rollback';
  fail:=false;
  begin perform public.record_commission_payment_v1(gen_random_uuid(),9000000001,b,1,0.01,1000,current_date,null);
  exception when invalid_parameter_value then fail:=true; end;
  assert fail, 'sub-cent USD bank fee rejected before money';
  r:=public.record_commission_payment_v1(gen_random_uuid(),9000000001,b,60,100,100,current_date,null);
  assert (r->>'fullyPaid')::boolean and (r->>'remainingUsd')::numeric=0, 'full settlement';
  assert (select status='paid' from public.advisor_commission_closures where id=9000000001), 'full state';
  assert (select amount=6000 and amount_usd_equivalent=60 from public.money_movements where id=(r->>'movementId')::bigint), 'VES conversion';
  assert (select amount=100 and amount_usd_equivalent=1 from public.money_movements where id=(r->>'feeMovementId')::bigint), 'bank fee separate';
  fail:=false;
  begin delete from public.commission_payment_operations where closure_id=9000000001;
  exception when insufficient_privilege then fail:=true; end;
  assert fail, 'receipt delete forbidden';
end;
$test$;
reset role;
set local role authenticated;
do $test$
declare r jsonb; k uuid:=gen_random_uuid(); payment_key uuid; fail boolean:=false;
begin
  select request_id into payment_key from public.commission_payment_operations where closure_id=9000000001 order by payment_movement_id desc limit 1;
  r:=public.reverse_commission_payment_v1(k,payment_key,'ROLLBACK test reversal');
  assert not (r->>'replayed')::boolean, 'new reversal';
  assert (select status='closed' and paid_at is null from public.advisor_commission_closures where id=9000000001), 'reopened payment balance';
  assert (select count(*)=2 from public.money_movements where movement_group_id=payment_key and status='voided'), 'payment and fee voided together';
  r:=public.reverse_commission_payment_v1(k,payment_key,'ROLLBACK test reversal');
  assert (r->>'replayed')::boolean, 'idempotent reversal';
  begin perform public.reverse_commission_payment_v1(gen_random_uuid(),payment_key,'Second reversal');
  exception when invalid_parameter_value then fail:=true; end;
  assert fail, 'double reversal rejected';
end;
$test$;
reset role;
do $test$
declare fail boolean:=false;
begin
  begin update public.money_movements set status='voided' where id=(select payment_movement_id from public.commission_payment_operations where closure_id=9000000001 limit 1);
  exception when check_violation then fail:=true; end;
  assert fail, 'isolated financial mutation forbidden';
end;
$test$;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles r where role='advisor' and not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') limit 1),true);
set local role authenticated;
do $test$
declare fail boolean:=false;
begin
  begin perform public.record_commission_payment_v1(gen_random_uuid(),9000000001,1,1,0,null,current_date,null);
  exception when insufficient_privilege then fail:=true; end;
  assert fail, 'advisor cannot pay';
  assert (select count(*)=0 from public.commission_payment_operations), 'advisor cannot read receipts';
end;
$test$;
reset role;
set local role anon;
do $test$
declare fail boolean:=false;
begin
  begin perform public.record_commission_payment_v1(gen_random_uuid(),9000000001,1,1,0,null,current_date,null);
  exception when insufficient_privilege then fail:=true; end;
  assert fail, 'anonymous cannot call payment';
end;
$test$;
reset role;
set constraints all immediate;
select 'commission atomic rollback checks passed' as result;
