// Isolated Postgres, no credentials. Same pinned PGlite runtime as tests/crm/catalog-gift-db.mjs.
import { PGlite } from '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth; create schema app_private;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
create function is_master_or_admin() returns boolean language sql as $$ select current_setting('test.role',true) in ('master','admin') $$;
create table orders(id bigint primary key,order_number text,status text,last_modified_at timestamptz,last_modified_by uuid,
  total_usd numeric,total_bs_snapshot numeric,extra_fields jsonb,is_price_locked boolean,attributed_advisor_id uuid);
create table products(id bigint primary key,name text,sku text,is_active boolean,type text,extra_fields jsonb,
  base_price_usd numeric,source_price_amount numeric,source_price_currency text,is_detail_editable boolean);
create table order_items(id bigint generated always as identity primary key,order_id bigint,product_id bigint,qty numeric,
  sku_snapshot text,product_name_snapshot text,unit_price_usd_snapshot numeric,line_total_usd numeric,pricing_origin_currency text,
  pricing_origin_amount numeric,unit_price_bs_snapshot numeric,line_total_bs_snapshot numeric);
create table order_timeline_events(id bigint generated always as identity primary key,order_id bigint,order_number text,
  event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb);
create table order_timeline_event_recipients(event_id bigint,target_role text,target_user_id uuid,requires_action boolean);
create table inventory_movements(order_id bigint,movement_type text,operation_id uuid,quantity_units numeric);
create table test_inventory(stock numeric); insert into test_inventory values(0);
create function app_private.inventory_close_order_commitments_v1(bigint,text,uuid) returns integer language sql as $$select 1$$;
create function app_private.inventory_catalog_is_ready_v1() returns boolean language sql as $$select true$$;
create function app_private.inventory_item_is_initialized_v1(bigint) returns boolean language sql as $$select true$$;
create function app_private.inventory_resolve_order_sale_routes_base_v1(bigint) returns jsonb language sql as $$
  select jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('inventory_item_id',47,'sources',
    (select jsonb_agg(jsonb_build_object('order_item_id',id,'quantity_units',qty)) from order_items where order_id=$1)))) $$;
create function app_private.inventory_apply_delta_v1(uuid,bigint,text,numeric,text,text,bigint,bigint,uuid,bigint) returns jsonb language plpgsql as $$
begin
  if current_setting('test.inventory_fail',true)='yes' then raise exception 'Simulated inventory failure'; end if;
  insert into inventory_movements values($7,$3,$1,$4); update test_inventory set stock=stock+$4; return '{}'::jsonb;
end $$;
create function public.inventory_commit_order_sale_v1(uuid,bigint,text) returns jsonb language plpgsql as $$
begin insert into inventory_movements select $2,'sale_out',$1,-sum(qty) from order_items where order_id=$2; return '{}'::jsonb; end $$;
create function app_private.inventory_record_order_issue_v1(bigint,text,text,text,text,text,uuid,jsonb) returns void language sql as $$
insert into order_timeline_events(order_id,event_type,payload) values($1,$2,$8) $$;
create function test_total_trigger() returns trigger language plpgsql set search_path=public as $$begin
update orders set total_usd=(select sum(line_total_usd) from order_items where order_id=new.order_id) where id=new.order_id; return new; end$$;
create trigger legacy_total after insert on order_items for each row execute function test_total_trigger();
insert into products values(89,'Dondy (1 und)','GAMBIT_DONDY_1',true,'gambit','{"catalog_access_scope":"advisor_gift"}',0,0,'USD',false);
insert into orders values(1,'TEST','out_for_delivery',null,null,37.91,32200,'{"pricing":{"fx_rate":849.56}}',true,null);
insert into order_items(order_id,product_id,qty,line_total_usd) values(1,4,3,40);
update orders set total_usd=37.91 where id=1;
insert into inventory_movements values(1,'sale_out','11111111-1111-1111-1111-111111111111',-3);
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false),set_config('test.role','master',false);
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20260920174651_master_append_zero_price_gift.sql',import.meta.url),'utf8'));
// Production helpers qualify their relations; do the same for test-only stubs.
await db.exec(`alter function app_private.inventory_resolve_order_sale_routes_base_v1(bigint) set search_path=public;
alter function app_private.inventory_apply_delta_v1(uuid,bigint,text,numeric,text,text,bigint,bigint,uuid,bigint) set search_path=public;
alter function public.inventory_commit_order_sale_v1(uuid,bigint,text) set search_path=public;
alter function app_private.inventory_record_order_issue_v1(bigint,text,text,text,text,text,uuid,jsonb) set search_path=public;`);
const rows = async (sql) => (await db.query(sql)).rows;
const call = (key='22222222-2222-2222-2222-222222222222', qty=1, expected='null') =>
  `select public.master_append_zero_price_gift_v1(1,89,${qty},${expected},'${key}','Obsequio faltante') result`;
