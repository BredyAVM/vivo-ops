-- Run after payment-confirmation.rollback.sql in the SAME rollback-only transaction.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
values(9000000013,'ROLLBACK-VOID-NULL-METADATA','master','pickup','ready',9000000004,10,1000,'{"pricing":null,"payment":null}');
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_money_account_id)
values(9000000013,9000000013,auth.uid(),'USD',10.5,10.5,9000000004);
create function app_private.test_void_late_failure() returns trigger language plpgsql as $$
begin
  if new.order_id between 9000000004 and 9000000012 and new.event_type='financial_movement_voided'
    and current_setting('test.void.fail',true)='on' then raise exception 'synthetic void audit failure' using errcode='23514'; end if;
  return new;
end $$;
create trigger test_void_late_failure before insert on public.order_timeline_events
for each row execute function app_private.test_void_late_failure();
set local role authenticated;
do $$ declare r jsonb; m bigint; b numeric; n bigint; failed boolean; begin
  r:=public.confirm_payment_report_atomic_v1('{"reportId":9000000013,"accountId":9000000004,"amount":10.5,"currency":"USD","handling":"close_difference","changeLines":[]}');
  assert (select jsonb_typeof(extra_fields->'pricing')='object' and jsonb_typeof(extra_fields->'payment')='object' from public.orders where id=9000000013), 'JSON null optional metadata remains compatible';
  r:=public.void_financial_movement_v1((r->>'movementId')::bigint,null,'ROLLBACK null metadata');
  assert (select total_usd=10 from public.orders where id=9000000013), 'rounding with null metadata reversible';
  select movement_id into m from public.payment_confirmation_operations where report_id=9000000004;
  select fund_balance_usd into b from public.clients where id=9000000004;
  select count(*) into n from public.order_events where order_id=9000000004;
  perform set_config('test.void.fail','on',true);
  failed:=false;
  begin perform public.void_financial_movement_v1(m,null,'ROLLBACK atomic void'); exception when check_violation then failed:=true; end;
  assert failed, 'late void audit failure injected';
  assert (select status='confirmed' from public.money_movements where id=m), 'money remains confirmed after failure';
  assert (select status='confirmed' from public.payment_reports where id=9000000004), 'report remains confirmed after failure';
  assert (select fund_balance_usd=b from public.clients where id=9000000004), 'client balance unchanged after failure';
  assert not exists(select 1 from public.client_fund_movements where payment_report_id=9000000004 and reason_code='payment_void_fund_reversal'), 'no orphan fund reversal';
  assert (select count(*)=n from public.order_events where order_id=9000000004), 'canonical audit rolled back';
  perform set_config('test.void.fail','off',true);
  r:=public.void_financial_movement_v1(m,null,'ROLLBACK atomic void');
  assert (select fund_balance_usd=b-2 from public.clients where id=9000000004), 'fund reversed exactly once';
  assert (select pending_usd=10 and confirmed_paid_usd=0 from public.get_order_financial_state(9000000004)), 'order debt restored';
  r:=public.void_financial_movement_v1(m,null,'ROLLBACK atomic void');
  assert r->>'replayed'='true' and (select fund_balance_usd=b-2 from public.clients where id=9000000004), 'retry does not reverse fund twice';
  assert (select count(*)=1 from public.order_timeline_events where order_id=9000000004 and event_type='financial_movement_voided'), 'one visible event';
  select id into m from public.money_movements where order_id=9000000005 and direction='outflow';
  r:=public.void_financial_movement_v1(m,null,'ROLLBACK select change leg');
  assert jsonb_array_length(r->'movementIds')=2 and (select count(*)=2 from public.money_movements where order_id=9000000005 and status='voided'), 'change selection derives principal and entire group';
  assert (select pending_usd=10 from public.get_order_financial_state(9000000005)), 'change and fund reversal remain balanced';
  select movement_id into m from public.payment_confirmation_operations where report_id=9000000007;
  update public.orders set extra_fields=jsonb_set(extra_fields,'{pricing,new_unrelated_note}','"keep"') where id=9000000007;
  r:=public.void_financial_movement_v1(m,null,'ROLLBACK rounding void');
  assert (select total_usd=10 and total_bs_snapshot=1000 and extra_fields#>>'{pricing,total_usd}'='10'
    and extra_fields#>>'{pricing,new_unrelated_note}'='keep' and not(extra_fields->'payment' ? 'rounding_gain_close') from public.orders where id=9000000007), 'rounding restored without deleting unrelated changes';
  assert exists(select 1 from public.order_admin_adjustments where order_id=9000000007 and payload->>'kind'='rounding_gain_close_reversal'), 'rounding reversal evidence';
  select movement_id into m from public.payment_confirmation_operations where report_id=9000000006;
  select fund_balance_usd into b from public.clients where id=9000000004;
  update public.clients set fund_balance_usd=0 where id=9000000004;
  failed:=false;
  begin perform public.void_financial_movement_v1(m,null,'ROLLBACK spent fund'); exception when invalid_parameter_value then failed:=true; end;
  assert failed and (select status='confirmed' from public.payment_reports where id=9000000006), 'spent fund blocks entire void';
  update public.clients set fund_balance_usd=b where id=9000000004;
  failed:=false;
  begin perform public.void_financial_movement_v1(m,'00000000-0000-4000-8000-000000000099','ROLLBACK wrong group'); exception when invalid_parameter_value then failed:=true; end;
  assert failed, 'caller cannot substitute another group';
  failed:=false;
  begin delete from public.financial_void_operations where root_movement_id=m; exception when insufficient_privilege then failed:=true; end;
  assert failed, 'void receipt protected from direct writes';
end $$;
reset role;
do $$ declare u record; failed boolean; begin
  for u in select distinct user_id from public.user_roles r where not exists(select 1 from public.user_roles a where a.user_id=r.user_id and a.role='admin') loop
    perform set_config('request.jwt.claim.sub',u.user_id::text,true);
    set local role authenticated;
    failed:=false;
    begin perform public.void_financial_movement_v1(9000000004,null,'ROLLBACK permission test'); exception when insufficient_privilege then failed:=true; end;
    assert failed, 'non-Admin denied';
    reset role;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.void_financial_movement_v1(9000000004,null,'ROLLBACK permission test'); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous denied';
end $$;
reset role;
select 'financial void rollback assertions passed' result;
