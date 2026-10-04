// Isolated PostgreSQL; no real order or customer is mutated.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const seed = read('tests/master-ops/approved-price-db.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1];
await db.exec(seed);
await db.exec(`create role anon; create role authenticated;
  create function public.is_master() returns boolean language sql as $$select current_setting('test.role',true)='master'$$;
  create function public.has_role(text) returns boolean language sql as $$select current_setting('test.role',true)=$1$$;
  create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
  alter table orders add column order_number text;
  alter table products add column name text, add column sku text, add column base_price_usd numeric,
    add column base_price_bs numeric, add column source_price_currency text, add column source_price_amount numeric,
    add column inventory_group text;
  alter table order_items add column pricing_fx_rate_snapshot numeric, add column override_reason text,
    add column override_approved_by uuid, add column override_approved_at timestamptz;
  alter table client_fund_movements add column id bigint generated always as identity;
  create table exchange_rates(is_active boolean,effective_at timestamptz,rate_bs_per_usd numeric,id bigint generated always as identity);
  create table money_movements(id bigint generated always as identity,order_id bigint,direction text,movement_type text,status text,amount_usd_equivalent numeric,payment_report_id bigint default 11);
  create table order_change_obligations(order_id bigint,status text,amount_usd_equivalent numeric);
  create table order_timeline_events(order_id bigint,order_number text,event_type text,event_group text,title text,message text,actor_user_id uuid,payload jsonb);
  create function public.get_order_financial_state(bigint,date,numeric) returns table(overpaid_usd numeric) language sql as $$
    select greatest(0,coalesce((select sum(amount_usd_equivalent) from public.money_movements where order_id=$1 and status='confirmed'),0)
      -coalesce((select sum(amount_usd) from public.client_fund_movements where order_id=$1 and reason_code='payment_overage_stored'),0)
      -(select total_usd from public.orders where id=$1))$$;
  drop trigger price_guard on order_items;
  update products set is_active=true;
`);
const base = read('supabase/migrations/20260911234222_order_edit_atomic_core_v1.sql');
await db.exec(base.slice(base.indexOf('create or replace function app_private.update_order_core_atomic_v1'),base.indexOf('create or replace function public.update_order_core_atomic_v1')));
await db.exec(read('supabase/migrations/20260914164904_preserve_unchanged_legacy_gifts_on_order_edit.sql'));
await db.exec(read('supabase/migrations/20260930124825_master_preserve_approved_order_prices.sql'));
await db.exec(read('tests/master-ops/fixtures/operational-item-triggers.sql'));
await db.exec(read('tests/master-ops/fixtures/operational-crm-guard.sql'));
const pricingTriggers = read('tests/orders/fixtures/delivered-pricing-triggers.sql');
const pricingStart = pricingTriggers.indexOf('CREATE OR REPLACE FUNCTION public.trg_order_items_set_pricing()');
await db.exec(pricingTriggers.slice(pricingStart, pricingTriggers.indexOf('$function$;', pricingStart) + '$function$;'.length));
await db.exec(`create trigger price_guard before insert or update or delete on order_items for each row execute function public.trg_order_items_guard();
  create trigger pricing_guard before insert or update on order_items for each row execute function public.trg_order_items_pricing_guard();
  create trigger lock_guard before insert or update or delete on order_items for each row execute function public.trg_order_items_lock_guard();
  create trigger set_pricing before insert or update on order_items for each row execute function public.trg_order_items_set_pricing();
  create trigger crm_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1();`);
