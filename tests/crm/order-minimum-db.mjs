// Isolated Postgres. Same pinned PGlite runtime as catalog-gift-db.mjs; no remote credentials.
import { PGlite } from '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const db = new PGlite();
function extract(file, name) {
  const source = read(file);
  const start = source.toLowerCase().indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  const opener = /as\s+(\$[a-z_]*\$)/i.exec(source.slice(start));
  const end = source.indexOf(opener[1], start + opener.index + opener[0].length);
  return source.slice(start, end + opener[1].length) + ';';
}
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create schema app_private;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
create function public.has_role(text) returns boolean language sql as $$ select current_setting('test.role',true)=$1 $$;
create function public.is_admin() returns boolean language sql as $$ select public.has_role('admin') $$;
create function public.is_master_or_admin() returns boolean language sql as $$ select public.has_role('admin') or public.has_role('master') $$;
create table profiles(id uuid primary key, full_name text);
insert into profiles values ('00000000-0000-0000-0000-000000000001','Test advisor'),('00000000-0000-0000-0000-000000000002','Test admin');
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
select set_config('test.role','advisor',false);
create table orders(id bigint primary key,order_number text,client_id bigint,attributed_advisor_id uuid,status text default 'created',extra_fields jsonb default '{}',last_modified_by uuid);
create table crm_plays(id bigint primary key,name text,status text,starts_at timestamptz,ends_at timestamptz,purchase_requirement_mode text,minimum_order_amount_usd numeric);
create table crm_play_members(id bigint primary key,play_id bigint,client_id bigint,advisor_id_snapshot uuid,workflow_status text default 'pending',benefit_status text default 'available',benefit_reserved_at timestamptz,benefit_redeemed_at timestamptz,benefit_expired_at timestamptz);
create table crm_play_benefits(id bigint primary key,play_id bigint,product_id bigint,quantity numeric,unit_benefit_value_usd numeric default 4,unit_advisor_cost_usd numeric default 1.5,unit_company_cost_usd numeric default 2.5);
create table crm_play_benefit_upgrades(id bigint primary key,play_id bigint,play_benefit_id bigint,target_product_id bigint,target_quantity numeric,customer_difference_usd_snapshot numeric);
create table crm_play_member_benefit_selections(play_member_id bigint,play_benefit_id bigint,play_id bigint);
create table order_items(id bigint primary key,order_id bigint,product_id bigint,qty numeric,crm_play_member_id bigint,crm_play_benefit_id bigint,crm_play_benefit_upgrade_id bigint,line_total_usd numeric,notes text);
create table crm_play_redemptions(id bigint generated always as identity primary key,play_member_id bigint,play_benefit_id bigint,play_benefit_upgrade_id bigint,order_id bigint,order_item_id bigint,product_id bigint,quantity numeric,status text,reserved_by_user_id uuid,reserved_at timestamptz,redeemed_by_user_id uuid,redeemed_at timestamptz,voided_at timestamptz,void_reason text,created_at timestamptz default now(),play_name_snapshot text,unit_benefit_value_usd numeric,unit_advisor_cost_usd numeric,unit_company_cost_usd numeric,benefit_value_usd numeric,benefit_credit_usd numeric,customer_paid_difference_usd numeric,advisor_charge_usd numeric,company_cost_usd numeric);
create table crm_play_member_events(play_member_id bigint,event_type text,from_status text,to_status text,note text,actor_user_id uuid,created_at timestamptz);
create table order_timeline_events(order_id bigint,order_number text,event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb);
insert into crm_plays values (1,'Minimum 10','active',null,null,'minimum_order',10),(2,'Unconditional','active',null,null,'none',null);
insert into crm_play_benefits(id,play_id,product_id,quantity) values (1,1,61,1),(2,2,61,1);
`);
const lifecycle = '20260912001929_crm_benefit_reservation_delivery_lifecycle_v1.sql';
for (const name of ['crm_play_redemption_guard_v1','crm_reserve_order_item_benefit_v1','crm_release_order_item_reservation_v1','crm_finalize_order_benefits_on_delivery_v1','crm_void_play_redemptions_on_order_cancel_v1']) {
  await db.exec(extract(lifecycle, `app_private.${name}`));
}
await db.exec(`
create trigger reserve after insert on order_items for each row when(new.crm_play_member_id is not null) execute function app_private.crm_reserve_order_item_benefit_v1();
create trigger release before delete on order_items for each row when(old.crm_play_member_id is not null) execute function app_private.crm_release_order_item_reservation_v1();
create trigger redemption_guard before insert or update or delete on crm_play_redemptions for each row execute function app_private.crm_play_redemption_guard_v1();
create trigger finalize after update of status on orders for each row execute function app_private.crm_finalize_order_benefits_on_delivery_v1();
create trigger cancel after update of status on orders for each row execute function app_private.crm_void_play_redemptions_on_order_cancel_v1();
`);
const seed = (id, amount = 10.74, play = 1) => `
insert into orders(id,order_number,client_id,attributed_advisor_id) values (${id},'test-${id}',${id},'00000000-0000-0000-0000-000000000001');
insert into crm_play_members(id,play_id,client_id,advisor_id_snapshot) values (${id},${play},${id},'00000000-0000-0000-0000-000000000001');
insert into crm_play_member_benefit_selections values(${id},${play},${play});
insert into order_items values(${id * 10},${id},61,1,${id},${play},null,0,'gift');
insert into order_items values(${id * 10 + 1},${id},17,1,null,null,null,${amount},'paid');`;
// Legacy invalid basket deliberately exists before deployment: migration must not repair it.
await db.exec(seed(1, 6.71) + seed(2) + seed(3, 0, 2) + seed(4) + seed(5));
await db.exec(read('20260930125941_crm_order_minimum_lifecycle_guard.sql'));
const rows = async (sql) => (await db.query(sql)).rows;
const rule = async (id) => (await rows(`select public.crm_read_order_minimum_v1(${id}) rules`))[0].rules[0];
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function rejected(sql, pattern = /requiere una compra/) {
  await assert.rejects(db.exec(`begin; ${sql}; commit;`), pattern);
  await db.exec('rollback');
}
async function role(name) {
  await db.query(`select set_config('test.role',$1,false),set_config('test.uid',$2,false)`, [name, name === 'admin' ? '00000000-0000-0000-0000-000000000002' : '00000000-0000-0000-0000-000000000001']);
}
await check('legacy invalid order remains untouched and visible', async () => {
  const state = await rule(1); assert.equal(state.eligible,false); assert.equal(state.commercialUsd,6.71);
  assert.equal((await rows('select status from orders where id=1'))[0].status,'created');
});
await check('new gift-first basket validates at transaction end, exact $10 accepted', async () => {
  await db.exec(`begin; ${seed(6,10)} commit;`); assert.equal((await rule(6)).eligible,true);
});
await check('creation below minimum rolls back header, products and reservation', async () => {
  await rejected(seed(7,6.71)); assert.equal((await rows('select count(*) n from orders where id=7'))[0].n,0);
  assert.equal((await rows('select count(*) n from crm_play_redemptions where order_id=7'))[0].n,0);
});
await check('advisor/master/counter/admin cannot silently reduce 10.74 to 6.71', async () => {
  for (const name of ['advisor','master','counter','admin']) {
    await role(name); await rejected('update order_items set line_total_usd=6.71 where id=21');
    assert.equal(Number((await rows('select line_total_usd from order_items where id=21'))[0].line_total_usd),10.74);
  }
});
await check('deleting paid line and adding discount also fail', async () => {
  await rejected('delete from order_items where id=21');
  await rejected(`update orders set extra_fields='{"pricing":{"discount_pct":50}}' where id=2`);
});
await check('legacy invalid order cannot be approved, sent, made ready or dispatched', async () => {
  for (const status of ['queued','confirmed','in_kitchen','ready','out_for_delivery','delivered']) {
    await rejected(`update orders set status='${status}' where id=1`);
  }
});
await check('notes/payment metadata remain editable on legacy invalid orders', async () => {
  await db.exec(`update orders set extra_fields='{"payment":{"notes":"follow up"}}' where id=1`);
});
await check('gift removal and commercial reduction succeed together; reservation released', async () => {
  await db.exec('begin; update order_items set line_total_usd=6.71 where id=41; delete from order_items where id=40; commit;');
  assert.equal((await rows('select status from crm_play_redemptions where order_id=4'))[0].status,'voided');
});
await check('commercial line rebuild may temporarily dip below minimum', async () => {
  await db.exec('begin; delete from order_items where id=21; insert into order_items values(21,2,17,1,null,null,null,10.74,null); commit;');
});
await check('unconditional benefit still delivers with zero purchase', async () => {
  await db.exec(`update orders set status='delivered' where id=3`);
  assert.equal((await rows('select status from crm_play_redemptions where order_id=3'))[0].status,'redeemed');
});
const request = '00000000-0000-0000-0000-000000000101';
async function authorize(id, floor, reason = 'Test authorized exception', requestId = request, snapshot = null) {
  const r = snapshot ?? await rule(id);
  return db.query('select public.crm_authorize_order_minimum_v1($1,$2,$3,$4,$5,$6,$7)',
    [requestId,id,r.memberId,r.fingerprint,r.commercialUsd,floor,reason]);
}
await check('only admin can authorize; anonymous/master/advisor/counter rejected', async () => {
  const r = await rule(1);
  for (const name of ['master','advisor','counter']) {
    await role(name); await assert.rejects(authorize(1,6.71,undefined,undefined,r),/Solo el administrador/);
  }
  await db.exec(`select set_config('test.uid','',false)`);
  await assert.rejects(authorize(1,6.71,undefined,undefined,r),/Solo el administrador/);
  await role('admin');
});
await check('reason, amount and stale preview are checked', async () => {
  await assert.rejects(authorize(1,6.71,'x'),/motivo/);
  for (const floor of [-1,10,6.711]) await assert.rejects(authorize(1,floor),/mínimo excepcional/);
  const r = await rule(1); await assert.rejects(authorize(1,6.71,undefined,undefined,{...r,commercialUsd:99}),/cambió/);
});
await check('admin exception is bounded, audited, idempotent and changes no order', async () => {
  await authorize(1,6.71); await authorize(1,6.71);
  assert.equal((await rule(1)).eligible,true);
  assert.equal((await rows('select count(*) n from order_timeline_events'))[0].n,1);
  assert.equal((await rows('select status from orders where id=1'))[0].status,'created');
  await assert.rejects(authorize(1,6),/otros datos/);
});
await check('exception permits delivery and correctly redeems benefit', async () => {
  await role('counter'); await db.exec(`update orders set status='delivered' where id=1`);
  assert.equal((await rows('select status from crm_play_redemptions where order_id=1'))[0].status,'redeemed');
});
await check('advance authorization permits proposed edit, not further reductions', async () => {
  await role('admin'); await authorize(5,6.71,undefined,'00000000-0000-0000-0000-000000000102');
  await role('advisor'); await db.exec('update order_items set line_total_usd=6.71 where id=51');
  await rejected('update order_items set line_total_usd=6 where id=51');
});
await check('forged browser metadata cannot create an exception', async () => {
  await rejected(`update orders set extra_fields='{"crm":{"minimum_override":true,"approved_by":"admin"}}' where id=2; update order_items set line_total_usd=1 where id=21`);
});
await check('exception is invalidated by a different gift identity', async () => {
  await rejected('update order_items set qty=2 where id=50');
});
await check('cancellation releases benefit without requiring minimum', async () => {
  await db.exec(`update orders set status='cancelled' where id=5`);
  assert.equal((await rows('select status from crm_play_redemptions where order_id=5'))[0].status,'voided');
});
await check('private ledger and helpers are not callable by clients', async () => {
  const [p] = await rows(`select has_table_privilege('authenticated','app_private.crm_order_minimum_exceptions','INSERT') writable,
    has_function_privilege('authenticated','app_private.crm_assert_order_minimum_v1(bigint)','EXECUTE') helper,
    has_function_privilege('anon','public.crm_authorize_order_minimum_v1(uuid,bigint,bigint,text,numeric,numeric,text)','EXECUTE') anonymous`);
  assert.deepEqual(p,{writable:false,helper:false,anonymous:false});
});
console.log(`${passed} minimum-purchase checks passed`);
await db.close();
