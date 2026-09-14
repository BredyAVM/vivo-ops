-- Run after the migration in the same BEGIN, followed by ROLLBACK. Synthetic rows only.
insert into public.products(id,sku,name,type,is_active,internal_rider_pay_usd)
values(9000000081,'TEST-DELIVERY-SERVICE','Delivery test zone','service',true,2.5);
insert into public.money_accounts(id,name,currency_code,account_kind,is_active)
values(9000000081,'TEST DELIVERY USD','USD','cash',true),(9000000082,'TEST DELIVERY VES','VES','cash',true);
insert into public.orders(id,order_number,source,fulfillment,status,internal_driver_user_id,delivery_mode,extra_fields)
select n,'TEST-DELIVERY-'||n,'master','delivery','confirmed',
  (select id from public.profiles limit 1),'internal','{"delivery":{}}'::jsonb
from generate_series(9000000081::bigint,9000000085::bigint)n;
insert into public.order_items(order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,product_name_snapshot)
select n,9000000081,1,4,4,'Delivery test zone' from generate_series(9000000081::bigint,9000000084::bigint)n;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
do $$ declare r jsonb; begin
  r:=public.assign_delivery_with_cost_v1(9000000081,'internal',(select internal_driver_user_id from public.orders where id=9000000081),null,null,null,null);
  assert (r->>'cost_usd')::numeric=2.5 and r->>'source'='internal_product_tariff_v1','internal cost automatically saved';
  update public.products set internal_rider_pay_usd=3 where id=9000000081;
  r:=public.delivery_service_cost_v1(9000000081);
  assert (r->>'stored')::numeric=2.5 and (r->>'proposed')::numeric=3,'catalog cannot change saved cost';
  update public.products set internal_rider_pay_usd=2.5 where id=9000000081;
