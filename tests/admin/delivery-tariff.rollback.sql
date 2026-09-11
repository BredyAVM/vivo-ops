-- Run with the migration inside BEGIN ... ROLLBACK. Synthetic rows only.
insert into public.delivery_partners(id,name,partner_type,is_active) values
  (9000000011,'ROLLBACK-TARIFF-A','company_dispatch',true),
  (9000000012,'ROLLBACK-TARIFF-B','company_dispatch',true),
  (9000000013,'ROLLBACK-TARIFF-INACTIVE','company_dispatch',false);
insert into public.delivery_partner_rates(id,partner_id,km_from,km_to,price_usd,is_active) values
  (9000000011,9000000011,0,3,2,true),
  (9000000012,9000000011,3.1,5,3,true),
  (9000000013,9000000011,7,null,5,true),
  (9000000014,9000000011,5.1,6.9,4,false),
  (9000000015,9000000012,0,3,6,true),
  (9000000016,9000000013,0,3,8,true);
insert into public.orders(id,order_number,source,fulfillment,status,extra_fields)
values(9000000011,'ROLLBACK-DELIVERY-TARIFF','master','delivery','confirmed',
  '{"unrelated":{"keep":true},"delivery":{"cost_usd":99}}');
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='master' limit 1),true);
set local role authenticated;
do $$
declare r jsonb; failed boolean;
begin
  assert auth.uid() is not null, 'master fixture exists';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,null,null);
  assert r->>'cost_usd' is null and r->>'cost_status'='missing' and r->>'pending_reason'='missing_distance', 'missing distance is nonblocking and not zero';
  assert (select external_partner_id=9000000011 from public.orders where id=9000000011), 'partner assigned while cost pending';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,3,null);
  assert (r->>'cost_usd')::numeric=2 and r->>'source'='external_partner_tariff_v1', 'inclusive upper boundary';
  assert r#>>'{tariff,rate_id}'='9000000011' and (r#>>'{tariff,price_usd}')::numeric=2 and r->>'recorded_by'=auth.uid()::text and r->>'recorded_at' is not null, 'tariff evidence actor and time';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,3.1,null);
  assert (r->>'cost_usd')::numeric=3, 'inclusive lower boundary';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,3.05,null);
  assert r->>'cost_usd' is null and r->>'pending_reason'='no_matching_tariff', 'gap not guessed and old cost not inherited';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,6,null);
  assert r->>'cost_usd' is null, 'inactive rate ignored';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000013,null,2,null);
  assert r->>'cost_usd' is null, 'inactive partner tariff ignored';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,20,null);
  assert (r->>'cost_usd')::numeric=5, 'open ended range';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,2,0);
  assert (r->>'cost_usd')::numeric=0 and r->>'source'='external_partner_manual_v1' and r->>'tariff' is null, 'explicit zero overrides tariff';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,null,4.75);
  assert (r->>'cost_usd')::numeric=4.75, 'manual cost needs no distance at assignment';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000012,null,2,null);
  assert (r->>'cost_usd')::numeric=6, 'partner specific tariff';
  update public.delivery_partner_rates set price_usd=9 where id=9000000015;
  assert (select (extra_fields#>>'{delivery,cost_usd}')::numeric=6 and (extra_fields#>>'{delivery,cost_snapshot,tariff,price_usd}')::numeric=6 from public.orders where id=9000000011), 'catalog update cannot rewrite assigned cost';
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000012,null,2,null);
  assert (r->>'cost_usd')::numeric=9, 'next assignment uses updated rate';
  insert into public.delivery_partner_rates(id,partner_id,km_from,km_to,price_usd,is_active)
  values(9000000017,9000000011,2,4,7,true);
  r:=public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,3,null);
  assert r->>'cost_usd' is null and r->>'pending_reason'='ambiguous_tariff', 'overlap is pending, not arbitrary price';
  failed:=false;
  begin perform public.assign_delivery_with_cost_v1(9000000011,'external',null,9000000011,null,0,null);
  exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'entered zero distance rejected';
  assert (select extra_fields#>>'{unrelated,keep}'='true' from public.orders where id=9000000011), 'unrelated metadata preserved';
end $$;
reset role;
-- Continue the real operational commands with unknown cost, then complete it as Admin.
update public.orders set status='ready' where id=9000000011;
set local role authenticated;
select public.out_for_delivery(9000000011);
select public.mark_delivered(9000000011);
do $$ begin
  assert (select status='delivered' and extra_fields#>>'{delivery,cost_usd}' is null from public.orders where id=9000000011), 'pending cost does not block dispatch or completion';
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
set local role authenticated;
select public.correct_delivered_delivery_v1(9000000011,'external',null,9000000011,null,3,2.50,'Completar costo pendiente de delivery');
do $$ begin
  assert (select status='delivered' and (extra_fields#>>'{delivery,cost_usd}')::numeric=2.50 from public.orders where id=9000000011), 'Admin completes cost without reopening order';
end $$;
reset role;
select 'external delivery tariff rollback assertions passed' as result;
