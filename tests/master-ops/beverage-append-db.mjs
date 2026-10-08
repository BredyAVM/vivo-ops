// Isolated PostgreSQL, real pricing guards. Never modifies a production order.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(read('tests/master-ops/gift-append-db.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1]);
await db.exec(`
alter table orders add column fulfillment text default 'delivery';
alter table products add column inventory_group text,add column base_price_bs numeric;
alter table order_items add column pricing_fx_rate_snapshot numeric,add column override_unit_price_usd numeric,
  add column override_reason text,add column override_approved_by uuid,add column override_approved_at timestamptz,
  add column crm_play_member_id bigint,add column admin_price_override_usd numeric,add column admin_price_override_reason text,
  add column admin_price_override_by_user_id uuid,add column admin_price_override_at timestamptz;
create function public.is_master() returns boolean language sql as $$select current_setting('test.role',true)='master'$$;
create function public.is_admin() returns boolean language sql as $$select current_setting('test.role',true)='admin'$$;
create table exchange_rates(is_active boolean,effective_at timestamptz,rate_bs_per_usd numeric);
create table delivery_settlements(id bigint primary key,order_id bigint,responsible_user_id uuid,status text,collection_finalized_at timestamptz);
create table delivery_settlement_entries(settlement_id bigint,entry_type text,amount numeric);
create table money_movements(order_id bigint,amount numeric,status text);
create table payment_reports(order_id bigint,amount numeric,status text);
create table client_fund_movements(order_id bigint,amount numeric);
insert into money_movements values(1,10,'confirmed'); insert into payment_reports values(1,10,'confirmed'),(1,3,'pending');
insert into client_fund_movements values(1,2);
insert into products(id,name,sku,is_active,type,extra_fields,base_price_usd,source_price_amount,source_price_currency,is_detail_editable,inventory_group)
  values(39,'Lipton Limón 1,5 Lts','LIP_LIM_1500',true,'product','{}',5.92,5175,'VES',false,'beverages'),
    (40,'USD beverage','USD_BEV',true,'product','{}',3,3,'USD',false,'beverages');
update order_items set line_total_usd=30.24,line_total_bs_snapshot=26450,unit_price_usd_snapshot=10.08,
  unit_price_bs_snapshot=8816.67,product_name_snapshot='Original',pricing_origin_currency='VES',pricing_origin_amount=8816.67;
update orders set total_usd=30.24,total_bs_snapshot=26450,extra_fields='{"payment":{"method":"pending"},"delivery":{"cost_usd":2.5},"pricing":{"fx_rate":874.73,"subtotal_usd":30.240000000000002,"subtotal_bs":26450,"total_usd":30.24,"total_bs":26450,"discount_enabled":false,"discount_pct":0,"invoice_tax_pct":0}}';
insert into delivery_settlements values(798,1,'00000000-0000-0000-0000-000000000002','not_required',now());
alter function app_private.inventory_resolve_order_sale_routes_base_v1(bigint) set search_path=public;
alter function app_private.inventory_apply_delta_v1(uuid,bigint,text,numeric,text,text,bigint,bigint,uuid,bigint) set search_path=public;
alter function app_private.inventory_record_order_issue_v1(bigint,text,text,text,text,text,uuid,jsonb) set search_path=public;
`);
const pricing = read('tests/orders/fixtures/delivered-pricing-triggers.sql');
for (const name of ['trg_order_items_guard','trg_order_items_pricing_guard','trg_order_items_set_pricing']) {
  const start = pricing.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '()');
  await db.exec(pricing.slice(start,pricing.indexOf('$function$;',start)+'$function$;'.length));
}
await db.exec(`
create trigger order_items_guard before insert or update on order_items for each row execute function public.trg_order_items_guard();
create trigger order_items_pricing_guard before insert or update on order_items for each row execute function public.trg_order_items_pricing_guard();
create trigger order_items_set_pricing before insert or update on order_items for each row execute function public.trg_order_items_set_pricing();
`);
await db.exec(read('supabase/migrations/20261008221501_master_append_paid_beverage.sql'));
const rows = async sql => (await db.query(sql)).rows;
const call = (key='22222222-2222-2222-2222-222222222222',product=39,qty=1,expected='null',reason='Bebida físicamente incluida') =>
  `select public.master_append_dispatched_beverage_v1(1,${product},${qty},${expected},'${key}','${reason}') result`;
