-- Synthetic fixtures only. Run inside BEGIN/ROLLBACK; never commit these rows.
insert into public.money_accounts(id,name,currency_code,account_kind) values
 (9000000100,'ROLLBACK cancel USD','USD','cash'),(9000000101,'ROLLBACK cancel VES','VES','cash');
insert into public.clients(id,full_name) select id,'ROLLBACK cancel '||id from generate_series(9000000100::bigint,9000000110::bigint) id;
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
select id,'ROLLBACK-CANCEL-'||id,'master','pickup','ready',id,100,10000,
 '{"pricing":{"total_usd":100,"total_bs":10000,"fx_rate":100}}'
from generate_series(9000000100::bigint,9000000110::bigint) id;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_money_account_id,operation_date)
select id,id,auth.uid(),'USD',120,120,9000000100,'2026-09-11' from generate_series(9000000101::bigint,9000000103::bigint) id;
create function app_private.test_cancel_failure() returns trigger language plpgsql as $$
begin if new.order_id between 9000000100 and 9000000110 and current_setting('test.cancel.fail',true)='on' then
 raise exception 'synthetic late history failure' using errcode='23514'; end if; return new; end $$;
create trigger test_cancel_failure before insert on public.order_timeline_events for each row execute function app_private.test_cancel_failure();
set local role authenticated;
do $$
declare req jsonb; p jsonb; r jsonb; failed boolean; oid bigint;
begin
 p:=public.preview_order_cancellation_v1(9000000100);
 assert (p->>'cashAvailableUsd')::numeric=0 and not(p ? 'money'), 'empty order and safe preview';
 req:=jsonb_build_object('orderId',9000000100,'reason','Prueba sin dinero','fingerprint',p->>'fingerprint','refundLines','[]'::jsonb);
 r:=public.cancel_order_atomic_v1('00000000-0000-4000-8000-000000000100',req);
 assert (select status='cancelled' from public.orders where id=9000000100), 'no-money cancellation';
 assert (public.cancel_order_atomic_v1('00000000-0000-4000-8000-000000000100',req)->>'replayed')='true', 'retry is safe';
 failed:=false;
 begin perform public.cancel_order_atomic_v1(gen_random_uuid(),req); exception when invalid_parameter_value then failed:=true; end;
 assert failed, 'new key cannot cancel twice';
 for oid in select generate_series(9000000101::bigint,9000000103::bigint) loop
  perform public.confirm_payment_report_atomic_v1(jsonb_build_object('reportId',oid,'orderId',oid,'accountId',9000000100,'currency','USD',
   'amount',120,'date','2026-09-11','handling','store_fund','changeLines','[]'::jsonb,'expectedChangeDebtUsd',0));
  p:=public.preview_order_cancellation_v1(oid);
  assert (p->>'cashAvailableUsd')::numeric=100 and (p->>'alreadyStoredUsd')::numeric=20, 'excess excluded from refundable cash';
 end loop;
 p:=public.preview_order_cancellation_v1(9000000101);
 req:=jsonb_build_object('orderId',9000000101,'reason','Prueba saldo a favor','fingerprint',p->>'fingerprint','paidHandling','store_fund','refundLines','[]'::jsonb);
 perform set_config('test.cancel.fail','on',true); failed:=false;
 begin perform public.cancel_order_atomic_v1('00000000-0000-4000-8000-000000000101',req); exception when check_violation then failed:=true; end;
 assert failed, 'late failure injected';
 assert (select fund_balance_usd=20 from public.clients where id=9000000101), 'fund rollback';
 assert (select status='ready' from public.orders where id=9000000101), 'order rollback';
 assert not exists(select 1 from public.order_cancellation_operations where order_id=9000000101), 'receipt rollback';
 perform set_config('test.cancel.fail','off',true);
 perform public.cancel_order_atomic_v1('00000000-0000-4000-8000-000000000101',req);
 assert (select fund_balance_usd=120 from public.clients where id=9000000101), '120 becomes 120 not 140';
 p:=public.preview_order_cancellation_v1(9000000102);
 req:=jsonb_build_object('orderId',9000000102,'reason','Prueba devolución parcial','fingerprint',p->>'fingerprint','paidHandling','refund',
 'refundLines','[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":40},{"moneyAccountId":9000000101,"currencyCode":"VES","amount":1000,"exchangeRateVesPerUsd":100}]'::jsonb);
 failed:=false;
 begin perform public.cancel_order_atomic_v1(gen_random_uuid(),req||'{"requireExactRefund":true}'); exception when invalid_parameter_value then failed:=true; end;
 assert failed, 'Ops exact refund enforced';
 perform public.cancel_order_atomic_v1('00000000-0000-4000-8000-000000000102',req);
 assert (select fund_balance_usd=70 from public.clients where id=9000000102), 'partial refund leaves correct fund';
 assert (select sum(amount_usd_equivalent)=50 from public.money_movements where order_id=9000000102 and direction='outflow'), 'actual mixed refund';
