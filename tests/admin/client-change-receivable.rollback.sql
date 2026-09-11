-- Run after migration body, with BEGIN and ROLLBACK. Synthetic fixtures only.
insert into public.money_accounts(id,name,currency_code,account_kind) values
 (9000000080,'ROLLBACK change USD','USD','cash'),(9000000081,'ROLLBACK change VES','VES','cash');
insert into public.clients(id,full_name) values(9000000080,'ROLLBACK change client');
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,attributed_advisor_id,extra_fields)
select id,'ROLLBACK-CHANGE-'||id,'master','pickup','ready',9000000080,10,1000,
 (select user_id from public.user_roles where role='advisor' limit 1),
 '{"pricing":{"total_usd":10,"total_bs":1000,"fx_rate":100}}'
from generate_series(9000000080::bigint,9000000083::bigint) id;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_money_account_id,operation_date)
select id,id,auth.uid(),'USD',14.73,14.73,9000000080,'2026-09-11' from generate_series(9000000080::bigint,9000000083::bigint) id;
create function app_private.test_change_failure() returns trigger language plpgsql as $$
begin if new.order_id between 9000000080 and 9000000083 and current_setting('test.change.fail',true)='on' then
 raise exception 'synthetic late history failure' using errcode='23514'; end if; return new; end $$;
