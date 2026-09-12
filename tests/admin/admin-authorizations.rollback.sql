-- Synthetic-only test. Caller MUST enclose the entire file in BEGIN / ROLLBACK.
insert into public.money_accounts(id,name,currency_code,account_kind,is_active) values
  (9000000031,'ROLLBACK approval USD','USD','cash',true),
  (9000000032,'ROLLBACK approval VES','VES','cash',true);
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_movements(id,movement_date,created_by_user_id,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,status,approval_required,description,movement_group_id) values
  (90000000311,'2026-09-12',auth.uid(),'outflow','expense_payment',9000000031,'USD',120,120,'pending',true,'ROLLBACK expense','00000000-0000-4000-8000-000000000031'),
  (90000000312,'2026-09-12',auth.uid(),'outflow','fee_charge',9000000031,'USD',2,2,'pending',true,'ROLLBACK fee','00000000-0000-4000-8000-000000000031'),
  (90000000313,'2026-09-12',auth.uid(),'outflow','expense_payment',9000000031,'USD',150,150,'pending',true,'ROLLBACK reject',null),
  (90000000314,'2026-09-12',auth.uid(),'outflow','expense_payment',9000000031,'USD',200,200,'pending',true,'ROLLBACK late failure','00000000-0000-4000-8000-000000000032'),
  (90000000315,'2026-09-12',auth.uid(),'outflow','fee_charge',9000000031,'USD',3,3,'pending',true,'ROLLBACK late fee','00000000-0000-4000-8000-000000000032'),
  (90000000316,'2026-09-12',auth.uid(),'inflow','other_income',9000000031,'USD',30,30,'pending',true,'ROLLBACK unsupported',null);
insert into public.money_movements(id,movement_date,created_by_user_id,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,exchange_rate_ves_per_usd,status,approval_required,description) values
  (90000000317,'2026-09-12',auth.uid(),'outflow','expense_payment',9000000032,'VES',30000,150,200,'pending',true,'ROLLBACK VES');
create function app_private.test_expense_review_failure() returns trigger language plpgsql as $$
begin
  if new.id=90000000315 and new.status='confirmed' then raise exception 'synthetic late failure' using errcode='23514'; end if;
  return new;
end $$;
create trigger test_expense_review_failure before update on public.money_movements for each row execute function app_private.test_expense_review_failure();
set local role authenticated;
do $$ declare review jsonb; receipt jsonb; failed boolean; stamp timestamptz; begin
  review:=public.admin_expense_review_v1(90000000311);
  assert (review->>'eligible')::boolean and jsonb_array_length(review->'rows')=2,'expense and fee reviewed together';
  receipt:=public.decide_admin_expense_v1(90000000311,review->>'snapshot','approve',null);
  assert receipt->>'status'='decided' and jsonb_array_length(receipt->'movementIds')=2,'decision receipt';
  assert (select count(*)=2 from public.money_movements where id in (90000000311,90000000312) and status='confirmed' and reviewed_by_user_id=auth.uid() and not approval_required),'atomic approval with actor';
  select reviewed_at into stamp from public.money_movements where id=90000000311;
  receipt:=public.decide_admin_expense_v1(90000000311,review->>'snapshot','approve',null);
  assert receipt->>'status'='stale' and (select reviewed_at=stamp from public.money_movements where id=90000000311),'retry cannot duplicate or rewrite decision';
  receipt:=public.decide_admin_expense_v1(90000000311,review->>'snapshot','reject','opposite');
  assert receipt->>'status'='stale','opposite concurrent decision refused';
  review:=public.admin_expense_review_v1(90000000313);
  failed:=false;
  begin perform public.decide_admin_expense_v1(90000000313,review->>'snapshot','reject',' '); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'reason required';
  receipt:=public.decide_admin_expense_v1(90000000313,repeat('0',32),'approve',null);
  assert receipt->>'status'='stale','stale reviewed content rejected';
  receipt:=public.decide_admin_expense_v1(90000000313,review->>'snapshot','reject','No corresponde');
  assert receipt->>'status'='decided' and (select status='rejected' and rejection_reason='No corresponde' and confirmed_at is null from public.money_movements where id=90000000313),'rejection records reason without expense';
  review:=public.admin_expense_review_v1(90000000314);
  failed:=false;
  begin perform public.decide_admin_expense_v1(90000000314,review->>'snapshot','approve',null); exception when check_violation then failed:=true; end;
  assert failed and (select count(*)=2 from public.money_movements where id in (90000000314,90000000315) and status='pending' and reviewed_at is null),'late failure rolls back all entries';
  review:=public.admin_expense_review_v1(90000000316);
  assert not (review->>'eligible')::boolean,'non-expense domain not approved';
  failed:=false;
  begin perform public.decide_admin_expense_v1(90000000316,review->>'snapshot','approve',null); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'server enforces operation domain';
  review:=public.admin_expense_review_v1(90000000317);
  receipt:=public.decide_admin_expense_v1(90000000317,review->>'snapshot','approve',null);
  assert receipt->>'status'='decided' and (select amount=30000 and amount_usd_equivalent=150 and exchange_rate_ves_per_usd=200 from public.money_movements where id=90000000317),'VES amounts and rate unchanged';
  receipt:=public.admin_authorizations_v1('expense',1);
  assert (receipt->>'total')::integer>=2 and jsonb_array_length(receipt->'rows')<=30,'bounded individual queue';
end $$;
reset role;
-- Real content and group membership changes invalidate the previous review.
do $$ declare review jsonb; receipt jsonb; begin
  review:=public.admin_expense_review_v1(90000000314);
  update public.money_movements set amount=201,amount_usd_equivalent=201 where id=90000000314;
  set local role authenticated;
  receipt:=public.decide_admin_expense_v1(90000000314,review->>'snapshot','approve',null);
  assert receipt->>'status'='stale','actual amount change detected';
  reset role;
  review:=public.admin_expense_review_v1(90000000314);
  update public.money_accounts set is_active=false where id=9000000031;
  set local role authenticated;
  receipt:=public.decide_admin_expense_v1(90000000314,review->>'snapshot','approve',null);
  assert receipt->>'status'='stale','inactive account invalidates review';
  assert not (public.admin_expense_review_v1(90000000314)->>'eligible')::boolean,'inactive account cannot be approved after refreshing';
end $$;
reset role;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.admin_authorizations_v1(); exception when insufficient_privilege then failed:=true; end;
    assert failed,'non-admin queue denied';
    failed:=false;
    begin perform public.admin_expense_review_v1(90000000314); exception when insufficient_privilege then failed:=true; end;
    assert failed,'non-admin detail denied';
    failed:=false;
    begin perform public.decide_admin_expense_v1(90000000314,repeat('0',32),'approve',null); exception when insufficient_privilege then failed:=true; end;
    assert failed,'non-admin decision denied';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean; begin
  failed:=false;
  begin perform public.admin_authorizations_v1(); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous queue denied';
  failed:=false;
  begin perform public.decide_admin_expense_v1(90000000314,repeat('0',32),'approve',null); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous decision denied';
end $$;
reset role;
set constraints all immediate;
select 'admin authorization rollback assertions passed' as result;
