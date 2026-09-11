-- Execute after proposed migration within BEGIN ... ROLLBACK. No real order writes.
insert into public.orders(id,order_number,source,fulfillment,status,extra_fields)
values(9000000002,'ROLLBACK-DELIVERY-COST','master','delivery','confirmed',
  '{"unrelated":{"keep":true},"delivery":{"cost_usd":99,"cost_source":"legacy","distance_km":8,"note":"keep"}}');
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
create function app_private.test_delivery_cost_failure() returns trigger language plpgsql as $$
begin
  if new.order_id=9000000002 and new.event='delivery_cost_recorded' and new.meta#>>'{snapshot,cost_usd}'='13.00' then
    raise exception 'test late failure' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger test_delivery_cost_failure before insert on public.order_events
for each row execute function app_private.test_delivery_cost_failure();
-- Fixture identities are read only; all assignments target the synthetic order.
select set_config('test.delivery.driver',(select user_id::text from public.user_roles where role='driver' limit 1),true);
select set_config('test.delivery.partner',(select id::text from public.delivery_partners where is_active limit 1),true);
set local role authenticated;
do $$
declare d uuid:=current_setting('test.delivery.driver')::uuid; p bigint:=current_setting('test.delivery.partner')::bigint;
  r jsonb; failed boolean; before_row jsonb; before_events bigint;
begin
  assert d is not null and p is not null, 'fixture identities available';
  r:=public.assign_delivery_with_cost_v1(9000000002,'internal',d,null,null,null,2.35);
  assert (r->>'cost_usd')::numeric=2.35 and r->>'recorded_by'=auth.uid()::text and r->>'recorded_at' is not null, 'snapshot actor/time/amount';
  assert (select extra_fields#>>'{unrelated,keep}'='true' and extra_fields#>>'{delivery,note}'='keep' from public.orders where id=9000000002), 'preserve unrelated fields';
  assert (select extra_fields#>>'{delivery,distance_km}' is null from public.orders where id=9000000002), 'internal clears external distance';
  select to_jsonb(o) into before_row from public.orders o where id=9000000002;
  select count(*) into before_events from public.order_events where order_id=9000000002;
  failed:=false;
  begin perform public.assign_delivery_with_cost_v1(9000000002,'external',null,p,'TEST',4,13);
  exception when check_violation then failed:=true; end;
  assert failed, 'late failure injected';
  assert (select to_jsonb(o)=before_row from public.orders o where id=9000000002), 'assignment and cost rolled back together';
  assert (select count(*)=before_events from public.order_events where order_id=9000000002), 'events rolled back';
  r:=public.assign_delivery_with_cost_v1(9000000002,'external',null,p,'TEST',4,null);
  assert r->>'cost_usd' is null and r->>'cost_status'='missing', 'no cost inherited';
  r:=public.assign_delivery_with_cost_v1(9000000002,'external',null,p,'TEST',4,0);
  assert r->>'cost_status'='recorded' and (r->>'cost_usd')::numeric=0, 'explicit zero retained';
  failed:=false;
  begin perform public.assign_delivery_with_cost_v1(9000000002,'external',null,p,null,1,-1);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'negative rejected';
  failed:=false;
  begin perform public.assign_delivery_with_cost_v1(9000000002,'external',null,p,null,1,'NaN'::numeric);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'NaN rejected';
  perform public.assign_internal_driver(9000000002,d);
  assert (select extra_fields#>>'{delivery,cost_usd}' is null and extra_fields#>'{delivery,cost_snapshot}' is null from public.orders where id=9000000002), 'legacy assignment invalidates snapshot';
  perform public.assign_delivery_with_cost_v1(9000000002,'internal',d,null,null,null,3);
  perform public.clear_delivery_assignment(9000000002,'ROLLBACK clear');
  assert (select internal_driver_user_id is null and extra_fields#>>'{delivery,cost_usd}' is null from public.orders where id=9000000002), 'clear invalidates cost';
  assert (select exists(select 1 from public.order_events where order_id=9000000002 and event='delivery_assignment_cleared' and meta#>>'{previous_delivery,cost_usd}'='3.00')), 'previous cost retained in event';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='master' limit 1),true);
set local role authenticated;
do $$ begin
  assert auth.uid() is not null, 'master fixture available';
  perform public.assign_delivery_with_cost_v1(9000000002,'internal',current_setting('test.delivery.driver')::uuid,null,null,null,4);
  assert (select extra_fields#>>'{delivery,cost_usd}'='4.00' from public.orders where id=9000000002), 'master retains assignment permission';
end $$;
reset role;
update public.orders set status='delivered' where id=9000000002;
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.assign_delivery_with_cost_v1(9000000002,'internal',current_setting('test.delivery.driver')::uuid,null,null,null,5);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'delivered order cannot be silently reassigned';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles u where role='advisor' and not exists(select 1 from public.user_roles a where a.user_id=u.user_id and a.role in ('master','admin')) limit 1),true);
set local role authenticated;
do $$ declare failed boolean:=false; begin
  begin perform public.assign_delivery_with_cost_v1(9000000002,'internal',null,null,null,null,1);
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'advisor rejected';
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.assign_delivery_with_cost_v1(9000000002,'internal',null,null,null,null,1);
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous rejected';
end $$;
reset role;
select 'delivery assignment rollback assertions passed' as result;
