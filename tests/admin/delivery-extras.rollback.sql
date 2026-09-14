-- Synthetic data only; run inside BEGIN and always ROLLBACK.
insert into public.money_accounts(id,name,currency_code,account_kind,is_active)
values(9000000091,'TEST EXTRA USD','USD','cash',true);
insert into public.delivery_partners(id,name,partner_type,is_active) values(9000000091,'TEST EXTRA PARTNER','company_dispatch',true),(9000000092,'TEST OTHER PARTNER','company_dispatch',true);
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
do $$ declare r jsonb; inp jsonb; bad jsonb; req jsonb; failed boolean; mid bigint; before_orders bigint; begin
  select count(*) into before_orders from public.orders;
  inp:='{"responsibleKey":"external:9000000091","date":"2026-09-10","concept":"Synthetic errand","amount":10}';
  r:=public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000091',inp);
  assert r->>'id'='00000000-0000-4000-8000-000000000091','extra created';
  assert (select count(*) from public.orders)=before_orders,'extra creates no order';
  r:=public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000091',inp);
  assert (r->>'replayed')::boolean,'creation retries do not duplicate';
  failed:=false;
  begin perform public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000091',inp||'{"amount":11}');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed,'request cannot change amount';
  foreach bad in array array[inp||'{"amount":0}',inp||'{"amount":-1}',inp||'{"amount":0.001}',inp||'{"amount":"NaN"}',inp||'{"date":"2999-01-01"}',inp||'{"responsibleKey":"external:999999999"}'] loop
    failed:=false;
    begin perform public.create_delivery_extra_v1(gen_random_uuid(),bad); exception when invalid_parameter_value then failed:=true; end;
    assert failed,'invalid service rejected';
  end loop;
  r:=public.admin_delivery_extras_v1('2026-09-07','2026-09-13');
  assert exists(select 1 from jsonb_array_elements(r->'payees') x where x->>'key'='external:9000000091'),'payee with no orders available';
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000000091,
    'amount',10,'confirmedUnpaid',true,'items','[]'::jsonb,'extras',jsonb_build_array(jsonb_build_object(
      'id','00000000-0000-4000-8000-000000000091','fingerprint',(select x->>'fingerprint' from jsonb_array_elements(r->'rows')x where x->>'id'='00000000-0000-4000-8000-000000000091'))));
  bad:=jsonb_set(req,'{extras,0,fingerprint}','"00000000000000000000000000000000"'); failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000191',bad); exception when serialization_failure then failed:=true; end;
  assert failed,'stale extra rejected';
  bad:=req||jsonb_build_object('extras',(req->'extras')||(req->'extras')); failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000191',bad); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'duplicate extras rejected';
  bad:=req||'{"from":"2026-09-11"}'; failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000191',bad); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'outside period rejected';
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000191',req); mid:=(r->>'movementId')::bigint;
  assert (r->>'totalUsd')::numeric=10 and (r->>'orderTotalUsd')::numeric=0 and (r->>'extraTotalUsd')::numeric=10,'extra-only total';
  assert (r->>'deliveries')::int=0 and jsonb_array_length(r->'extras')=1,'no fake deliveries';
  assert (select payment_id='00000000-0000-4000-8000-000000000191' from public.delivery_extra_services where id='00000000-0000-4000-8000-000000000091'),'extra linked';
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000191',req);
  assert (r->>'movementId')::bigint=mid and (r->>'replayed')::boolean,'payment retry stable';
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000192',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'cannot double pay extra';
  failed:=false;
  begin perform public.void_delivery_extra_v1('00000000-0000-4000-8000-000000000091','Synthetic correction'); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'paid service cannot be individually voided';
  r:=public.void_delivery_service_payment_v1('00000000-0000-4000-8000-000000000191','Synthetic reversal');
  assert (select payment_id is null from public.delivery_extra_services where id='00000000-0000-4000-8000-000000000091'),'reversal releases service';
  assert (select status='voided' from public.money_movements where id=mid),'reversal voids new cash expense';
  assert (select jsonb_array_length(result->'extras')=1 from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000000191'),'immutable extra receipt';
  r:=public.void_delivery_extra_v1('00000000-0000-4000-8000-000000000091','Synthetic correction');
  assert (r->>'voided')::boolean,'unpaid service voided';
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000193',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'voided extra cannot be paid';
end $$;
reset role;
-- Mixed order + extra; exact existing expense and full reversal.
insert into public.orders(id,order_number,source,fulfillment,status,external_partner_id,delivery_mode,extra_fields)
values(9000000091,'TEST-MIXED-EXTRA','master','delivery','delivered',9000000091,'external','{"delivery":{"cost_usd":2.5,"confirmed_delivery_date":"2026-09-10"}}');
insert into public.money_movements(id,movement_date,direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,status,description,created_by_user_id,confirmed_at,confirmed_by_user_id)
values(9000000091,'2026-09-14','outflow','expense_payment',9000000091,'USD',12.5,12.5,'confirmed','Synthetic mixed expense',auth.uid(),now(),auth.uid());
set local role authenticated;
do $$ declare req jsonb; r jsonb; failed boolean; fp text; foreign_fp text; driver_key text; begin
  perform public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000092','{"responsibleKey":"external:9000000091","date":"2026-09-10","concept":"Synthetic mixed errand","amount":10}');
  perform public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000093','{"responsibleKey":"external:9000000092","date":"2026-09-10","concept":"Synthetic other errand","amount":10}');
  r:=public.admin_delivery_extras_v1('2026-09-07','2026-09-13');
  select x->>'fingerprint' into fp from jsonb_array_elements(r->'rows')x where x->>'id'='00000000-0000-4000-8000-000000000092';
  select x->>'fingerprint' into foreign_fp from jsonb_array_elements(r->'rows')x where x->>'id'='00000000-0000-4000-8000-000000000093';
  select x->>'key' into driver_key from jsonb_array_elements(r->'payees')x where x->>'key' like 'internal:%' limit 1;
  assert driver_key is not null,'active internal driver available';
  perform public.create_delivery_extra_v1('00000000-0000-4000-8000-000000000094',jsonb_build_object('responsibleKey',driver_key,'date','2026-09-10','concept','Synthetic internal errand','amount',1));
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','existingMovementId',9000000091,
    'confirmedUnpaid',true,'items',jsonb_build_array(jsonb_build_object('id',9000000091,'fingerprint',public.delivery_service_cost_v1(9000000091)->>'fingerprint')),
    'extras',jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000000093','fingerprint',foreign_fp)));
  failed:=false;
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000194',req); exception when invalid_parameter_value then failed:=true; end;
  assert failed,'mixed responsible rejected';
  req:=req||jsonb_build_object('extras',jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000000092','fingerprint',fp)));
  r:=public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000194',req);
  assert (r->>'totalUsd')::numeric=12.5 and (r->>'extraTotalUsd')::numeric=10 and (r->>'orderTotalUsd')::numeric=2.5,'combined total';
  assert (r->>'movementId')::bigint=9000000091 and (r->>'linkedExisting')::boolean,'mixed uses existing expense once';
  assert (select count(*) from public.delivery_service_payment_items where payment_id='00000000-0000-4000-8000-000000000194')=1,'only real order linked';
  perform public.void_delivery_service_payment_v1('00000000-0000-4000-8000-000000000194','Synthetic mixed reverse');
  assert (select status='confirmed' from public.money_movements where id=9000000091),'existing cash expense not voided';
  assert (select payment_id is null from public.delivery_extra_services where id='00000000-0000-4000-8000-000000000092'),'mixed extra released';
  assert not exists(select 1 from public.delivery_service_payment_items where order_id=9000000091),'mixed order released';
end $$;
reset role;
-- Last-step failure must roll back the expense, receipt and claims together.
create function app_private.test_extra_fail_link() returns trigger language plpgsql as $$
begin if new.payment_id is not null then raise exception 'Synthetic link failure'; end if; return new; end $$;
create trigger test_extra_fail_link before update on public.delivery_extra_services for each row execute function app_private.test_extra_fail_link();
set local role authenticated;
do $$ declare req jsonb; r jsonb; failed boolean:=false; before_count bigint; begin
  select count(*) into before_count from public.money_movements where money_account_id=9000000091;
  r:=public.admin_delivery_extras_v1('2026-09-07','2026-09-13');
  req:=jsonb_build_object('from','2026-09-07','to','2026-09-13','paymentDate','2026-09-14','accountId',9000000091,'amount',10,'confirmedUnpaid',true,'items','[]'::jsonb,
    'extras',jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000000092','fingerprint',(select x->>'fingerprint' from jsonb_array_elements(r->'rows')x where x->>'id'='00000000-0000-4000-8000-000000000092'))));
  begin perform public.pay_delivery_services_v1('00000000-0000-4000-8000-000000000195',req); exception when raise_exception then failed:=true; end;
  assert failed,'final write failure reached';
  assert (select count(*) from public.money_movements where money_account_id=9000000091)=before_count,'cash insert rolled back';
  assert not exists(select 1 from public.delivery_service_payments where request_id='00000000-0000-4000-8000-000000000195'),'receipt insert rolled back';
end $$;
reset role;
drop trigger test_extra_fail_link on public.delivery_extra_services;
drop function app_private.test_extra_fail_link();
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='advisor' and user_id not in(select user_id from public.user_roles where role='admin') limit 1),true);
set local role authenticated;
do $$ declare failed boolean; begin
  assert not exists(select 1 from public.delivery_extra_services),'advisor cannot read extras';
  failed:=false;
  begin perform public.create_delivery_extra_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor cannot create extras';
  failed:=false;
  begin perform public.admin_delivery_extras_v1('2026-09-07','2026-09-13'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'advisor cannot read report';
  failed:=false;
  begin update public.delivery_extra_services set amount_usd=1; exception when insufficient_privilege then failed:=true; end;
  assert failed,'direct writes denied';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.create_delivery_extra_v1(gen_random_uuid(),'{}'); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous create denied';
end $$;
reset role;