await db.exec(read('supabase/migrations/20261004190450_prehandoff_operational_item_changes.sql'));
const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
let checks=0;
const check = async (name,fn) => { await db.exec('begin'); try { await fn(); checks++; console.log('PASS '+name); } finally { await db.exec('rollback'); } };
const previous = await rows('select * from order_items order by id');
const items = previous.map(row => ({ ...row,order_item_id:row.id }));
const patch = { client_id:1,attributed_advisor_id:'00000000-0000-0000-0000-000000000002',source:'advisor',status:'ready',fulfillment:'pickup',extra_fields:{pricing:{fx_rate:871.37}} };
const save = async lines => (await rows('select app_private.update_order_core_atomic_v1(1,null,$1::jsonb,$2::jsonb) result',[JSON.stringify(patch),JSON.stringify(lines)]))[0].result;
const rejectSave = async (lines,pattern) => {await db.exec('savepoint rejected');try {await assert.rejects(save(lines),pattern);}finally {await db.exec('rollback to rejected; release savepoint rejected');}};
await check('paid ready Master can remove an approved item without changing any payment',async()=>{
  await db.exec("update orders set status='ready',is_price_locked=true where id=1; insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent) values(1,'inflow','order_payment','confirmed',10)");
  const result=await save([items[0]]); assert.equal(result.item_count,1);
  assert.equal((await rows('select count(*) n from money_movements'))[0].n,1);
  assert.equal((await rows('select status from orders where id=1'))[0].status,'ready');
});
await check('approved quantity reductions retain original identity, unit terms and approver',async()=>{
  const result=await save([items[0],{...items[1],qty:1,line_total_usd:.7,line_total_bs_snapshot:2012.5}]);
  assert.deepEqual(result.item_ids,[1,2]);
  const changed=(await rows('select * from order_items where id=2'))[0];
  assert.equal(Number(changed.qty),1); assert.equal(changed.admin_price_override_by_user_id,previous[1].admin_price_override_by_user_id);
  assert.equal(Number(changed.unit_price_bs_snapshot),2012.5);
  assert.equal((await rows('select count(*) n from test_audit where item_id=2'))[0].n,1);
});
await check('new/copy special prices, transfers and altered unit terms remain forbidden',async()=>{
  await rejectSave([{...items[0],admin_price_override_usd:4},items[1]],/Solo Administración/);
  await rejectSave([...items,{...items[0],order_item_id:null}],/Solo Administración/);
  await rejectSave([{...items[0],product_id:70},items[1]],/Solo Administración/);
});
await check('ordinary quantity edits survive catalog changes without changing native snapshots',async()=>{
  await db.exec("select set_config('test.role','admin',true); update products set base_price_usd=2.64,name='Producto',sku='SKU',source_price_currency='VES',source_price_amount=2300 where id=70; insert into order_items(order_id,product_id,qty,pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,product_name_snapshot) values(1,70,2,'VES',2300,2.64,5.28,2300,4600,'Producto'); update products set base_price_usd=8,source_price_amount=7000 where id=70; select set_config('test.role','master',true)");
  const normal=(await rows('select * from order_items where product_id=70'))[0];
  await save([...items,{...normal,order_item_id:normal.id,qty:1,line_total_usd:Number(normal.unit_price_usd_snapshot),line_total_bs_snapshot:2300}]);
  const retained=(await rows('select * from order_items where id=$1',[normal.id]))[0];
  assert.equal(Number(retained.unit_price_usd_snapshot),Number(normal.unit_price_usd_snapshot));assert.equal(Number(retained.line_total_bs_snapshot),2300);
});
await check('paid ready beverage replacement preserves payment and kitchen state',async()=>{
  await db.exec("select set_config('test.role','admin',true); update orders set status='ready',is_price_locked=true where id=1; update products set name='Pepsi',sku='PEP',base_price_usd=2.64,source_price_currency='VES',source_price_amount=2300,inventory_group='beverages' where id=70; insert into products(id,type,is_active,name,sku,base_price_usd,source_price_currency,source_price_amount,inventory_group) values(71,'product',true,'Coca-Cola','COC',2.64,'VES',2300,'beverages'); insert into order_items(order_id,product_id,qty,pricing_origin_currency,pricing_origin_amount,unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot) values(1,70,1,'VES',2300,2.68,2.68,2300,2300); insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent) values(1,'inflow','order_payment','confirmed',10); select set_config('test.role','master',true)");
  const payment=await rows('select * from money_movements');
  const result=await save([...items,{product_id:71,qty:1,pricing_origin_currency:'VES',pricing_origin_amount:2300,unit_price_usd_snapshot:2.64,line_total_usd:2.64,unit_price_bs_snapshot:2300,line_total_bs_snapshot:2300}]);
  assert.equal(result.item_count,3);
  assert.equal((await rows('select count(*) n from order_items where product_id=70'))[0].n,0);
  assert.equal((await rows('select count(*) n from order_items where product_id=71'))[0].n,1);
  assert.equal((await rows('select status from orders where id=1'))[0].status,'ready');
  assert.deepEqual(await rows('select * from money_movements'),payment);
});
await check('Counter can reduce quantities on locked ready pickup, not change unit prices',async()=>{
  await db.exec("update orders set status='ready',is_price_locked=true where id=1; select set_config('test.role','counter',true)");
  await db.exec('update order_items set qty=1 where id=2');
  assert.equal(Number((await rows('select line_total_bs_snapshot from order_items where id=2'))[0].line_total_bs_snapshot),2012.5);
  await db.exec('savepoint price_tamper');
  await assert.rejects(db.exec('update order_items set unit_price_usd_snapshot=.01 where id=2'),/ADMIN|master\/admin/);
  await db.exec('rollback to price_tamper; release savepoint price_tamper');
});
await check('Master may reduce an inactive historical product, never increase it',async()=>{
  await db.exec('update products set is_active=false where id=200');
  await save([items[0],{...items[1],qty:1,line_total_usd:.7,line_total_bs_snapshot:2012.5}]);
  await db.exec('savepoint inactive_increase');
  await assert.rejects(db.exec('update order_items set qty=2 where id=2'),/disponible/);
  await db.exec('rollback to inactive_increase; release savepoint inactive_increase');
});
await check('surplus decision credits exactly once and leaves payment untouched',async()=>{
  await db.exec("update orders set status='ready',total_usd=8 where id=1; insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent) values(1,'inflow','order_payment','confirmed',10)");
  const first=(await rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida') result"))[0].result;
  const retry=(await rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida') result"))[0].result;
  assert.equal(Number(first.amountUsd),2);assert.equal(Number(retry.amountUsd),0);
  assert.equal(Number((await rows('select fund_balance_usd from clients where id=1'))[0].fund_balance_usd),2);
  assert.equal(Number((await rows('select payment_report_id from client_fund_movements'))[0].payment_report_id),11);
  assert.equal((await rows('select count(*) n from money_movements'))[0].n,1);
});
await check('surplus reservations are not credited a second time',async()=>{
  await db.exec("update orders set status='ready',total_usd=8 where id=1; insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent) values(1,'inflow','order_payment','confirmed',10); insert into order_change_obligations values(1,'pending',1)");
  const result=(await rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida') result"))[0].result;
  assert.equal(Number(result.amountUsd),1);
});
await check('surplus across several payments preserves each report ownership',async()=>{
  await db.exec("update orders set status='ready',total_usd=1 where id=1; insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent,payment_report_id) values(1,'inflow','order_payment','confirmed',4,11),(1,'inflow','order_payment','confirmed',3,12)");
  const result=(await rows("select public.store_operational_order_excess_v1(1,'Retiro de productos') result"))[0].result;
  assert.equal(Number(result.amountUsd),6);
  assert.deepEqual(await rows('select payment_report_id,amount_usd::float as amount from client_fund_movements order by payment_report_id'),[
    {payment_report_id:11,amount:3},{payment_report_id:12,amount:3}]);
});
await check('unlinked legacy surplus refuses credit and leaves all ledgers unchanged',async()=>{
  await db.exec("update orders set status='ready',total_usd=8 where id=1; insert into money_movements(order_id,direction,movement_type,status,amount_usd_equivalent,payment_report_id) values(1,'inflow','order_payment','confirmed',10,null); savepoint no_link");
  await assert.rejects(rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida')"),/reportes de pago suficientes/);
  await db.exec('rollback to no_link; release savepoint no_link');
  assert.equal((await rows('select count(*) n from client_fund_movements'))[0].n,0);
  assert.equal(Number((await rows('select fund_balance_usd from clients where id=1'))[0].fund_balance_usd),0);
});
await check('Counter, Advisor and unauthenticated callers cannot credit order excess',async()=>{
  for(const role of ['counter','advisor']) {
    await db.exec(`select set_config('test.role','${role}',true); savepoint denied_excess`);
    await assert.rejects(rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida')"),/Solo Máster/);
    await db.exec('rollback to denied_excess; release savepoint denied_excess');
  }
  await db.exec("select set_config('test.role','master',true),set_config('test.uid','',true); savepoint anon_excess");
  await assert.rejects(rows("select public.store_operational_order_excess_v1(1,'Retiro de bebida')"),/Solo Máster/);
  await db.exec('rollback to anon_excess; release savepoint anon_excess');
});
await check('advisor and closed-order editing remain forbidden',async()=>{
  await db.exec("select set_config('test.role','advisor',true),set_config('test.uid','00000000-0000-0000-0000-000000000002',true)");
  await rejectSave(items,/cocina/);
  await db.exec("select set_config('test.role','master',true)");
  for(const status of ['delivered','out_for_delivery','cancelled']) {
    await db.exec(`update orders set status='${status}' where id=1`);
    await rejectSave(items,/no admite/);
  }
});
await check('beverage-only additions or swaps do not send a ready pickup back to kitchen',async()=>{
  await db.exec("select set_config('test.role','admin',true); insert into exchange_rates values(true,now(),871.37); update products set name='Bebida',sku='BEB',base_price_usd=2.64,base_price_bs=2300,source_price_currency='VES',source_price_amount=2300,inventory_group='beverages' where id=70; update orders set status='ready' where id=1");
  const plan=(await rows('select public.counter_build_pickup_item_plan(1,$1::jsonb,$2::jsonb) plan',[
    JSON.stringify(items.map(item=>({item_id:item.id,qty:item.qty}))),JSON.stringify([{product_id:70,qty:1}])]))[0].plan;
  assert.equal(plan.needsKitchen,false); assert.equal(Number(plan.addedItems[0].lineBs),2300);
  await db.exec("update products set inventory_group='fried' where id=70");
  const kitchenPlan=(await rows('select public.counter_build_pickup_item_plan(1,$1::jsonb,$2::jsonb) plan',[
    JSON.stringify(items.map(item=>({item_id:item.id,qty:item.qty}))),JSON.stringify([{product_id:70,qty:1}])]))[0].plan;
  assert.equal(kitchenPlan.needsKitchen,true);
});
console.log(`${checks} operational database checks passed`);
await db.close();
