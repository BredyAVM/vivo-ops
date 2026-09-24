-- Run in BEGIN + proposed migration body, then ROLLBACK. Synthetic rows only.
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.user_roles where role='admin' limit 1),true);

insert into public.money_accounts(id,name,currency_code,account_kind) values
  (9000024001,'ROLLBACK DAR native VES','VES','cash'),
  (9000024002,'ROLLBACK native USD','USD','cash');
insert into public.money_account_payment_rules(money_account_id,role,payment_method_code,
  can_report_payment,can_confirm_payment,auto_confirms_report,review_required,is_active)
values(9000024001,'counter','cash_ves',true,true,true,false,true);
insert into public.clients(id,full_name) values(9000024001,'ROLLBACK native VES client');
insert into public.products(id,name,base_price_usd,base_price_bs,source_price_currency,source_price_amount,is_inventory_item)
values(9000024001,'ROLLBACK native combo',14.82,12650,'VES',12650,false),
      (9000024002,'ROLLBACK native soda',2.69,2300,'VES',2300,false),
      (9000024003,'ROLLBACK native USD item',10,8544.60,'USD',10,false);
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
select id,'ROLLBACK-NATIVE-'||id,'master','pickup','ready',9000024001,14.82,12650,
  '{"pricing":{"total_usd":14.82,"total_bs":12650,"fx_rate":853.50},"schedule":{"date":"2026-09-24"}}'
from generate_series(9000024001::bigint,9000024003::bigint) id;
-- Creation triggers initialize FX from today's catalog; explicitly establish
-- the historical snapshot before adding lines and confirming the first abono.
update public.orders set extra_fields=jsonb_set(extra_fields,'{pricing}',
  '{"total_usd":14.82,"total_bs":12650,"fx_rate":853.50}')
where id between 9000024001 and 9000024003;
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
select id,id,9000024001,1,14.82,14.82,'ROLLBACK native combo','VES',12650,12650,12650
from generate_series(9000024001::bigint,9000024003::bigint) id;
update public.order_items set unit_price_usd_snapshot=14.82,line_total_usd=14.82
where id between 9000024001 and 9000024003;
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
  reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
select id,id,auth.uid(),'VES',12650,14.82,9000024001,'2026-09-23',853.50
from generate_series(9000024001::bigint,9000024003::bigint) id;
set local role authenticated;
do $$ declare oid bigint; begin
  for oid in select generate_series(9000024001::bigint,9000024003::bigint) loop
    perform public.confirm_payment_report_atomic_v1(jsonb_build_object(
      'reportId',oid,'accountId',9000024001,'currency','VES','amount',12650,
      'rate',853.50,'date','2026-09-23','changeLines','[]'::jsonb));
    assert (select pending_usd=0 and pending_bs=0 from public.get_order_financial_state(oid,'2026-09-23',853.50)),
      'original native payment settles original order';
  end loop;
end $$;
reset role;

-- An authorized edit can add a soda and store a new quote FX while the prior
-- payment/allocation remain immutable. Reproduce the incident, no live IDs.
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
select id+10,id,9000024002,1,2.69,2.69,'ROLLBACK native soda','VES',2300,2300,2300
from generate_series(9000024001::bigint,9000024003::bigint) id;
update public.orders set total_usd=17.51,total_bs_snapshot=14950,
  extra_fields=jsonb_set(extra_fields,'{pricing}','{"total_usd":17.51,"total_bs":14950,"fx_rate":854.46}')
where id between 9000024001 and 9000024003;

