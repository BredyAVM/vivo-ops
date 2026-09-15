-- Append to the proposed migration without COMMIT, ALWAYS finish with ROLLBACK.
-- All fixtures are synthetic and carry explicit high IDs.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.money_accounts(id,name,currency_code,account_kind) values
  (9000010001,'ROLLBACK precision USD','USD','cash'),(9000010002,'ROLLBACK precision VES','VES','cash');
update public.money_accounts set name='ROLLBACK DAR precision USD' where id=9000010001;
insert into public.money_account_payment_rules(money_account_id,role,payment_method_code,can_report_payment,
  can_confirm_payment,auto_confirms_report,review_required,is_active)
values(9000010001,'counter','cash_usd',true,true,true,false,true);
insert into public.clients(id,full_name) values(9000010001,'ROLLBACK precision client');
insert into public.products(id,name,base_price_usd,base_price_bs,source_price_currency,source_price_amount,is_inventory_item)
values(9000010001,'ROLLBACK VES source',2.61,2200,'VES',2200,false);
insert into public.orders(id,order_number,source,fulfillment,status,client_id,total_usd,total_bs_snapshot,extra_fields)
select id,'ROLLBACK-PRECISION-'||id,'master','pickup','ready',9000010001,2.61,2200,
  '{"pricing":{"total_usd":2.61,"total_bs":2200,"fx_rate":842.21},"schedule":{"date":"2026-09-01"}}'
from generate_series(9000010001::bigint,9000010015::bigint) id;
-- A payment predating usable item evidence is grandfathered, not revalued.
insert into public.money_movements(id,movement_date,created_by_user_id,confirmed_at,confirmed_by_user_id,
  direction,movement_type,money_account_id,currency_code,amount,amount_usd_equivalent,order_id,status)
values(9000010015,'2026-09-01',auth.uid(),now(),auth.uid(),'inflow','order_payment',9000010001,'USD',2.61,2.61,9000010015,'confirmed');
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
select id,id,9000010001,1,2.61,2.61,'ROLLBACK VES source','VES',2200,2200,2200
from generate_series(9000010001::bigint,9000010015::bigint) id;
update public.orders set total_usd=2.01,total_bs_snapshot=201,
  extra_fields='{"pricing":{"total_usd":2.01,"total_bs":201,"fx_rate":100},"schedule":{"date":"2026-09-01"}}'
where id=9000010003;
update public.order_items set unit_price_usd_snapshot=2.01,line_total_usd=2.01,pricing_origin_currency='USD',
  pricing_origin_amount=2.01,unit_price_bs_snapshot=201,line_total_bs_snapshot=201 where order_id=9000010003;
update public.orders set total_usd=2.01,total_bs_snapshot=200.90,
  extra_fields='{"pricing":{"total_usd":2.01,"total_bs":200.90,"fx_rate":100},"schedule":{"date":"2026-09-01"}}'
where id=9000010004;
update public.order_items set unit_price_usd_snapshot=2.01,line_total_usd=2.01,pricing_origin_currency='VES',
  pricing_origin_amount=200.90,unit_price_bs_snapshot=200.90,line_total_bs_snapshot=200.90 where order_id=9000010004;
insert into public.products(id,name,base_price_usd,base_price_bs,source_price_currency,source_price_amount,is_inventory_item)
values(9000010002,'ROLLBACK USD source',10,8422.10,'USD',10,false),
      (9000010003,'ROLLBACK USD cent',.01,8.42,'USD',.01,false);
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
values(9000010020,9000010007,9000010002,1,10,10,'ROLLBACK USD source','USD',10,8422.10,8422.10);
update public.orders set total_usd=12.61,total_bs_snapshot=10622.10,
  extra_fields=jsonb_set(extra_fields,'{pricing}','{"total_usd":12.61,"total_bs":10622.10,"fx_rate":842.21}')
where id=9000010007;
update public.order_items set product_id=9000010003,unit_price_usd_snapshot=.01,line_total_usd=.01,
  pricing_origin_currency='USD',pricing_origin_amount=.01,unit_price_bs_snapshot=8.42,line_total_bs_snapshot=8.42