const originals = await rows('select * from order_items');
const movements = await rows('select * from money_movements');
const reports = await rows('select * from payment_reports');
const fund = await rows('select * from client_fund_movements');
const settlement = await rows('select * from delivery_settlements');
let checks=0;
async function check(name,fn) { await db.exec('begin'); try { await fn(); console.log('PASS '+name); checks++; } finally { await db.exec('rollback'); } }
const rejects = async (sql,pattern) => { await db.exec('savepoint rejection'); try { await assert.rejects(rows(sql),pattern); } finally { await db.exec('rollback to rejection; release savepoint rejection'); } };
await check('Lipton costs exactly Bs 5175; total Bs 31625 without rewriting original lines',async()=>{
  const result=(await rows(call()))[0].result;
  assert.equal(result.inventory_status,'applied'); assert.equal(result.total_bs,31625); assert.equal(result.total_usd,36.16);
  assert.deepEqual(await rows('select * from order_items where id=1'),originals);
  const order=(await rows('select * from orders'))[0]; assert.equal(order.status,'out_for_delivery');
  assert.equal(order.extra_fields.pricing.fx_rate,874.73); assert.equal(order.extra_fields.delivery.cost_usd,2.5);
  assert.equal(Number(order.total_bs_snapshot),31625); assert.equal(order.extra_fields.pricing.total_bs,31625);
  const item=(await rows('select * from order_items where product_id=39'))[0];
  assert.equal(Number(item.pricing_origin_amount),5175); assert.equal(Number(item.line_total_bs_snapshot),5175);
});
await check('all confirmed payments, reports, fund and settlement remain identical',async()=>{
  await rows(call()); assert.deepEqual(await rows('select * from money_movements'),movements);
  assert.deepEqual(await rows('select * from payment_reports'),reports); assert.deepEqual(await rows('select * from client_fund_movements'),fund);
  assert.deepEqual(await rows('select * from delivery_settlements'),settlement);
  assert.equal((await rows('select count(*) n from delivery_settlement_entries'))[0].n,0);
});
await check('only the added bottle consumes stock, including negative stock',async()=>{
  await rows(call()); assert.deepEqual((await rows('select quantity_units from inventory_movements')).map(r=>Number(r.quantity_units)),[-3,-1]);
  assert.equal(Number((await rows('select stock from test_inventory'))[0].stock),-1);
});
await check('lost-response retry preserves one line, charge and stock exit',async()=>{
  await rows(call()); assert.equal((await rows(call()))[0].result.replayed,true);
  assert.equal((await rows('select count(*) n from order_items'))[0].n,2);
  assert.equal((await rows('select count(*) n from inventory_movements'))[0].n,2);
  await db.exec("update orders set status='delivered'"); assert.equal((await rows(call()))[0].result.replayed,true);
});
await check('reuse for another product, quantity or reason is rejected',async()=>{
  await rows(call()); for(const sql of [call(undefined,40),call(undefined,39,2),call(undefined,39,1,'null','Otro motivo')]) await rejects(sql,/otra incorporación/);
});
await check('separate stale request cannot append',async()=>{
  await rows(call()); await rejects(call('33333333-3333-3333-3333-333333333333'),/orden cambió/);
});
await check('advisor, Counter, unauthenticated and null role cannot append',async()=>{
  for(const role of ['advisor','counter','']) {await db.exec(`select set_config('test.role','${role}',true)`); await rejects(call(),/Solo Máster/);}
  await db.exec("select set_config('test.role','master',true),set_config('test.uid','',true)"); await rejects(call(),/Solo Máster/);
});
await check('Admin can use the same canonical command',async()=>{
  await db.exec("select set_config('test.role','admin',true)"); assert.equal((await rows(call()))[0].result.total_bs,31625);
});
await check('ready, delivered, cancelled and pickup never use this exception',async()=>{
  for(const status of ['ready','delivered','cancelled']) {await db.exec(`update orders set status='${status}'`);await rejects(call(),/solo aplica/);}
  await db.exec("update orders set status='out_for_delivery',fulfillment='pickup'"); await rejects(call(),/solo aplica/);
});
await check('invalid quantities, reason, inactive, food, configurable, CRM and zero-priced products rejected',async()=>{
  for(const qty of [0,-1,.5,1000,"'NaN'::numeric"]) await rejects(call(undefined,39,qty),/entera positiva/);
  await rejects(call(undefined,39,1,'null','a'),/motivo/);
  for(const change of ["is_active=false","inventory_group='food'","type='gambit'","source_price_amount=0","source_price_amount=null","is_detail_editable=true","extra_fields='{\"catalog_access_scope\":\"crm_only\"}'"]) {
    await db.exec('savepoint catalog'); await db.exec('update products set '+change+' where id=39');
    await rejects(call(),/bebida activa/); await db.exec('rollback to catalog; release savepoint catalog');
  }
});
await check('existing cash settlement activity requires explicit reconciliation',async()=>{
  await db.exec("insert into delivery_settlement_entries values(798,'expected_collection',30.24)");
  await rejects(call(),/liquidación/); assert.equal((await rows('select count(*) n from order_items'))[0].n,1);
});
await check('discount and tax percentages preserved and applied in each native currency',async()=>{
  await db.exec(`update orders set total_usd=31.57,total_bs_snapshot=27613.8,extra_fields=jsonb_set(extra_fields,'{pricing}',
    '{"fx_rate":874.73,"subtotal_usd":30.24,"subtotal_bs":26450,"discount_enabled":true,"discount_pct":10,"invoice_tax_pct":16}')`);
  const result=(await rows(call()))[0].result; assert.equal(result.total_bs,33016.5); assert.equal(result.total_usd,37.75);
  assert.equal((await rows('select extra_fields from orders'))[0].extra_fields.pricing.discount_pct,10);
});
await check('whole native line converts before USD rounding for multiple bottles',async()=>{
  const result=(await rows(call(undefined,39,3)))[0].result; assert.equal(result.line_bs,15525);assert.equal(result.line_usd,17.75);
});
await check('USD catalog bottle uses original snapshot FX without revaluing old items',async()=>{
  const result=(await rows(call(undefined,40,2)))[0].result; assert.equal(result.line_usd,6); assert.equal(result.line_bs,5248.38);
  assert.deepEqual(await rows('select * from order_items where id=1'),originals);
});
await check('missing or inconsistent price snapshots do not get silently repaired',async()=>{
  await db.exec('update orders set total_bs_snapshot=1'); await rejects(call(),/conciliación/);
});
await check('inventory failure commits the charge, leaves stock intact and alerts',async()=>{
  await db.exec("select set_config('test.inventory_fail','yes',true)");
  assert.equal((await rows(call()))[0].result.inventory_status,'review_required');
  assert.equal((await rows('select count(*) n from inventory_movements'))[0].n,1);
  assert.equal((await rows("select count(*) n from order_timeline_events where event_type='inventory_sale_sync_failed'"))[0].n,1);
});
await check('unmapped bottle cannot be falsely reported as inventory applied',async()=>{
  await db.exec(`create or replace function app_private.inventory_resolve_order_sale_routes_base_v1(bigint) returns jsonb language sql as $$select '{"lines":[]}'::jsonb$$`);
  assert.equal((await rows(call()))[0].result.inventory_status,'review_required');
});
await check('audit records before/after, reason and actor, notifications reach kitchen, Counter and rider',async()=>{
  await rows(call()); const event=(await rows("select * from order_timeline_events where event_type='order_dispatched_beverage_appended'"))[0];
  assert.equal(event.payload.previous_total_bs,26450); assert.equal(event.payload.total_bs,31625);
  assert.ok(event.actor_user_id); assert.equal(event.payload.reason,'Bebida físicamente incluida');
  assert.equal((await rows('select count(*) n from order_timeline_event_recipients'))[0].n,3);
  assert.equal((await rows("select has_function_privilege('anon','public.master_append_dispatched_beverage_v1(bigint,bigint,numeric,timestamptz,uuid,text)','execute') allowed"))[0].allowed,false);
});
console.log(`${checks} isolated beverage database checks passed`); await db.close();