end $$;
reset role;
-- Previously spent excess remains spent; restoring cancellation must not credit it again.
update public.clients set fund_balance_usd=0 where id=9000000103;
insert into public.client_fund_movements(client_id,movement_type,currency_code,amount,amount_usd,reason_code,created_by_user_id)
values(9000000103,'debit','USD',20,20,'order_fund_applied',auth.uid());
set local role authenticated;
do $$ declare p jsonb; begin
 p:=public.preview_order_cancellation_v1(9000000103);
 perform public.cancel_order_atomic_v1(gen_random_uuid(),jsonb_build_object('orderId',9000000103,'reason','Excedente ya usado','fingerprint',p->>'fingerprint','paidHandling','store_fund','refundLines','[]'::jsonb));
 assert (select fund_balance_usd=100 from public.clients where id=9000000103), 'spent excess not credited twice';
end $$;
reset role;
-- All changes to a certified cancellation's financial basis fail, including privileged table writes.
update public.clients set fund_balance_usd=10 where id=9000000104;
update public.orders set extra_fields=jsonb_set(extra_fields,'{payment}','{"client_fund_used_usd":30}') where id=9000000104;
insert into public.client_fund_movements(client_id,order_id,movement_type,currency_code,amount,amount_usd,reason_code,created_by_user_id) values
 (9000000104,9000000104,'debit','USD',30,30,'order_fund_applied',auth.uid()),
 (9000000104,9000000104,'credit','USD',10,10,'order_fund_restore',auth.uid()),
 (9000000108,9000000108,'debit','USD',5,5,'counter_change_fund_reversal',auth.uid());
insert into public.money_movements(movement_date,order_id,money_account_id,direction,movement_type,currency_code,amount,amount_usd_equivalent,status,created_by_user_id,confirmed_by_user_id,confirmed_at)
values('2026-09-11',9000000104,9000000100,'inflow','order_payment','USD',40,40,'confirmed',auth.uid(),auth.uid(),now()),
 ('2026-09-11',9000000107,9000000100,'inflow','order_payment','USD',10,10,'confirmed',auth.uid(),auth.uid(),now()),
 ('2026-09-11',9000000109,9000000100,'inflow','order_payment','USD',10,10,'pending',auth.uid(),null,null);
insert into public.money_movements(movement_date,order_id,money_account_id,direction,movement_type,currency_code,amount,exchange_rate_ves_per_usd,amount_usd_equivalent,status,created_by_user_id,confirmed_by_user_id,confirmed_at)
values('2026-09-11',9000000106,9000000101,'inflow','order_payment','VES',10000,125,80,'confirmed',auth.uid(),auth.uid(),now());
update public.orders set total_usd=10,total_bs_snapshot=1000,extra_fields='{"pricing":{"total_usd":10,"total_bs":1000,"fx_rate":100}}' where id=9000000105;
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_money_account_id,operation_date)
values(9000000105,9000000105,auth.uid(),'USD',14.73,14.73,9000000100,'2026-09-11'),
 (9000000107,9000000107,auth.uid(),'USD',10,10,9000000100,'2026-09-11');
do $$ declare failed boolean:=false; begin
 begin update public.orders set status='cancelled' where id=9000000104; exception when check_violation then failed:=true; end;
 assert failed, 'direct cancellation cannot bypass settlement';