set local role authenticated;
do $$ declare s record; fx numeric; d date; r jsonb; m bigint; old_allocation jsonb; begin
  select to_jsonb(a) into old_allocation from public.order_payment_precision_allocations a
  where a.order_id=9000024001;
  foreach fx in array array[854.46,853.50,900,800,null]::numeric[] loop
    foreach d in array array['2026-09-23','2026-09-24']::date[] loop
      select * into s from public.get_order_financial_state(9000024001,d,fx);
      assert s.pending_bs=2300, '14950 minus 12650 is exactly 2300, independent of quote FX';
      assert s.collection_mode='snapshot_quote' and s.confirmed_paid_bs_snapshot=12650,
        'same-day delivery remains native snapshot collection';
      assert abs(s.pending_usd-(14950::numeric/854.46-12650::numeric/853.50))<.000000000001,
        'prior USD allocation remains frozen at its own operation rate';
    end loop;
  end loop;
  r:=public.counter_read_payment_quote(9000024001,'2026-09-24');
  assert (r->>'pendingBs')::numeric=2300, 'Counter receives exact native payment amount';
  select * into s from public.get_order_financial_state(9000024001,'2026-09-25',900);
  assert s.collection_mode='post_delivery_usd' and s.pending_bs=round(s.pending_usd*900,2),
    'next calendar day preserves dollarized collection';

  -- Exact quote through normal Master confirmation closes without false fund.
  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
  values(9000024011,9000024001,auth.uid(),'VES',2300,2.69,9000024001,'2026-09-24',854.46);
  r:=public.confirm_payment_report_atomic_v1(
    '{"reportId":9000024011,"accountId":9000024001,"currency":"VES","amount":2300,"rate":854.46,"date":"2026-09-24","changeLines":[]}');
  m:=(r->>'movementId')::bigint;
  select * into s from public.get_order_financial_state(9000024001,'2026-09-24',854.46);
  assert s.pending_usd=0 and s.pending_bs=0 and s.overpaid_usd=0, 'full native quote settles both balances';
  assert not exists(select 1 from public.client_fund_movements where order_id=9000024001), 'FX gap is not customer fund';
  assert exists(select 1 from public.money_movements where id=m and amount=2300 and amount_usd_equivalent=2.69),
    'real native cash and accounting equivalent retained';
  assert exists(select 1 from public.order_payment_precision_allocations a where a.order_id=9000024001
    and to_jsonb(a)=old_allocation), 'prior allocation untouched';
  select * into s from public.get_order_financial_state(9000024001,'2026-09-25',900);
  assert s.pending_usd=0 and s.pending_bs=0, 'fully paid snapshot stays paid next day';
  perform public.void_financial_movement_v1(m,null,'ROLLBACK native reversal');
  assert (select pending_bs=2300 from public.get_order_financial_state(9000024001,'2026-09-24',854.46)),
    'void reopens exact native soda balance';

  -- Split VES payment: the second half must not be reconstructed from USD.
  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
  values(9000024012,9000024002,auth.uid(),'VES',1150,1.35,9000024001,'2026-09-24',854.46),
        (9000024013,9000024002,auth.uid(),'VES',1150,1.35,9000024001,'2026-09-24',854.46);
  perform public.confirm_payment_report_atomic_v1(
    '{"reportId":9000024012,"accountId":9000024001,"currency":"VES","amount":1150,"rate":854.46,"date":"2026-09-24","changeLines":[]}');
  assert (select pending_bs=1150 from public.get_order_financial_state(9000024002,'2026-09-24',854.46)),
    'partial VES payment leaves exact native remainder';
  perform public.confirm_payment_report_atomic_v1(
    '{"reportId":9000024013,"accountId":9000024001,"currency":"VES","amount":1150,"rate":854.46,"date":"2026-09-24","changeLines":[]}');
  assert (select pending_usd=0 and pending_bs=0 and overpaid_usd=0
    from public.get_order_financial_state(9000024002,'2026-09-24',854.46)), 'two native halves settle without noise';
  assert not exists(select 1 from public.client_fund_movements where order_id=9000024002), 'split payment creates no fund';

  -- Counter uses its existing write path with the same exact VES quote.
  perform public.counter_apply_order_payments(gen_random_uuid(),9000024003,
    '[{"line_key":"native_cash","money_account_id":9000024001,"currency_code":"VES","amount":2300,"exchange_rate_ves_per_usd":854.46,"operation_date":"2026-09-24","payment_method":"cash_ves"}]',
    null,'[]','ROLLBACK native Counter');
  assert (select pending_usd=0 and pending_bs=0 and overpaid_usd=0
    from public.get_order_financial_state(9000024003,'2026-09-24',854.46)), 'Counter native quote settles exactly';
end $$;
reset role;
-- Mixed origins and mixed tender still subtract native VES and snapshot USD.
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
values(9000024004,'ROLLBACK-NATIVE-MIXED','master','pickup','ready',9000024001,12.69,10844.60,
  '{"pricing":{"total_usd":12.69,"total_bs":10844.60,"fx_rate":854.46},"schedule":{"date":"2026-09-24"}}');
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
values(9000024021,9000024004,9000024002,1,2.69,2.69,'ROLLBACK native soda','VES',2300,2300,2300),
      (9000024022,9000024004,9000024003,1,10,10,'ROLLBACK native USD item','USD',10,8544.60,8544.60);
insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
  reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
values(9000024021,9000024004,auth.uid(),'USD',2,2,9000024002,'2026-09-24',null),
      (9000024022,9000024004,auth.uid(),'VES',1000,1.17,9000024001,'2026-09-24',854.46);
set local role authenticated;
do $$ begin
  perform public.confirm_payment_report_atomic_v1(
    '{"reportId":9000024021,"accountId":9000024002,"currency":"USD","amount":2,"date":"2026-09-24","changeLines":[]}');
  assert (select pending_bs=9135.68 from public.get_order_financial_state(9000024004,'2026-09-24',854.46)),
    'mixed order USD abono uses stored snapshot rate';
  perform public.confirm_payment_report_atomic_v1(
    '{"reportId":9000024022,"accountId":9000024001,"currency":"VES","amount":1000,"rate":854.46,"date":"2026-09-24","changeLines":[]}');
  assert (select pending_bs=8135.68 from public.get_order_financial_state(9000024004,'2026-09-24',900)),
    'mixed order VES abono subtracts native amount despite active FX change';
end $$;
reset role;
set constraints all immediate;
select 'native VES quote rollback assertions passed' as result;