end $$;
reset role;
update public.orders set status='delivered' where id between 9000000081 and 9000000085;
insert into public.order_events(order_id,event,created_at) select n,'delivered','2026-09-10T12:00:00-04' from generate_series(9000000081::bigint,9000000085::bigint)n;
set local role authenticated;
do $$
declare r jsonb; inp jsonb; bad jsonb; failed boolean; mid bigint;
begin
  r:=public.admin_delivery_services_v1('2026-09-07','2026-09-13');
  assert (select count(*) from jsonb_array_elements(r->'rows')x where (x->>'id')::bigint between 9000000081 and 9000000085)=5,'complete period includes fixtures';
  inp:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14',
    'accountId',9000000081,'amount',5,'rate',null,'confirmedUnpaid',true,'confirmTariffs',false,
    'items',jsonb_build_array(
      jsonb_build_object('id',9000000081,'fingerprint',public.delivery_service_cost_v1(9000000081)->>'fingerprint'),
      jsonb_build_object('id',9000000082,'fingerprint',public.delivery_service_cost_v1(9000000082)->>'fingerprint')));
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000081',inp);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'historical proposals require explicit confirmation';
  inp:=inp||'{"confirmTariffs":true}'::jsonb;
  bad:=jsonb_set(inp,'{items,1,fingerprint}','"00000000000000000000000000000000"');
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000081',bad);
  exception when serialization_failure then failed:=true; end;
  assert failed,'stale preview rejected';
  assert not exists(select 1 from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000000081'),'failed preview creates no payment';
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000081',inp);
  mid:=(r->>'movementId')::bigint;
  assert (r->>'totalUsd')::numeric=5 and (r->>'deliveries')::int=2,'period paid at confirmed tariff';
  assert (select amount=5 and movement_type='expense_payment' and status='confirmed' from public.money_movements where id=mid),'single confirmed expense';
  assert (select count(*) from public.delivery_service_payment_items where payment_id='00000000-0000-4000-8000-000000000081')=2,'items linked';
  assert (select (extra_fields#>>'{delivery,cost_usd}')::numeric=2.5 and extra_fields#>>'{delivery,cost_source}'='admin_payment_tariff_confirmation_v1' from public.orders where id=9000000082),'confirmed proposal is saved for legacy readers too';
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000081',inp);
  assert (r->>'replayed')::boolean and (r->>'movementId')::bigint=mid,'same request replays receipt';
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000082',inp);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'different request cannot pay overlapping orders';
  update public.products set internal_rider_pay_usd=9 where id=9000000081;
  r:=public.admin_delivery_services_v1('2026-09-07','2026-09-13');
  assert (select (x#>>'{payment,amountUsd}')::numeric from jsonb_array_elements(r->'rows')x where x->>'id'='9000000082')=2.5,'paid evidence ignores later catalog';
  failed:=false;
  begin update public.orders set status='cancelled' where id=9000000081;
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'paid service cannot be silently cancelled';
  r:=public.void_delivery_service_payment_v1('00000000-0000-4000-8000-000000000081','Synthetic correction');
  assert (r->>'voided')::boolean,'whole payment reversed';
  assert (select status='voided' from public.money_movements where id=mid),'new expense is voided';
  assert not exists(select 1 from public.delivery_service_payment_items where payment_id='00000000-0000-4000-8000-000000000081'),'claims released';
  assert (select jsonb_array_length(evidence)=2 and void_reason='Synthetic correction' from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000000081'),'history retained';
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000081',inp);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'voided request cannot replay as paid';
  update public.products set internal_rider_pay_usd=2.5 where id=9000000081;
  inp:=inp||jsonb_build_object('accountId',9000000082,'rate',500,'amount',1250,'items',jsonb_build_array(
    jsonb_build_object('id',9000000083,'fingerprint',public.delivery_service_cost_v1(9000000083)->>'fingerprint')));
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000083',inp);
  assert (select amount=1250 and currency_code='VES' and exchange_rate_ves_per_usd=500 and amount_usd_equivalent=2.5 from public.money_movements where id=(r->>'movementId')::bigint),'VES payment keeps native amount and actual rate';
  inp:=jsonb_set(inp,'{items}',jsonb_build_array(jsonb_build_object('id',9000000085,'fingerprint',public.delivery_service_cost_v1(9000000085)->>'fingerprint')));
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000085',inp);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'unknown cost cannot be paid as zero';
end $$;
reset role;
-- An existing unrelated expense can be linked without a second cash outflow.
insert into public.money_movements(id,movement_date,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,status,description,created_by_user_id,confirmed_at,confirmed_by_user_id)
values(9000000084,'2026-09-14','outflow','expense_payment',9000000081,'USD',2.5,2.5,'confirmed','Synthetic previous expense',auth.uid(),now(),auth.uid());
set local role authenticated;
do $$ declare inp jsonb; r jsonb; begin
  inp:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','existingMovementId',9000000084,
    'confirmedUnpaid',true,'confirmTariffs',true,'items',jsonb_build_array(jsonb_build_object('id',9000000084,'fingerprint',public.delivery_service_cost_v1(9000000084)->>'fingerprint')));
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000084',inp);
  assert (r->>'movementId')::bigint=9000000084 and (r->>'linkedExisting')::boolean,'existing expense reused';
  r:=public.void_delivery_service_payment_v1('00000000-0000-4000-8000-000000000084','Synthetic unlink only');
  assert (select status='confirmed' from public.money_movements where id=9000000084),'unlink does not void a previous standalone expense';
end $$;
reset role;
-- Force the final link insert to fail: the expense and parent receipt must roll back too.
create function app_private.test_delivery_fail_link() returns trigger language plpgsql as $$
begin raise exception 'Synthetic link failure' using errcode='P0001'; end $$;
create trigger test_delivery_fail_link before insert on public.delivery_service_payment_items
  for each row execute function app_private.test_delivery_fail_link();
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
do $$ declare inp jsonb; failed boolean:=false; before_count bigint; begin
  select count(*) into before_count from public.money_movements where money_account_id=9000000081;
  inp:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000000081,'amount',2.5,
    'confirmedUnpaid',true,'confirmTariffs',true,'items',jsonb_build_array(jsonb_build_object('id',9000000084,'fingerprint',public.delivery_service_cost_v1(9000000084)->>'fingerprint')));
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000086',inp); exception when raise_exception then failed:=true; end;
  assert failed,'injected final write failure reached';
  assert (select count(*) from public.money_movements where money_account_id=9000000081)=before_count,'expense rolled back after final failure';
  assert not exists(select 1 from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000000086'),'parent rolled back after final failure';
end $$;
reset role;
drop trigger test_delivery_fail_link on public.delivery_service_payment_items;
drop function app_private.test_delivery_fail_link();
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='master' and user_id not in(select user_id from public.user_roles where role='admin') limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.pay_delivery_services_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'master cannot authorize service payment';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='advisor' and user_id not in(select user_id from public.user_roles where role='admin') limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.pay_delivery_services_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor cannot pay';
  assert not exists(select 1 from public.delivery_service_payments),'advisor cannot read payments';
  failed:=false;
  begin insert into public.delivery_service_payment_items(order_id,payment_id,cost_usd,evidence) values(1,gen_random_uuid(),1,'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'direct ledger insert denied';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.admin_delivery_services_v1('2026-09-07','2026-09-13'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous report denied';
  failed:=false;
  begin perform public.pay_delivery_services_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous payment denied';
end $$;
reset role;
select 'delivery service payment assertions passed' as result;