where order_id in (9000010008,9000010009);
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,
  product_name_snapshot,pricing_origin_currency,pricing_origin_amount,unit_price_bs_snapshot,line_total_bs_snapshot)
values(9000010021,9000010008,9000010003,1,.01,.01,'ROLLBACK USD cent','USD',.01,8.42,8.42),
      (9000010022,9000010008,9000010003,1,.01,.01,'ROLLBACK USD cent','USD',.01,8.42,8.42);
update public.orders set total_usd=.03,total_bs_snapshot=25.26,
  extra_fields=jsonb_set(extra_fields,'{pricing}','{"total_usd":0.03,"total_bs":25.26,"fx_rate":842.21}') where id=9000010008;
update public.orders set total_usd=.01,total_bs_snapshot=8.42,
  extra_fields=jsonb_set(extra_fields,'{pricing}','{"total_usd":0.01,"total_bs":8.42,"fx_rate":842.21}') where id=9000010009;

-- Pure arithmetic boundaries do not rely on binary floating point.
do $$ declare a record; i int; v_amount numeric; v_rate numeric; begin
  select * into a from app_private.collection_payment_allocation_v1(2.009,200.9,'USD',2,1);
  assert a.applied_usd=2.009 and a.rounding_usd=.009, 'subcent closes';
  select * into a from app_private.collection_payment_allocation_v1(2.01,201,'USD',2,1);
  assert a.applied_usd=2 and a.rounding_usd=0, 'exact cent remains due';
  select * into a from app_private.collection_payment_allocation_v1(2200/842.21,2200,'VES',2199,842.21);
  assert a.applied_usd=2200/842.21 and a.rounding_usd>0 and a.rounding_usd<.01, 'small native residue closes';
  select * into a from app_private.collection_payment_allocation_v1(10,1000,'VES',1120,100,112);
  assert abs(a.applied_usd-(10+120::numeric/112))<.000000000001 and a.rounding_usd=0,
    'snapshot debt coverage does not revalue surplus at the old FX';
  for i in 1..2000 loop
    v_amount:=(10000+i*173)::numeric/100;
    v_rate:=(70000+(i*7919)%80000)::numeric/100;
    select * into a from app_private.collection_payment_allocation_v1(v_amount/v_rate,v_amount,'VES',v_amount,v_rate);
    assert abs(a.applied_usd-v_amount/v_rate)<.000000000001, 'exact native quote closes';
    assert round(a.applied_usd*v_rate,2)=v_amount, 'precise round trip';
  end loop;
end $$;

