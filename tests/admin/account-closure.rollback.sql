-- Synthetic accounts only. Run inside BEGIN and ALWAYS ROLLBACK.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_accounts(id,name,currency_code,account_kind) values
  (9000000031,'ROLLBACK bank USD','USD','bank'),(9000000032,'ROLLBACK cash USD','USD','cash'),
  (9000000033,'ROLLBACK POS USD','USD','pos'),(9000000034,'ROLLBACK bank VES','VES','bank');
insert into public.money_account_closure_profiles(money_account_id,closure_kind,requires_zero_difference,allows_classified_difference)
values(9000000031,'bank',false,true),(9000000032,'cash',true,false),(9000000033,'pos',true,false),(9000000034,'bank',false,true);
insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,amount,amount_usd_equivalent)
values(9000000031,'USD','2026-09-01',auth.uid(),'2026-09-01T10:00:00-04:00',auth.uid(),'inflow','other_income',10,10),
  (9000000031,'USD','2026-09-03',auth.uid(),'2026-09-03T10:00:00-04:00',auth.uid(),'inflow','other_income',2,2),
  (9000000032,'USD','2026-09-02',auth.uid(),'2026-09-02T10:00:00-04:00',auth.uid(),'inflow','other_income',5,5),
  (9000000032,'USD','2026-09-02',auth.uid(),'2026-09-02T13:00:00-04:00',auth.uid(),'inflow','other_income',7,7),
  (9000000033,'USD','2026-09-02',auth.uid(),'2026-09-02T10:00:00-04:00',auth.uid(),'inflow','other_income',12,12);
insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,amount,exchange_rate_ves_per_usd,amount_usd_equivalent)
values(9000000034,'VES','2026-09-01',auth.uid(),'2026-09-01T10:00:00-04:00',auth.uid(),'inflow','other_income',1000,100,10);
insert into public.money_account_closures(id,money_account_id,closure_date,closure_at,expected_amount,counted_amount,difference_amount,
  expected_amount_usd,counted_amount_usd,difference_amount_usd,currency_code,created_by_user_id)
values(9000000033,9000000033,'2026-09-01','2026-09-01T23:59:00-04:00',100,100,0,100,100,0,'USD',auth.uid());
insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,amount,amount_usd_equivalent,reference_code)
values(9000000033,'USD','2026-09-02',auth.uid(),'2026-09-02T11:00:00-04:00',auth.uid(),'outflow','withdrawal',100,100,'closure-9000000033');
create function app_private.test_closure_late_failure() returns trigger language plpgsql as $$
begin
  if current_setting('test.closure.fail',true)='on' then raise exception 'synthetic closure receipt failure' using errcode='23514'; end if;
  return new;
