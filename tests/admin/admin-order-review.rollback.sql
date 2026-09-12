-- Synthetic-only fixtures. Caller MUST enclose the entire file in BEGIN / ROLLBACK.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.orders(id,order_number,source,fulfillment,status,extra_fields)
values(9000000230,'ROLLBACK-ADMIN-REVIEW','master','pickup','created','{}'),
      (9000000231,'ROLLBACK-ADMIN-FAILURE','master','pickup','created','{}'),
      (9000000232,'ROLLBACK-ADMIN-PACK','master','pickup','created','{}');
update public.orders set extra_fields='{"schedule":{"date":"2026-09-12","time_24":"15:00"}}'
where id in (9000000230,9000000231,9000000232);
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,product_name_snapshot)
select ids.id,ids.id,p.id,1,3,3,p.name from public.products p
cross join (values(9000000230::bigint),(9000000231::bigint)) ids(id) where p.sku='DEL_Z1';
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,product_name_snapshot,notes)
select 9000000232,9000000232,id,1,base_price_usd,base_price_usd,name,E'6 Mini Tequeños Fritos\n1 Salsa Tártara 1oz'
from public.products where sku='SINGLE_6';
create function app_private.test_admin_order_review_failure() returns trigger language plpgsql as $$
begin
  if new.order_id=9000000231 then raise exception 'synthetic late failure' using errcode='23514'; end if;
  return new;
end $$;
create trigger test_admin_order_review_failure before insert on public.order_timeline_events
for each row execute function app_private.test_admin_order_review_failure();
set local role authenticated;
do $$ declare review jsonb; receipt jsonb; failed boolean; v_event_id bigint; begin
  review:=public.admin_order_review_v1(9000000230);
  assert review->>'action'='approve' and jsonb_array_length(review->'items')=1,'complete preview';
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','approve','Verificado');
  assert receipt->>'status'='approved','approval receipt';
  v_event_id:=(receipt->>'eventId')::bigint;
  assert (select status='queued' from public.orders where id=9000000230),'canonical queued state';
  assert exists(select 1 from public.order_events where order_id=9000000230 and event='approved' and performed_by=auth.uid()),'canonical audit';
  assert exists(select 1 from public.order_timeline_events where id=v_event_id and actor_user_id=auth.uid() and message='Verificado'),'visible audit';
  assert exists(select 1 from public.order_timeline_event_recipients where event_id=(receipt->>'eventId')::bigint and target_role='master'),'in-app recipient';
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','approve',null);
  assert receipt->>'status'='stale','retry does not repeat approval';
  assert (select count(*)=1 from public.order_events where order_id=9000000230 and event='approved'),'single audit';
  review:=public.admin_order_review_v1(9000000231);
  failed:=false;
  begin perform public.approve_admin_order_review_v1(9000000231,review->>'snapshot','approve',null); exception when check_violation then failed:=true; end;
  assert failed and (select status='created' from public.orders where id=9000000231),'late timeline failure rolls back state';
  assert not exists(select 1 from public.order_events where order_id=9000000231),'late failure rolls back canonical audit';
  assert (select not (extra_fields ? 'inventory_protected_allocations_v1') from public.orders where id=9000000231),'late failure rolls back inventory preparation';
  review:=public.admin_order_review_v1(9000000232);
  failed:=false;
  begin perform public.approve_admin_order_review_v1(9000000232,review->>'snapshot','approve',null); exception when raise_exception or invalid_parameter_value then failed:=true; end;
  assert failed and (select status='created' from public.orders where id=9000000232),'invalid pack keeps canonical inventory rejection';
end $$;
reset role;
do $$ declare review jsonb; receipt jsonb; begin
  update public.orders set queued_needs_reapproval=true where id=9000000230;
  review:=public.admin_order_review_v1(9000000230);
  update public.order_items set qty=2,line_total_usd=6 where id=9000000230;
  set local role authenticated;
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','reapprove',null);
  assert receipt->>'status'='stale','actual item edit invalidates review';
  reset role;
  review:=public.admin_order_review_v1(9000000230);
  update public.orders set notes='Changed after review' where id=9000000230;
  set local role authenticated;
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','reapprove',null);
  assert receipt->>'status'='stale','header edit invalidates review';
  review:=public.admin_order_review_v1(9000000230);
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','reapprove','Ratificado');
  assert receipt->>'status'='approved' and (select not queued_needs_reapproval from public.orders where id=9000000230),'canonical reapproval clears flag';
  assert exists(select 1 from public.order_events where order_id=9000000230 and event='queued_reapproved'),'canonical reapproval audit';
  receipt:=public.approve_admin_order_review_v1(9000000230,review->>'snapshot','reapprove',null);
  assert receipt->>'status'='stale','reapproval repeat rejected';
  reset role;
  update public.orders set extra_fields='{"review":{"returned_to_advisor":true}}' where id=9000000231;
  review:=public.admin_order_review_v1(9000000231);
  assert review->>'action' is null,'returned orders not offered for approval';
end $$;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.admin_order_review_v1(9000000230); exception when insufficient_privilege then failed:=true; end;
    assert failed,'non-admin read denied';
    failed:=false;
    begin perform public.approve_admin_order_review_v1(9000000230,repeat('0',32),'approve',null); exception when insufficient_privilege then failed:=true; end;
    assert failed,'non-admin approval denied';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean; begin
  failed:=false;
  begin perform public.admin_order_review_v1(9000000230); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous read denied';
  failed:=false;
  begin perform public.approve_admin_order_review_v1(9000000230,repeat('0',32),'approve',null); exception when insufficient_privilege then failed:=true; end;
  assert failed,'anonymous approval denied';
end $$;
reset role;
set constraints all immediate;
select 'admin order review rollback assertions passed' as result;