create trigger test_change_failure before insert on public.order_timeline_events for each row execute function app_private.test_change_failure();
set local role authenticated;
do $$
declare r jsonb; req jsonb; pay jsonb; failed boolean; v_movement_id bigint; balance numeric;
begin
 pay:='{"reportId":9000000080,"orderId":9000000080,"accountId":9000000080,"currency":"USD","amount":14.73,"date":"2026-09-11","handling":"store_fund","changeLines":[],"expectedChangeDebtUsd":0}';
 perform public.confirm_payment_report_atomic_v1(pay);
 assert (select pending_usd=0 and confirmed_paid_usd=10 from public.get_order_financial_state(9000000080)), 'initial order fully paid';
 assert (select fund_balance_usd=4.73 from public.clients where id=9000000080), 'stored actual change';
 req:='{"orderId":9000000080,"expectedDifferenceUsd":0.27,"lines":[{"moneyAccountId":9000000080,"currencyCode":"USD","amount":5}]}';
 perform set_config('test.change.fail','on',true); failed:=false;
 begin perform public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000080',req); exception when check_violation then failed:=true; end;
 assert failed, 'late failure injected';
 assert (select fund_balance_usd=4.73 from public.clients where id=9000000080), 'balance rollback';
 assert not exists(select 1 from public.money_movements where movement_group_id='00000000-0000-4000-8000-000000000080'), 'cash rollback';
 assert not exists(select 1 from public.client_fund_payout_operations where order_id=9000000080), 'receipt rollback';
 perform set_config('test.change.fail','off',true);
 r:=public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000080',req);
 assert (r->>'differenceUsd')::numeric=0.27, '4.73 paid with 5 creates 0.27';
 assert (select fund_balance_usd=0 from public.clients where id=9000000080), 'fund never negative';
 assert (select pending_usd=0.27 and pending_bs=27 and confirmed_paid_usd=9.73 and payment_status='partial' from public.get_order_financial_state(9000000080)), 'canonical USD and VES debt, no false exact snapshot closure';
 assert (public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000080',req)->>'replayed')='true', 'retry no duplicated money';
 failed:=false;
 begin perform public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000080',req||'{"expectedDifferenceUsd":0}'); exception when invalid_parameter_value then failed:=true; end;
 assert failed, 'changed retry rejected';
 v_movement_id:=(r->'movementIds'->>0)::bigint;
 failed:=false;
 begin update public.money_movements set status='voided' where id=v_movement_id and movement_group_id='00000000-0000-4000-8000-000000000080'; exception when check_violation or insufficient_privilege then failed:=true; end;
 assert failed or (select status='confirmed' from public.money_movements where id=v_movement_id), 'uncertified partial reversal prevented';
 perform set_config('test.change.fail','on',true); failed:=false;
 begin perform public.void_financial_movement_v1(v_movement_id,null,'Anulación prueba'); exception when check_violation then failed:=true; end;
 assert failed and (select fund_balance_usd=0 from public.clients where id=9000000080), 'void late failure rollback';
 perform set_config('test.change.fail','off',true);
 perform public.void_financial_movement_v1(v_movement_id,null,'Anulación prueba');
 assert (select fund_balance_usd=4.73 from public.clients where id=9000000080), 'void restores exact debit';
 assert (select pending_usd=0 from public.get_order_financial_state(9000000080)), 'void removes debt';
 perform public.void_financial_movement_v1(v_movement_id,null,'Anulación prueba');
 assert (select fund_balance_usd=4.73 from public.clients where id=9000000080), 'void retry restores once';
 -- 3 USD + 200 VES at 100 = 5 USD, same receivable.
 req:=req||'{"lines":[{"moneyAccountId":9000000080,"currencyCode":"USD","amount":3},{"moneyAccountId":9000000081,"currencyCode":"VES","amount":200,"exchangeRateVesPerUsd":100}]}';
 r:=public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000081',req);
 assert jsonb_array_length(r->'movementIds')=2, 'multicurrency payout';
 assert (select pending_usd=0.27 from public.get_order_financial_state(9000000080)), 'same debt with mixed currency';
 -- New confirmed payment clears the difference.
 pay:=pay||'{"reportId":9000000081,"orderId":9000000081,"handling":"change_given","changeLines":[{"accountId":9000000080,"currency":"USD","amount":5}],"expectedChangeDebtUsd":0.27,"requireExactChange":true}';
 r:=public.confirm_payment_report_atomic_v1(pay);
 assert (select pending_usd=0.27 and pending_bs=27 from public.get_order_financial_state(9000000081)), 'direct confirmation change creates debt';
 failed:=false;
 begin perform public.confirm_payment_report_atomic_v1(pay||'{"reportId":9000000082,"orderId":9000000082,"expectedChangeDebtUsd":0}'); exception when invalid_parameter_value then failed:=true; end;
 assert failed and (select status='pending' from public.payment_reports where id=9000000082), 'unexpected debt fails atomically';
 perform public.confirm_payment_report_atomic_v1(pay||'{"reportId":9000000082,"orderId":9000000082,"handling":"store_fund","changeLines":[],"expectedChangeDebtUsd":0}');
 select fund_balance_usd into balance from public.clients where id=9000000080;
 foreach req in array array[
 '{"orderId":9000000080,"lines":[{"moneyAccountId":9000000080,"currencyCode":"USD","amount":"NaN"}]}',
 '{"orderId":9000000080,"lines":[{"moneyAccountId":9000000080,"currencyCode":"VES","amount":5,"exchangeRateVesPerUsd":100}]}',
 '{"orderId":9000000080,"lines":[{"moneyAccountId":9000000081,"currencyCode":"VES","amount":5,"exchangeRateVesPerUsd":0}]}']::jsonb[] loop
  failed:=false; begin perform public.settle_client_fund_payout_v1(gen_random_uuid(),req); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'invalid request rejected';
 end loop;
 assert (select fund_balance_usd=balance from public.clients where id=9000000080), 'invalid requests do not alter fund';
 failed:=false;
 begin perform public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000082','{"orderId":9000000082,"expectedDifferenceUsd":0,"lines":[{"moneyAccountId":9000000080,"currencyCode":"USD","amount":5}]}'); exception when invalid_parameter_value then failed:=true; end;
 assert failed, 'unacknowledged difference refused';
 r:=public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000082','{"orderId":9000000082,"expectedDifferenceUsd":0,"lines":[{"moneyAccountId":9000000080,"currencyCode":"USD","amount":4.73}]}');
 assert (r->>'differenceUsd')::numeric=0 and (select pending_usd=0 from public.get_order_financial_state(9000000082)), 'exact payout no debt';
end $$;
reset role;
do $$ declare failed boolean:=false; begin
 begin update public.money_movements set amount=amount+1 where movement_group_id='00000000-0000-4000-8000-000000000081'; exception when check_violation then failed:=true; end;
 assert failed, 'certified amounts immutable even with table write access';
 failed:=false;
 begin update public.money_movements set status='voided' where movement_group_id='00000000-0000-4000-8000-000000000081'; exception when check_violation then failed:=true; end;
 assert failed, 'void requires restoring fund in command';
end $$;
-- Simulate advisor view and subsequent payment report; not a real business row.
select set_config('request.jwt.claim.sub',(select attributed_advisor_id::text from public.orders where id=9000000080),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
 assert (select pending_usd=0.27 from public.get_order_financial_state(9000000080)), 'advisor sees payout debt';
 assert (select pending_usd=0.27 from public.get_order_financial_state(9000000081)), 'advisor sees confirmation debt';
 begin perform public.settle_client_fund_payout_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
 assert failed, 'advisor cannot pay out';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
values(9000000084,9000000080,auth.uid(),'VES',27,0.27,9000000081,'2026-09-11',100);
set local role authenticated;
do $$ begin
 perform public.confirm_payment_report_atomic_v1('{"reportId":9000000084,"orderId":9000000080,"accountId":9000000081,"currency":"VES","amount":27,"rate":100,"date":"2026-09-11","changeLines":[],"expectedChangeDebtUsd":0}');
 assert (select pending_usd=0 and payment_status='paid' from public.get_order_financial_state(9000000080)), 'mobile payment settles 0.27';
end $$;
reset role;
set constraints all immediate;
-- All non-financial roles and anonymous calls are rejected.
do $$ declare u record; failed boolean; begin
 for u in select distinct user_id from public.user_roles where role not in ('admin','master')
   and user_id not in(select user_id from public.user_roles where role in ('admin','master')) loop
  perform set_config('request.jwt.claim.sub',u.user_id::text,true); failed:=false;
  begin perform public.settle_client_fund_payout_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'non-financial role denied';
 end loop;
 perform set_config('request.jwt.claim.sub','',true);
 failed:=false; begin perform public.settle_client_fund_payout_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
 assert failed, 'session required';
 assert not has_function_privilege('anon','public.settle_client_fund_payout_v1(uuid,jsonb)','execute'), 'anonymous RPC denied';
end $$;
rollback;