end $$;
set local role authenticated;
do $$ declare p jsonb; req jsonb; failed boolean; bad jsonb; begin
 p:=public.preview_order_cancellation_v1(9000000104);
 assert (p->>'fundUsedUsd')::numeric=20, 'net applied fund wins over stale 30 snapshot';
 perform public.cancel_order_atomic_v1(gen_random_uuid(),jsonb_build_object('orderId',9000000104,'reason','Fondo aplicado neto','fingerprint',p->>'fingerprint','paidHandling','store_fund','refundLines','[]'::jsonb));
 assert (select fund_balance_usd=70 from public.clients where id=9000000104), '40 cash plus 20 remaining applied restored';
 perform public.confirm_payment_report_atomic_v1('{"reportId":9000000105,"orderId":9000000105,"accountId":9000000100,"currency":"USD","amount":14.73,"date":"2026-09-11","handling":"store_fund","changeLines":[],"expectedChangeDebtUsd":0}');
 perform public.settle_client_fund_payout_v1('00000000-0000-4000-8000-000000000105','{"orderId":9000000105,"expectedDifferenceUsd":0.27,"lines":[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":5}]}');
 p:=public.preview_order_cancellation_v1(9000000105);
 assert (p->>'cashAvailableUsd')::numeric=9.73, 'advance change deducted exactly';
 perform public.cancel_order_atomic_v1(gen_random_uuid(),jsonb_build_object('orderId',9000000105,'reason','Cambio entregado antes','fingerprint',p->>'fingerprint','paidHandling','refund','requireExactRefund',true,
 'refundLines','[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":9.73}]'::jsonb));
 assert (select fund_balance_usd=0 from public.clients where id=9000000105), 'used change is not credited again';
 assert (select status='cancelled' from public.orders where id=9000000105), 'cancelled after change advance';
 p:=public.preview_order_cancellation_v1(9000000106);
 assert (p->>'cashAvailableUsd')::numeric=80, 'actual USD valuation not invoice total 100';
 perform public.cancel_order_atomic_v1(gen_random_uuid(),jsonb_build_object('orderId',9000000106,'reason','Valor real de Bs','fingerprint',p->>'fingerprint','paidHandling','store_fund','refundLines','[]'::jsonb));
 assert (select fund_balance_usd=80 from public.clients where id=9000000106), 'actual value credited';
 p:=public.preview_order_cancellation_v1(9000000107);
 req:=jsonb_build_object('orderId',9000000107,'reason','Reporte pendiente','fingerprint',p->>'fingerprint','paidHandling','refund',
 'refundLines','[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":10}]'::jsonb);
 failed:=false;
 begin perform public.cancel_order_atomic_v1(gen_random_uuid(),req||'{"fingerprint":"stale"}'); exception when invalid_parameter_value then failed:=true; end; assert failed, 'stale preview rejected';
 foreach bad in array array[
  '[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":11}]',
  '[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":"NaN"}]',
  '[{"moneyAccountId":9000000100,"currencyCode":"VES","amount":10,"exchangeRateVesPerUsd":100}]',
  '[{"moneyAccountId":9000000101,"currencyCode":"VES","amount":10,"exchangeRateVesPerUsd":0}]',
  '[{"moneyAccountId":9000000100,"currencyCode":"USD","amount":0.001}]'
 ]::jsonb[] loop
  failed:=false; begin perform public.cancel_order_atomic_v1(gen_random_uuid(),req||jsonb_build_object('refundLines',bad)); exception when invalid_parameter_value then failed:=true; end; assert failed, 'invalid refund rejected';
 end loop;
 perform set_config('test.cancel.fail','on',true); failed:=false;
 begin perform public.cancel_order_atomic_v1(gen_random_uuid(),req); exception when check_violation then failed:=true; end; assert failed, 'late refund failure';
 assert (select status='pending' from public.payment_reports where id=9000000107), 'report rejection rollback';
 assert not exists(select 1 from public.money_movements where order_id=9000000107 and direction='outflow'), 'refund rollback';
 perform set_config('test.cancel.fail','off',true);
 perform public.cancel_order_atomic_v1(gen_random_uuid(),req);
 assert (select status='rejected' from public.payment_reports where id=9000000107), 'pending report rejected atomically';
 failed:=false; begin perform public.preview_order_cancellation_v1(9000000108); exception when invalid_parameter_value then failed:=true; end; assert failed, 'ambiguous legacy fund blocked';
 failed:=false; begin perform public.preview_order_cancellation_v1(9000000109); exception when invalid_parameter_value then failed:=true; end; assert failed, 'pending money blocked';
end $$;
reset role;
do $$ declare failed boolean; begin
 failed:=false; begin update public.orders set status='ready' where id=9000000101; exception when check_violation then failed:=true; end; assert failed, 'cannot reopen settled cancellation';
 failed:=false; begin update public.money_movements set status='voided' where order_id=9000000101; exception when check_violation then failed:=true; end; assert failed, 'cannot void payment after refund';
 failed:=false; begin update public.payment_reports set status='pending' where order_id=9000000101; exception when check_violation then failed:=true; end; assert failed, 'cannot revive payment report';
 failed:=false; begin delete from public.client_fund_movements where order_id=9000000101; exception when check_violation then failed:=true; end; assert failed, 'cannot remove settled fund';
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='master' limit 1),true);
set local role authenticated;
do $$ declare p jsonb; begin
 p:=public.preview_order_cancellation_v1(9000000110);
 perform public.cancel_order_atomic_v1(gen_random_uuid(),jsonb_build_object('orderId',9000000110,'reason','Permiso Master','fingerprint',p->>'fingerprint','refundLines','[]'::jsonb));
 assert (select status='cancelled' from public.orders where id=9000000110), 'Master permitted';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='advisor' limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
 begin perform public.preview_order_cancellation_v1(9000000104); exception when insufficient_privilege then failed:=true; end; assert failed, 'advisor preview denied';
 failed:=false; begin perform public.cancel_order_atomic_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end; assert failed, 'advisor cancel denied';
 assert not exists(select 1 from public.order_cancellation_operations), 'advisor cannot read cancellation receipts';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
 begin perform public.preview_order_cancellation_v1(9000000104); exception when insufficient_privilege then failed:=true; end; assert failed, 'anonymous preview denied';
 failed:=false; begin perform public.cancel_order_atomic_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end; assert failed, 'anonymous cancel denied';
end $$;
reset role;
select 'order cancellation rollback tests passed' as result;
rollback;