set local role authenticated;
do $$ declare s record; r jsonb; m bigint; req jsonb; failed boolean:=false; begin
  select * into s from public.get_order_financial_state(9000010001,'2026-09-02',842.21);
  assert s.pending_bs=2200 and round(s.pending_usd,2)=2.61, 'same FX preserves native quote';
  select * into s from public.get_order_financial_state(9000010001,'2026-09-02',850);
  assert s.pending_bs=2220.35, 'higher FX uses precise basis';
  select * into s from public.get_order_financial_state(9000010001,'2026-09-02',800);
  assert s.pending_bs=2089.74, 'lower FX uses precise basis';

  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
  values(9000010001,9000010001,auth.uid(),'VES',1100,1.31,9000010002,'2026-09-02',842.21);
  req:=jsonb_build_object('reportId',9000010001,'accountId',9000010002,'currency','VES',
    'amount',1100,'rate',842.21,'date','2026-09-02','handling','store_fund','changeLines','[]'::jsonb);
  r:=public.confirm_payment_report_atomic_v1(req);
  select * into s from public.get_order_financial_state(9000010001,'2026-09-02',842.21);
  assert s.pending_bs=1100 and round(s.pending_usd,2)=1.31, 'half VES payment preserves remaining native amount';
  assert not exists(select 1 from public.client_fund_movements where order_id=9000010001), 'partial payment creates no fund';
  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
  values(9000010002,9000010001,auth.uid(),'VES',1100,1.31,9000010002,'2026-09-02',842.21);
  r:=public.confirm_payment_report_atomic_v1(req||'{"reportId":9000010002}');
  select * into s from public.get_order_financial_state(9000010001,'2026-09-03',900);
  assert s.pending_usd=0 and s.pending_bs=0 and s.overpaid_usd=0, 'two rounded cash equivalents do not create overpayment';
  assert not exists(select 1 from public.client_fund_movements where order_id=9000010001), 'no fictional cent stored in fund';
  assert (select sum(amount)=2200 and sum(amount_usd_equivalent)=2.62 from public.money_movements
    where order_id=9000010001 and status='confirmed'), 'bank and accounting equivalents unchanged';
  m:=(r->>'movementId')::bigint;
  perform public.void_financial_movement_v1(m,null,'ROLLBACK precision reversal');
  select * into s from public.get_order_financial_state(9000010001,'2026-09-03',842.21);
  assert s.pending_bs=1100, 'void restores original precise credit';

  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date)
  values(9000010003,9000010002,auth.uid(),'USD',2.61,2.61,9000010001,'2026-09-02');
  r:=public.confirm_payment_report_atomic_v1('{"reportId":9000010003,"accountId":9000010001,"currency":"USD","amount":2.61,"date":"2026-09-02","changeLines":[]}');
  select * into s from public.get_order_financial_state(9000010002,'2026-09-03',900);
  assert s.pending_usd=0 and s.pending_bs=0, 'full displayed USD quote closes';
  assert exists(select 1 from public.order_payment_precision_allocations where order_id=9000010002
    and rounding_usd>0 and rounding_usd<.01), 'closure audited separately from cash';
  perform public.void_financial_movement_v1((r->>'movementId')::bigint,null,'ROLLBACK closure reversal');
  select * into s from public.get_order_financial_state(9000010002,'2026-09-03',842.21);
  assert s.pending_bs=2200, 'void also reverses rounding closure';

  begin delete from public.order_payment_precision_allocations where order_id=9000010002;
  exception when insufficient_privilege then failed:=true; end;
  assert failed, 'audit cannot be directly deleted';

  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date)
  values(9000010004,9000010003,auth.uid(),'USD',2,2,9000010001,'2026-09-02'),
        (9000010005,9000010004,auth.uid(),'USD',2,2,9000010001,'2026-09-02');
  r:=public.confirm_payment_report_atomic_v1('{"reportId":9000010004,"accountId":9000010001,"currency":"USD","amount":2,"date":"2026-09-02","changeLines":[]}');
  select * into s from public.get_order_financial_state(9000010003,'2026-09-03',100);
  assert s.pending_usd=.01 and s.pending_bs=1, 'one full cent remains collectible';
  r:=public.confirm_payment_report_atomic_v1('{"reportId":9000010005,"accountId":9000010001,"currency":"USD","amount":2,"date":"2026-09-02","changeLines":[]}');
  select * into s from public.get_order_financial_state(9000010004,'2026-09-03',100);
  assert s.pending_usd=0 and s.pending_bs=0, 'nine tenths of a cent closes automatically';
  assert exists(select 1 from public.order_payment_precision_allocations where order_id=9000010004
    and rounding_usd=.009), 'exact residual retained in audit';

  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date,reported_exchange_rate_ves_per_usd)
  values(9000010006,9000010005,auth.uid(),'VES',1000,1.18,9000010002,'2026-09-02',850);
  r:=public.confirm_payment_report_atomic_v1('{"reportId":9000010006,"accountId":9000010002,"currency":"VES","amount":1000,"rate":850,"date":"2026-09-02","changeLines":[]}');
  select * into s from public.get_order_financial_state(9000010005,'2026-09-03',900);
  assert s.pending_bs=1292.13, 'prior VES payment remains valued at its own payment rate';
  perform public.void_financial_movement_v1((r->>'movementId')::bigint,null,'ROLLBACK rate reversal');
  select * into s from public.get_order_financial_state(9000010005,'2026-09-03',900);
  assert s.pending_bs=2350.96, 'void does not revalue original payment at current rate';

  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date)
  values(9000010007,9000010006,auth.uid(),'USD',2.62,2.62,9000010001,'2026-09-02');
  req:='{"reportId":9000010007,"accountId":9000010001,"currency":"USD","amount":2.62,"date":"2026-09-02","handling":"store_fund","changeLines":[]}';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert (r#>>'{payload,fund_credit_usd}')::numeric=.01, 'real tender above the quoted USD amount is credited';
  select * into s from public.get_order_financial_state(9000010006,'2026-09-03',900);
  assert s.pending_usd=0 and s.overpaid_usd=0, 'fund credit and precise coverage balance';
  r:=public.confirm_payment_report_atomic_v1(req);
  assert r->>'replayed'='true', 'payment retry remains idempotent';
  assert (select count(*)=1 from public.order_payment_precision_allocations where order_id=9000010006), 'one allocation per confirmed movement';

  select * into s from public.get_order_financial_state(9000010015,'2026-09-03',900);
  assert s.pending_usd=0 and s.pending_bs=0, 'historical paid order remains paid';
  assert not exists(select 1 from public.order_collection_precision_enrollments where order_id=9000010015), 'no silent historical enrollment';
  select * into s from public.get_order_financial_state(9000010007,'2026-09-03',850);
  assert s.pending_bs=10720.35, 'mixed currency order retains each source';
  select * into s from public.get_order_financial_state(9000010008,'2026-09-03',842.21);
  assert s.pending_bs=25.26, 'same rate preserves sum of individually rounded USD lines';
  select * into s from public.get_order_financial_state(9000010009,'2026-09-03',10000);
  assert s.pending_bs=100, 'USD origin is never recovered from rounded VES';
  r:=public.counter_apply_order_payments(gen_random_uuid(),9000010010,
    '[{"line_key":"precision_cash","money_account_id":9000010001,"currency_code":"USD","amount":2.61,"payment_method":"cash_usd"}]',null,'[]', 'ROLLBACK precision Counter');
  select * into s from public.get_order_financial_state(9000010010,'2026-09-03',900);
  assert s.pending_usd=0 and s.pending_bs=0 and s.overpaid_usd=0, 'Counter direct insertion uses the same precise closure';
  assert (select count(*)=1 from public.order_payment_precision_allocations where order_id=9000010010), 'Counter records certified allocation';
  insert into public.payment_reports(id,order_id,created_by_user_id,reported_currency_code,reported_amount,
    reported_amount_usd_equivalent,reported_money_account_id,operation_date)
  values(9000010011,9000010011,auth.uid(),'USD',2.61,2.61,9000010001,'2026-09-02');
  begin
    perform public.confirm_payment_report_atomic_v1('{"reportId":9000010011,"accountId":9000010001,"currency":"USD","amount":2.61,"date":"2026-09-02","changeLines":[]}');
    raise exception 'ROLLBACK simulated late failure' using errcode='ZX001';
  exception when sqlstate 'ZX001' then null; end;
  assert not exists(select 1 from public.order_payment_precision_allocations where order_id=9000010011), 'late failure rolls back allocation';
  assert not exists(select 1 from public.order_collection_precision_enrollments where order_id=9000010011), 'late failure rolls back enrollment';
  assert not exists(select 1 from public.money_movements where order_id=9000010011), 'late failure rolls back money';
  assert (select status='pending' from public.payment_reports where id=9000010011), 'late failure preserves pending report';
end $$;
reset role;
do $$ declare u uuid; s record; begin
  select user_id into u from public.user_roles r where role='advisor' and not exists(
    select 1 from public.user_roles p where p.user_id=r.user_id and p.role in ('admin','master','counter')) limit 1;
  if u is not null then
    update public.orders set attributed_advisor_id=u where id=9000010004;
    perform set_config('request.jwt.claim.sub',u::text,true);
    set local role authenticated;
    assert not exists(select 1 from public.order_payment_precision_allocations where order_id=9000010006), 'advisor cannot read foreign allocations';
    assert not exists(select 1 from public.order_collection_precision_basis_v1(9000010006)), 'advisor cannot quote foreign precision';
    select * into s from public.get_order_financial_state(9000010004,'2026-09-03',100);
    assert s.pending_usd=0 and s.pending_bs=0, 'advisor own order uses certified rounding';
    reset role;
  end if;
end $$;
set local role anon;
do $$ declare failed boolean:=false; begin
  begin perform public.order_collection_precision_basis_v1(9000010001); exception when insufficient_privilege then failed:=true; end;
  assert failed, 'anonymous precision access denied';
end $$;
reset role;
set constraints all immediate;
select 'collection precision rollback assertions passed' as result;
