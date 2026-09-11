-- Apply only inside BEGIN and ALWAYS ROLLBACK. Synthetic accounts/operations.
insert into public.money_accounts(id,name,currency_code,account_kind) values
  (9000000021,'ROLLBACK transfer USD','USD','cash'),(9000000022,'ROLLBACK transfer VES','VES','cash');
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
create function app_private.test_transfer_late_failure() returns trigger language plpgsql as $$
begin
  if new.money_account_id=9000000021 and new.movement_type='fee_charge' and new.notes='ROLLBACK FAIL' then
    raise exception 'synthetic fee failure' using errcode='23514';
  end if;
  return new;
end $$;
create trigger test_transfer_late_failure before insert on public.money_movements
for each row execute function app_private.test_transfer_late_failure();
set local role authenticated;
do $$ declare req jsonb; r jsonb; r2 jsonb; failed boolean; k uuid:='00000000-0000-4000-8000-000000000021'; begin
  req:='{"sourceMoneyAccountId":9000000021,"targetMoneyAccountId":9000000022,"sourceAmount":10,"targetAmount":2000,"feeAmount":1,"targetExchangeRateVesPerUsd":200,"movementDate":"2026-09-01","notes":"ROLLBACK FAIL"}';
  failed:=false;
  begin perform public.create_money_transfer_v1(k,req); exception when check_violation then failed:=true; end;
  assert failed and not exists(select 1 from public.money_movements where movement_group_id=k), 'fee failure rolls back source and destination';
  assert not exists(select 1 from public.money_transfer_operations where request_id=k), 'failed operation has no receipt';
  req:=req||'{"notes":"ROLLBACK OK"}';
  r:=public.create_money_transfer_v1(k,req);
  assert (select count(*)=3 from public.money_movements where movement_group_id=k), 'three linked entries';
  assert (select sum(amount)=11 and sum(amount_usd_equivalent)=11 from public.money_movements where movement_group_id=k and direction='outflow'), 'source plus fee';
  assert (select amount=2000 and amount_usd_equivalent=10 and currency_code='VES' from public.money_movements where id=(r->>'targetMovementId')::bigint), 'native destination conversion';
  r2:=public.create_money_transfer_v1(k,req);
  assert r2->>'replayed'='true' and r2->>'sourceMovementId'=r->>'sourceMovementId', 'stable replay';
  assert (select count(*)=3 from public.money_movements where movement_group_id=k), 'no duplicated legs';
  failed:=false;
  begin perform public.create_money_transfer_v1(k,req||'{"sourceAmount":11}'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'changed retry rejected';
  foreach req in array array[
    '{"sourceMoneyAccountId":9000000021,"targetMoneyAccountId":9000000021,"sourceAmount":10,"targetAmount":10,"movementDate":"2026-09-01"}'::jsonb,
    '{"sourceMoneyAccountId":9000000021,"targetMoneyAccountId":9000000022,"sourceAmount":"NaN","targetAmount":10,"movementDate":"2026-09-01"}'::jsonb,
    '{"sourceMoneyAccountId":9000000021,"targetMoneyAccountId":9000000022,"sourceAmount":10,"targetAmount":10,"targetExchangeRateVesPerUsd":0,"movementDate":"2026-09-01"}'::jsonb] loop
    failed:=false;
    begin perform public.create_money_transfer_v1('00000000-0000-4000-8000-000000000022',req); exception when invalid_parameter_value then failed:=true; end;
    assert failed, 'invalid accounts, nonfinite amount or rate rejected';
  end loop;
  r:=public.create_money_transfer_v1('00000000-0000-4000-8000-000000000022',
    '{"sourceMoneyAccountId":9000000022,"targetMoneyAccountId":9000000021,"sourceAmount":2000,"targetAmount":10,"feeAmount":0,"sourceExchangeRateVesPerUsd":200,"movementDate":"2026-09-01"}');
  assert r->>'feeMovementId' is null, 'no fictitious zero fee';
end $$;
reset role;
set constraints all immediate;
set constraints all deferred;
do $$ declare failed boolean; k uuid:='00000000-0000-4000-8000-000000000021'; begin
  failed:=false;
  begin
    update public.money_movements set status='voided',voided_at=now(),voided_by_user_id=auth.uid(),void_reason='ROLLBACK partial void'
    where id=(select source_movement_id from public.money_transfer_operations where request_id=k);
    set constraints all immediate;
  exception when check_violation then failed:=true; end;
  assert failed and (select count(*)=3 from public.money_movements where movement_group_id=k and status='confirmed'), 'partial void rejected and rolled back';
  failed:=false;
  begin update public.money_movements set amount=amount+1,amount_usd_equivalent=amount_usd_equivalent+1
    where id=(select source_movement_id from public.money_transfer_operations where request_id=k);
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'certified amounts immutable';
  update public.money_movements set status='voided',voided_at=now(),voided_by_user_id=auth.uid(),void_reason='ROLLBACK complete void'
    where movement_group_id=k;
  set constraints all immediate;
  assert (select count(*)=3 from public.money_movements where movement_group_id=k and status='voided'), 'whole transfer void allowed';
end $$;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.create_money_transfer_v1('00000000-0000-4000-8000-000000000023','{}'); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'all non-Admin roles denied';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.create_money_transfer_v1('00000000-0000-4000-8000-000000000023','{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous denied';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
do $$ declare r jsonb; m bigint; begin
  select source_movement_id into m from public.money_transfer_operations where request_id='00000000-0000-4000-8000-000000000022';
  r:=public.void_money_transfer_v1(m,null,'ROLLBACK canonical reversal');
  assert jsonb_array_length(r->'movementIds')=2, 'server derives whole group from one leg';
  r:=public.void_money_transfer_v1(m,null,'ROLLBACK canonical reversal');
  assert r->>'replayed'='true', 'reversal retry';
end $$;
reset role;
set constraints all immediate;
select 'money transfer and reversal rollback assertions passed' as result;
