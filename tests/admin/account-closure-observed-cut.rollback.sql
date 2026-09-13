-- Synthetic fixture only. Caller wraps migration + this file in BEGIN/ROLLBACK.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_accounts(id,name,currency_code,account_kind)
values(9000000101,'ROLLBACK observed bank','USD','bank'),(9000000102,'ROLLBACK observed wallet','USD','wallet');
insert into public.money_account_closure_profiles(money_account_id,closure_kind,allows_classified_difference)
values(9000000101,'bank',true),(9000000102,'wallet_usd',true);
insert into public.money_account_closure_baselines(money_account_id,baseline_date,baseline_at,currency_code,counted_amount,counted_amount_usd,created_by_user_id)
values(9000000101,'2026-09-02','2026-09-02T09:00:10-04:00','USD',100,100,auth.uid());
insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,amount,amount_usd_equivalent)
values
  (9000000101,'USD','2026-09-02',auth.uid(),'2026-09-02T09:00:05-04:00',auth.uid(),'inflow','other_income',100,100),
  (9000000101,'USD','2026-09-02',auth.uid(),'2026-09-02T09:30:00-04:00',auth.uid(),'inflow','other_income',20,20),
  (9000000101,'USD','2026-09-02',auth.uid(),'2026-09-02T10:00:30-04:00',auth.uid(),'outflow','expense_payment',7,7),
  (9000000101,'USD','2026-09-03',auth.uid(),'2026-09-03T09:00:00-04:00',auth.uid(),'inflow','other_income',3,3),
  -- Report from a day before the anchor, confirmed later: not new cash.
  (9000000101,'USD','2026-09-01',auth.uid(),'2026-09-03T09:00:00-04:00',auth.uid(),'inflow','other_income',500,500),
  -- Operation after the selected financial date is not included even if loaded early.
  (9000000101,'USD','2026-09-04',auth.uid(),'2026-09-02T09:00:00-04:00',auth.uid(),'inflow','other_income',900,900);
insert into public.money_movements(money_account_id,currency_code,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,amount,amount_usd_equivalent)
select 9000000102,'USD','2026-09-02',auth.uid(),'2026-09-02T09:00:00-04:00',auth.uid(),'inflow','other_income',1,1
from generate_series(1,1001);
set local role authenticated;
do $$
declare preview jsonb; result jsonb; req jsonb; first_id bigint; first_snapshot jsonb; failed boolean; total_before bigint;
begin
  select count(*) into total_before from public.money_account_closures where money_account_id=9000000101;
  preview:=public.preview_account_closure_v2(9000000101,'2026-09-02T10:00:00-04:00');
  assert (preview->>'expectedAmount')::numeric=120, 'baseline uses its time, not whole baseline day';
  assert not(preview ? 'movements') and not(preview ? 'previousClosure'), 'public preview minimizes payload';
  assert (select count(*)=total_before from public.money_account_closures where money_account_id=9000000101), 'preview is read-only';
  req:='{"moneyAccountId":9000000101,"closureDate":"2026-09-02","closureTime":"10:00:00","countedAmount":120}';
  result:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000101',req);
  first_id:=(result->>'closureId')::bigint;
  assert result->>'expectedAmount'=preview->>'expectedAmount', 'preview and command agree';
  select snapshot into first_snapshot from public.account_closure_operations where closure_id=first_id;
  preview:=public.preview_account_closure_v2(9000000101,'2026-09-02T10:00:29-04:00');
  assert (preview->>'expectedAmount')::numeric=120, 'seconds before movement excluded';
  preview:=public.preview_account_closure_v2(9000000101,'2026-09-02T10:00:30-04:00');
  assert (preview->>'expectedAmount')::numeric=113, 'seconds at movement included once';
  result:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000102',req||'{"closureTime":"10:01:00","countedAmount":113}');
  assert (result->>'expectedAmount')::numeric=113, 'two bank observations same day are valid';
  assert (select snapshot=first_snapshot from public.account_closure_operations where closure_id=first_id), 'earlier snapshot unchanged';
  preview:=public.preview_account_closure_v2(9000000101,'2026-09-03T12:00:00-04:00');
  assert (preview->>'expectedAmount')::numeric=116, 'old backdated report not added on top of observed balance';
  assert (select counted_amount=120 and expected_amount=120 from public.money_account_closures where id=first_id), 'historical count and expected not restated';
  result:=public.create_account_closure_v1('00000000-0000-4000-8000-000000000101',req);
  assert result->>'replayed'='true' and (result->>'closureId')::bigint=first_id, 'retry returns original receipt after newer closure';
  failed:=false;
  begin perform public.create_account_closure_v1('00000000-0000-4000-8000-000000000103',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'same timestamp/new request rejected';
  preview:=public.preview_account_closure_v2(9000000102,'2026-09-02T12:00:00-04:00');
  assert (preview->>'expectedAmount')::numeric=1001, 'wallet projection has no REST row limit';
  failed:=false;
  begin perform app_private.account_closure_cut_v2(9000000101,now()); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'raw snapshots not callable by authenticated users';
end $$;
reset role;
do $$ declare balance numeric; preview jsonb; begin
  preview:=public.preview_account_closure_v2(9000000101,'2026-09-03T12:00:00-04:00');
  select balance_native into balance from app_private.admin_finance_account_snapshots_v2('2026-09-03T12:00:00-04:00') where account_id=9000000101;
  assert balance=(preview->>'expectedAmount')::numeric, 'Admin position and closure projection agree';
  select balance_native into balance from app_private.admin_finance_account_snapshots_v2('2026-09-02T10:01:00-04:00') where account_id=9000000101;
  assert balance=113, 'position at exact closure starts from counted amount';
end $$;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role in ('admin','master')) loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.preview_account_closure_v2(9000000101,now()); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'non-financial roles cannot preview';
    failed:=false;
    begin perform public.account_balance_snapshots_v2(null); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'non-financial roles cannot read bank snapshots';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.preview_account_closure_v2(9000000101,now()); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous cannot preview';
  failed:=false;
  begin perform public.account_balance_snapshots_v2(null); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous cannot read balances';
end $$;
reset role;
select 'observed cut assertions passed' as result;