let count=0;
async function check(name, fn) { await fn(); console.log('PASS '+name); count++; }
const original=(await rows('select * from order_items'))[0];
await check('master appends to paid dispatched order without changing paid line, FX, tax-adjusted total or status',async()=>{
  assert.equal((await rows(call()))[0].result.inventory_status,'applied');
  assert.deepEqual((await rows('select * from order_items where id=1'))[0],original);
  const order=(await rows('select * from orders'))[0];
  assert.equal(Number(order.total_usd),37.91); assert.equal(Number(order.total_bs_snapshot),32200);
  assert.equal(order.status,'out_for_delivery'); assert.equal(order.extra_fields.pricing.fx_rate,849.56);
});
await check('only additional Dondy is consumed, allowing negative stock',async()=>{
  assert.equal(Number((await rows('select stock from test_inventory'))[0].stock),-1);
  assert.deepEqual((await rows('select quantity_units from inventory_movements')).map(r=>Number(r.quantity_units)),[-3,-1]);
});
await check('retry is idempotent despite changed last_modified_at',async()=>{
  assert.equal((await rows(call()))[0].result.replayed,true);
  assert.equal((await rows('select count(*) n from order_items'))[0].n,2);
});
await check('reused key with different quantity rejected',()=>assert.rejects(rows(call(undefined,2)),/otro obsequio/));
await check('stale separate request rejected',()=>assert.rejects(rows(call('33333333-3333-3333-3333-333333333333')),/orden cambió/));
await check('advisor and unauthenticated callers rejected',async()=>{
  await db.exec("select set_config('test.role','advisor',false)");
  await assert.rejects(rows(call()),/Solo Máster/);
  await db.exec("select set_config('test.role','master',false),set_config('test.uid','',false)");
  await assert.rejects(rows(call()),/Solo Máster/);
  await db.exec("select set_config('test.uid','00000000-0000-0000-0000-000000000001',false)");
});
await check('zero, fractions and negative quantities rejected',async()=>{
  for(const qty of [0,0.5,-1]) await assert.rejects(rows(call(undefined,qty)),/entera positiva/);
});
const fresh=()=>call('33333333-3333-3333-3333-333333333333',1,'(select last_modified_at from orders where id=1)');
await check('inactive, paid, CRM-only and configurable products rejected',async()=>{
  for(const change of ["is_active=false","source_price_amount=2","base_price_usd=2","extra_fields='{\"catalog_access_scope\":\"crm_only\"}'","is_detail_editable=true"]) {
    await db.exec('begin; update products set '+change);
    await assert.rejects(rows(fresh()),/obsequio activo/); await db.exec('rollback');
  }
});
await check('delivered/cancelled orders remain closed',async()=>{
  for(const status of ['delivered','cancelled']) {
    await db.exec(`begin; update orders set status='${status}'`);
    await assert.rejects(rows(fresh()),/entregada o cancelada/); await db.exec('rollback');
  }
});
await check('inventory failure alerts but does not stop order or add partial stock movement',async()=>{
  await db.exec("begin; select set_config('test.inventory_fail','yes',true)");
  assert.equal((await rows(fresh()))[0].result.inventory_status,'review_required');
  assert.equal((await rows("select count(*) n from order_timeline_events where event_type='inventory_sale_sync_failed'"))[0].n,1);
  assert.equal((await rows('select count(*) n from inventory_movements'))[0].n,2);
  await db.exec('rollback');
});
await check('in_kitchen and ready add gift without physical consumption yet',async()=>{
  for (const status of ['in_kitchen','ready']) {
    await db.exec(`begin; update orders set status='${status}'`);
    assert.equal((await rows(fresh()))[0].result.inventory_status,'pending_dispatch');
    assert.equal((await rows('select count(*) n from inventory_movements'))[0].n,2);
    await db.exec('rollback');
  }
});
await check('kitchen gets action recipient and anonymous execute is denied',async()=>{
  assert.equal((await rows("select count(*) n from order_timeline_event_recipients where target_role='kitchen' and requires_action"))[0].n,1);
  assert.equal((await rows("select has_function_privilege('anon','public.master_append_zero_price_gift_v1(bigint,bigint,numeric,timestamptz,uuid,text)','execute') allowed"))[0].allowed,false);
});
console.log(`${count} isolated database checks passed`); await db.close();
