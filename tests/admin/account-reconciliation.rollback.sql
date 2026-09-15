-- Synthetic fixtures only. Run with migration inside BEGIN/ROLLBACK.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_accounts(id,name,currency_code,account_kind,is_active)
values(9000000201,'ROLLBACK reconciliation USD','USD','bank',true),(9000000202,'ROLLBACK reconciliation VES','VES','bank',true);
insert into public.money_account_closure_profiles(money_account_id,closure_kind,allows_classified_difference)
values(9000000201,'bank',true),(9000000202,'bank',true);

do $test$
declare c jsonb; d jsonb; result jsonb; request jsonb; req uuid:=gen_random_uuid(); child bigint; movement bigint;
  cut_at timestamptz:=date_trunc('day',clock_timestamp() at time zone 'America/Caracas') at time zone 'America/Caracas';
  today date:=(clock_timestamp() at time zone 'America/Caracas')::date;
  n bigint; failed boolean; balance numeric;
begin
  c:=public.create_account_closure_v1(gen_random_uuid(),jsonb_build_object('moneyAccountId',9000000201,'closureDate',today,'closureTime','00:00:01','countedAmount',100));
  insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,direction,movement_type,amount,amount_usd_equivalent)
  values(9000000201,'USD',today,auth.uid(),clock_timestamp(),auth.uid(),'inflow','other_income',100,100) returning id into movement;
  d:=public.admin_account_reconciliation_detail_v1((c->>'reconciliationItemId')::bigint);
  assert jsonb_array_length(d->'candidates')=1;
  request:=jsonb_build_object('itemId',c->'reconciliationItemId','mode','existing','amount',60,'note','Pago ya incluido en el banco',
    'fingerprint',d->>'fingerprint','movementId',movement,'movementFingerprint',d->'candidates'->0->>'fingerprint','evidenceConfirmed',true);
  select count(*) into n from public.money_movements where money_account_id=9000000201;
  result:=public.resolve_account_reconciliation_v1(req,request);
  assert (result->>'remaining')::numeric=40, 'partial resolution keeps rest';
  child:=(result->>'residualItemId')::bigint;
  assert (select source_kind='closure' and source_id=(c->>'closureId')::bigint and amount=40 from public.money_account_reconciliation_items where id=child),'residual retains actual source';
  assert (select count(*)=n from public.money_movements where money_account_id=9000000201),'link creates no money';
  assert (public.preview_account_closure_v2(9000000201,clock_timestamp()+interval '1 second')->>'expectedAmount')::numeric=140,'only proven portion excluded from observed balance';
  select balance_native into balance from app_private.admin_finance_account_snapshots_v2(clock_timestamp()+interval '1 second') where account_id=9000000201;
  assert balance=140,'account and closure agree';
  assert public.resolve_account_reconciliation_v1(req,request)->>'replayed'='true','retry does not duplicate';
  failed:=false; begin perform public.resolve_account_reconciliation_v1(req,request||'{"amount":61}'); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'retry payload bound';
  failed:=false; begin update public.money_movements set status='voided' where id=movement; exception when invalid_parameter_value then failed:=true; end;
  assert failed,'linked money protected';
  failed:=false; begin perform public.void_account_closure_v1((c->>'closureId')::bigint,'prueba de cierre resuelto'); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'resolved source cannot be voided';
  d:=public.admin_account_reconciliation_detail_v1(child);
  assert (d->'candidates'->0->>'available')::numeric=40,'unallocated amount shown';
  failed:=false; begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),request||jsonb_build_object('itemId',child,'fingerprint',d->>'fingerprint','amount',41)); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'cannot exceed residual';
  result:=public.resolve_account_reconciliation_v1(gen_random_uuid(),request||jsonb_build_object('itemId',child,'fingerprint',d->>'fingerprint','amount',40));
  assert (public.preview_account_closure_v2(9000000201,clock_timestamp()+interval '1 second')->>'expectedAmount')::numeric=100,'full evidence avoids double counting';
  failed:=false; begin perform public.undo_account_reconciliation_v1(req,'revisar abono anterior'); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'cannot undo parent before child';
  perform public.undo_account_reconciliation_v1((result->>'requestId')::uuid,'revisar evidencia del pago');
  perform public.undo_account_reconciliation_v1(req,'revisar evidencia del pago');
  assert (select status='confirmed' from public.money_movements where id=movement),'existing movement preserved';
  assert (select status='open' and amount=100 from public.money_account_reconciliation_items where id=(c->>'reconciliationItemId')::bigint),'restores original difference';
  assert (select expected_amount=0 and counted_amount=100 from public.money_account_closures where id=(c->>'closureId')::bigint),'historical snapshot unchanged';
  assert public.undo_account_reconciliation_v1(req,'repetir reversión segura')->>'replayed'='true';

  -- New fee: VES, partial residual of exactly one native cent stays open.
  insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,direction,movement_type,amount,amount_usd_equivalent,exchange_rate_ves_per_usd)
  values(9000000202,'VES',today,auth.uid(),cut_at,auth.uid(),'inflow','other_income',200,20,10);
  c:=public.create_account_closure_v1(gen_random_uuid(),jsonb_build_object('moneyAccountId',9000000202,'closureDate',today,'closureTime','00:00:01','countedAmount',100,'exchangeRateVesPerUsd',10));
  d:=public.admin_account_reconciliation_detail_v1((c->>'reconciliationItemId')::bigint);
  req:=gen_random_uuid();
  request:=jsonb_build_object('itemId',c->'reconciliationItemId','mode','fee','amount',99.99,'note','Comisión bancaria no registrada',
    'fingerprint',d->>'fingerprint','movementDate',today,'rate',10,'evidenceConfirmed',true);
  result:=public.resolve_account_reconciliation_v1(req,request);
  assert (result->>'remaining')::numeric=0.01,'native cent must not disappear';
  assert (select movement_type='fee_charge' and amount=99.99 from public.money_movements where id=(result->>'movementId')::bigint);
  assert (public.preview_account_closure_v2(9000000202,clock_timestamp()+interval '1 second')->>'expectedAmount')::numeric=100,'new late fee already in observed bank';
  perform public.undo_account_reconciliation_v1(req,'anular ajuste de prueba');
  assert (select status='voided' from public.money_movements where id=(result->>'movementId')::bigint),'only generated fee voided';
  d:=public.admin_account_reconciliation_detail_v1((c->>'reconciliationItemId')::bigint);
  failed:=false; begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),request||jsonb_build_object('fingerprint',d->>'fingerprint','mode','income')); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'wrong sign rejected';
  failed:=false; begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),request||jsonb_build_object('fingerprint',d->>'fingerprint','rate',0)); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'invalid rate rejected';
  failed:=false; begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),request||jsonb_build_object('fingerprint',d->>'fingerprint','evidenceConfirmed',false)); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'evidence acknowledgment required';