end $$;
create trigger test_closure_create_failure before insert on public.account_closure_operations
for each row execute function app_private.test_closure_late_failure();
create trigger test_closure_void_failure before insert on public.account_closure_reversals
for each row execute function app_private.test_closure_late_failure();
set local role authenticated;
do $$
declare req jsonb; r jsonb; r2 jsonb; first_id bigint; second_id bigint; item_id bigint; failed boolean; k uuid:='00000000-0000-4000-8000-000000000031';
begin
  req:='{"moneyAccountId":9000000031,"closureDate":"2026-09-02","closureTime":"23:59","countedAmount":8}';
  perform set_config('test.closure.fail','on',true);
  failed:=false;
  begin perform public.create_account_closure_v1(k,req); exception when check_violation then failed:=true; end;
  assert failed and not exists(select 1 from public.money_account_closures where money_account_id=9000000031), 'late failure rolls back closure';
  assert not exists(select 1 from public.money_account_reconciliation_items where money_account_id=9000000031), 'late failure rolls back pending difference';
  perform set_config('test.closure.fail','off',true);
  r:=public.create_account_closure_v1(k,req);
  first_id:=(r->>'closureId')::bigint; item_id:=(r->>'reconciliationItemId')::bigint;
  assert (r->>'expectedAmount')::numeric=10 and (r->>'differenceAmount')::numeric=-2 and item_id is not null, 'bank daily calculation and linked shortage';
  assert (select snapshot->>'daily'='true' and jsonb_array_length(snapshot->'movements')=1 from public.account_closure_operations where request_id=k), 'snapshot identifies included movements';
  r2:=public.create_account_closure_v1(k,req);
  assert r2->>'replayed'='true' and (r2->>'closureId')::bigint=first_id, 'closure retry';
  assert (select count(*)=1 from public.money_account_reconciliation_items where source_kind='closure' and source_id=first_id), 'one pending difference';
  failed:=false;
  begin perform public.create_account_closure_v1(k,req||'{"countedAmount":9}'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'changed retry rejected';
  failed:=false;
  begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000032',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'another identity cannot duplicate active daily closure';
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000032',req||'{"closureDate":"2026-09-03","countedAmount":10}');
  second_id:=(r->>'closureId')::bigint;
  assert (r->>'expectedAmount')::numeric=10 and r->>'reconciliationItemId' is null, 'next closure uses prior counted value plus new movement';
  failed:=false;
  begin perform public.void_account_closure_v1(first_id,'ROLLBACK predecessor'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'later closure dependency protected';
  r:=public.void_account_closure_v1(second_id,'ROLLBACK latest closure');
  perform set_config('test.closure.fail','on',true);
  failed:=false;
  begin perform public.void_account_closure_v1(first_id,'ROLLBACK late void'); exception when check_violation then failed:=true; end;
  assert failed and (select status='recorded' from public.money_account_closures where id=first_id)
    and (select status='open' from public.money_account_reconciliation_items where id=item_id), 'late reversal failure restores closure and pending';
  perform set_config('test.closure.fail','off',true);
  r:=public.void_account_closure_v1(first_id,'ROLLBACK closure void');
  assert (select status='voided' from public.money_account_reconciliation_items where id=item_id), 'no orphan pending after closure void';
  r:=public.void_account_closure_v1(first_id,'ROLLBACK closure void');
  assert r->>'replayed'='true', 'void retry';
  failed:=false;
  begin perform public.create_account_closure_v1(k,req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'cannot replay a voided closure as a new closure';
  req:='{"moneyAccountId":9000000032,"closureDate":"2026-09-02","closureTime":"12:00","countedAmount":6}';
  failed:=false;
  begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000033',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'cash profile requires zero difference';
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000033',req||'{"countedAmount":5}');
  assert (r->>'expectedAmount')::numeric=5, 'intraday excludes later payments';
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000034',req||'{"countedAmount":12,"closureTime":"14:00"}');
  assert (r->>'expectedAmount')::numeric=12, 'second intraday includes only new payment plus previous count';
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000035',req||'{"moneyAccountId":9000000033,"countedAmount":12}');
  assert (r->>'expectedAmount')::numeric=12, 'POS starts at zero and excludes prior settlement withdrawal';
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000036',req||'{"moneyAccountId":9000000034,"countedAmount":1000,"exchangeRateVesPerUsd":200}');
  assert (r->>'expectedAmount')::numeric=1000 and (r->>'expectedAmountUsd')::numeric=10 and r->>'reconciliationItemId' is null, 'VES native count distinct from historical USD valuation';
  failed:=false;
  begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000037',req||'{"countedAmount":"NaN"}'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'NaN rejected';
end $$;
reset role;
do $$ declare r jsonb; c bigint; u uuid; failed boolean; begin
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000038',
    '{"moneyAccountId":9000000031,"closureDate":"2026-09-04","countedAmount":11}');
  c:=(r->>'closureId')::bigint;
  update public.money_account_reconciliation_items set status='resolved',resolved_at=now(),resolved_by_user_id=auth.uid()
    where id=(r->>'reconciliationItemId')::bigint;
  set local role authenticated;
  failed:=false;
  begin perform public.void_account_closure_v1(c,'ROLLBACK resolved difference'); exception when invalid_parameter_value then failed:=true; end;
  assert failed and (select status='recorded' from public.money_account_closures where id=c), 'resolved difference is not silently erased';
  reset role;
  insert into public.money_accounts(id,name,currency_code,account_kind) values(9000000035,'ROLLBACK baseline bank','USD','bank');
  insert into public.money_account_closure_baselines(money_account_id,baseline_date,baseline_at,currency_code,counted_amount,counted_amount_usd,created_by_user_id)
    values(9000000035,'2026-09-01','2026-09-01T23:59:59-04:00','USD',100,100,auth.uid());
  insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
    direction,movement_type,amount,amount_usd_equivalent) values(9000000035,'USD','2026-09-02',auth.uid(),'2026-09-02T10:00:00-04:00',auth.uid(),'inflow','other_income',10,10);
  select user_id into u from public.user_roles x where role='master' and not exists(select 1 from public.user_roles a where a.user_id=x.user_id and a.role='admin') limit 1;
  if u is not null then perform set_config('request.jwt.claim.sub',u::text,true); end if;
  set local role authenticated;
  r:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000039',
    '{"moneyAccountId":9000000035,"closureDate":"2026-09-02","countedAmount":110}');
  assert (r->>'expectedAmount')::numeric=110, 'Master can close and baseline is preserved';
  if u is not null then
    failed:=false;
    begin perform public.void_account_closure_v1((r->>'closureId')::bigint,'ROLLBACK Master denied'); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'Master cannot void';
  end if;
  reset role;
end $$;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role in ('admin','master')) loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000037','{}'); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'non-financial roles denied closure';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000037','{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous denied';
end $$;
reset role;
select 'account closure rollback assertions passed' result;
