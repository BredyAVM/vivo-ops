-- Run inside BEGIN after migration, ALWAYS ROLLBACK. All writes use a synthetic order.
insert into public.orders(id,order_number,source,fulfillment,status,delivery_mode,internal_driver_user_id,total_usd,extra_fields)
select 9000000003,'ROLLBACK-DELIVERY-CORRECTION','master','delivery','delivered','internal',user_id,11,
  '{"unrelated":{"keep":true},"delivery":{"cost_usd":2,"cost_source":"legacy","note":"keep"}}'
from public.user_roles where role='driver' limit 1;
select set_config('test.correction.driver',(select user_id::text from public.user_roles where role='driver' limit 1),true);
select set_config('test.correction.partner',(select id::text from public.delivery_partners limit 1),true);
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
create function app_private.test_delivery_correction_failure() returns trigger language plpgsql as $$
begin
  if new.order_id=9000000003 and new.message='TEST FAIL' then raise exception 'late history failure' using errcode='23514'; end if;
  return new;
end $$;
create trigger test_delivery_correction_failure before insert on public.order_timeline_events
for each row execute function app_private.test_delivery_correction_failure();
set local role authenticated;
do $$
declare d uuid:=current_setting('test.correction.driver')::uuid; p bigint:=current_setting('test.correction.partner')::bigint;
  r jsonb; failed boolean; before_row jsonb; n bigint; t bigint;
begin
  assert d is not null and p is not null and auth.uid() is not null, 'fixtures available';
  select to_jsonb(o) into before_row from public.orders o where id=9000000003;
  select count(*) into n from public.order_events where order_id=9000000003;
  select count(*) into t from public.order_timeline_events where order_id=9000000003;
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'external',null,p,'TEST',4,8,'TEST FAIL');
  exception when check_violation then failed:=true; end;
  assert failed and (select to_jsonb(o)=before_row from public.orders o where id=9000000003), 'late failure rolls back entire order';
  assert (select count(*)=n from public.order_events where order_id=9000000003), 'canonical event rollback';
  assert (select count(*)=t from public.order_timeline_events where order_id=9000000003), 'visible history rollback';
  r:=public.correct_delivered_delivery_v1(9000000003,'external',null,p,' TEST ',4,8.25,'Corrección de prueba');
  assert r#>>'{payload,previous,cost_usd}'='2', 'previous cost preserved';
  assert r#>>'{payload,snapshot,recorded_by}'=auth.uid()::text and r#>>'{payload,snapshot,recorded_at}' is not null, 'actor and timestamp';
  assert (select payload=r->'payload' and message='Corrección de prueba' from public.order_timeline_events where id=(r->>'eventId')::bigint), 'visible history matches receipt';
  assert (select total_usd=11 and status='delivered' and extra_fields#>>'{unrelated,keep}'='true' and extra_fields#>>'{delivery,note}'='keep' from public.orders where id=9000000003), 'business amounts/state and other metadata preserved';
  r:=public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,null,'Costo por comprobar');
  assert r#>>'{payload,snapshot,cost_usd}' is null and r#>>'{payload,snapshot,cost_status}'='missing', 'unknown is not zero';
  assert (select external_partner_id is null and external_driver_name is null and external_reference is null and extra_fields#>>'{delivery,distance_km}' is null from public.orders where id=9000000003), 'clear external fields';
  r:=public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,0,'Cero confirmado manual');
  assert r#>>'{payload,snapshot,cost_usd}'='0.00', 'explicit zero preserved';
  assert r#>>'{payload,previous,cost_usd}' is null, 'previous unknown preserved';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,-1,'Motivo válido');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'negative rejected';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,'NaN'::numeric,'Motivo válido');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'NaN rejected';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,1,'');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'reason required';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',d,null,null,null,1,E'\t\n\t\n\t\n');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'whitespace-only reason rejected';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'external',null,p,null,0,1,'Motivo válido');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'invalid distance rejected';
  failed:=false;
  begin perform public.correct_delivered_delivery_v1(9000000003,'invalid',d,null,null,null,1,'Motivo válido');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'invalid mode rejected';
end $$;
reset role;
update public.orders set status='ready' where id=9000000003;
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',current_setting('test.correction.driver')::uuid,null,null,null,1,'Motivo válido');
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'non-delivered order rejected';
end $$;
reset role;
-- Every non-Admin operational role is denied, including Master.
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.correct_delivered_delivery_v1(9000000003,'internal',null,null,null,null,1,'Motivo válido');
    exception when insufficient_privilege then failed:=true; end;
    assert failed, 'non-admin denied';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',null,null,null,null,1,'Motivo válido');
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'no session denied';
end $$;
reset role;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.correct_delivered_delivery_v1(9000000003,'internal',null,null,null,null,1,'Motivo válido');
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous denied';
end $$;
reset role;
select 'delivery correction rollback assertions passed' result;