end $test$;

set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin update public.money_account_reconciliation_items set status='resolved' where money_account_id=9000000201 and status='open'; exception when insufficient_privilege then failed:=true; end;
  assert failed,'direct resolution bypass blocked';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='advisor' and user_id not in(select user_id from public.user_roles where role in ('master','admin')) limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.admin_account_reconciliation_detail_v1(1); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor read denied';
  failed:=false; begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor write denied';
  assert (select count(*)=0 from public.account_reconciliation_resolutions),'advisor has no evidence rows';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.admin_account_reconciliation_detail_v1(1); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous read denied';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
do $$ declare req uuid:=gen_random_uuid(); result jsonb; input jsonb; n bigint; failed boolean; begin
  input:='{"moneyAccountId":9000000201,"direction":"outflow","amount":10,"feeAmount":1,"movementDate":"2026-09-15","description":"Egreso de prueba"}';
  select count(*) into n from public.money_movements where money_account_id=9000000201;
  result:=public.create_admin_cash_operation_v1(req,input);
  assert (result->>'totalUsd')::numeric=11;
  assert (select count(*)=2 from jsonb_array_elements(public.admin_finance_account_detail_v2(9000000201,'movements','2026-09-15','2026-09-15','all',50,0)->'rows') x where x->>'operationRequestId'=req::text),'history links both movement legs to receipt';
  assert (select count(*)=n+2 from public.money_movements where money_account_id=9000000201),'principal and fee together';
  assert public.create_admin_cash_operation_v1(req,input)->>'replayed'='true';
  assert (select count(*)=n+2 from public.money_movements where money_account_id=9000000201),'replay creates nothing';
  failed:=false;begin perform public.create_admin_cash_operation_v1(req,input||'{"amount":20}');exception when invalid_parameter_value then failed:=true;end;
  assert failed,'identity bound to exact amount';
  failed:=false;begin perform public.create_admin_cash_operation_v1(gen_random_uuid(),input||'{"amount":0.001}');exception when invalid_parameter_value then failed:=true;end;
  assert failed,'subcent cash rejected';
  failed:=false;begin perform public.create_admin_cash_operation_v1(gen_random_uuid(),input||'{"direction":"inflow"}');exception when invalid_parameter_value then failed:=true;end;
  assert failed,'income cannot hide expense fee';
  result:=public.create_admin_cash_operation_v1(gen_random_uuid(),input||'{"moneyAccountId":9000000202,"amount":1000,"feeAmount":10,"exchangeRateVesPerUsd":100}');
  assert (result->>'totalUsd')::numeric=10.1,'VES principal and fee at supplied rate';
end $$;
reset role;
-- Inject a failure at the final receipt write: no cash or difference can remain.
create function pg_temp.fail_reconciliation_receipt() returns trigger language plpgsql as $$ begin raise exception 'ROLLBACK forced receipt failure';end $$;
create trigger rollback_fail_receipt before insert on public.account_reconciliation_resolutions for each row execute function pg_temp.fail_reconciliation_receipt();
do $$ declare d jsonb; n bigint; failed boolean:=false; item_id bigint; begin
  select id into item_id from public.money_account_reconciliation_items where money_account_id=9000000202 and status='open' limit 1;
  d:=public.admin_account_reconciliation_detail_v1(item_id);
  select count(*) into n from public.money_movements where money_account_id=9000000202;
  begin perform public.resolve_account_reconciliation_v1(gen_random_uuid(),jsonb_build_object('itemId',item_id,'mode','fee','amount',1,'rate',100,'movementDate','2026-09-15','note','Comisión de prueba transaccional','fingerprint',d->>'fingerprint','evidenceConfirmed',true));
  exception when raise_exception then failed:=true;end;
  assert failed;
  assert (select count(*)=n from public.money_movements where money_account_id=9000000202),'failure leaves no money';
  assert (select status='open' from public.money_account_reconciliation_items where id=item_id),'failure leaves difference open';
end $$;
drop trigger rollback_fail_receipt on public.account_reconciliation_resolutions;
select 'reconciliation and cash rollback assertions passed' as result;
