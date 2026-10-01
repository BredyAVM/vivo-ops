// Isolated Postgres. Same pinned PGlite runtime as catalog-gift-db.mjs; no remote credentials.
const { PGlite } = await import(process.env.PGLITE_RUNTIME || '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js');
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

await db.exec(seed(101) + seed(102) + seed(103) + seed(104) + seed(105) + seed(106) + seed(107));
await db.exec(read('20260930125941_crm_order_minimum_lifecycle_guard.sql'));
await db.exec(readFileSync(new URL('./fixtures/order-item-guard-before-validity.sql',import.meta.url),'utf8'));
await db.exec(`
create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
alter table orders add column source text default 'advisor';
create table products(id bigint primary key,type text,is_active boolean default true,extra_fields jsonb default '{}',base_price_usd numeric default 0,source_price_amount numeric default 0);
insert into products(id,type,extra_fields) values(61,'gambit','{"catalog_access_scope":"crm_only"}'),(17,'product','{}');
alter table order_items add column admin_price_override_usd numeric, add column override_unit_price_usd numeric,
 add column pricing_origin_currency text, add column pricing_origin_amount numeric, add column unit_price_usd_snapshot numeric,
 add column unit_price_bs_snapshot numeric, add column line_total_bs_snapshot numeric;
update crm_plays set starts_at=now()-interval '1 year', ends_at=((now() at time zone 'America/Caracas')::date+time '23:59:59.999') at time zone 'America/Caracas';
update orders set extra_fields=jsonb_build_object('schedule',jsonb_build_object('date',((now() at time zone 'America/Caracas')::date+1)::text)) where id=101;
update crm_plays set status='closed',ends_at=now()-interval '1 day' where id=1;
update crm_play_members set benefit_status='expired' where play_id=1;
`);
await db.exec(read('20261001143104_crm_order_validity_exceptions.sql'));
await db.exec('create trigger item_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1()');
const rows=async(sql)=>(await db.query(sql)).rows;
const state=async(id)=>(await rows(`select public.crm_read_order_validity_v1(${id}) rules`))[0].rules[0];
const today=(await rows("select (now() at time zone 'America/Caracas')::date::text as value"))[0].value;
const tomorrow=(await rows("select ((now() at time zone 'America/Caracas')::date+1)::text as value"))[0].value;
let passed=0, request=200;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function role(name){
 await db.query("select set_config('test.role',$1,false),set_config('test.uid',$2,false)",[name,name==='admin'?'00000000-0000-0000-0000-000000000002':'00000000-0000-0000-0000-000000000001']);
}
async function rejected(sql,pattern=/no está habilitado/){
 await assert.rejects(db.exec(`begin; ${sql}; commit;`),pattern);await db.exec('rollback');
}
async function authorize(id,through=tomorrow,reason='Entrega posterior acordada con cliente',snapshot=null,uuid=null){
 const r=snapshot??await state(id);
 return db.query('select public.crm_authorize_order_validity_v1($1,$2,$3,$4,$5,$6)',[
 uuid??`00000000-0000-0000-0000-${String(request++).padStart(12,'0')}`,id,r.memberId,r.fingerprint,through,reason]);
}
await check('migration does not touch expired orders or grant exceptions',async()=>{
 assert.equal((await state(101)).eligible,false);
 assert.equal((await rows('select count(*) n from app_private.crm_order_validity_exceptions'))[0].n,0);
});
await check('blocks legacy kitchen/dispatch/delivery before approval',async()=>{
 for(const status of ['queued','in_kitchen','ready','out_for_delivery','delivered'])
  await rejected(`update orders set status='${status}' where id=101`);
});
await check('allows unrelated notes without unblocking benefit',async()=>{
 await db.exec(`update orders set extra_fields=extra_fields||'{"notes":"test"}'::jsonb where id=101`);
 assert.equal((await state(101)).eligible,false);
});
await check('advisor/counter/anonymous cannot authorize',async()=>{
 const snapshot=await state(101);
 for(const name of ['advisor','counter']){await role(name);await assert.rejects(authorize(101,tomorrow,undefined,snapshot),/Solo master/);}
 await db.exec("select set_config('test.uid','',false)");
 await assert.rejects(authorize(101,tomorrow,undefined,snapshot),/Solo master/);
 await role('master');
});
await check('validates reason, date and stale fingerprint',async()=>{
 await assert.rejects(authorize(101,tomorrow,'short'),/motivo/);
 await assert.rejects(authorize(101,today),/fecha posterior/);
 const r=await state(101);await assert.rejects(authorize(101,tomorrow,undefined,{...r,fingerprint:'stale'}),/cambió/);
});
const requestId='00000000-0000-0000-0000-000000000999';
await check('master grants bounded/idempotent audited exception without modifying order',async()=>{
 const before=(await rows('select * from orders where id=101'))[0];
 await authorize(101,tomorrow,undefined,null,requestId);await authorize(101,tomorrow,undefined,null,requestId);
 assert.equal((await state(101)).eligible,true);
 assert.equal((await rows("select count(*) n from order_timeline_events where event_type='crm_validity_exception_approved'"))[0].n,1);
 assert.deepEqual((await rows('select * from orders where id=101'))[0],before);
 await assert.rejects(authorize(101,tomorrow,'A different approval reason',null,requestId),/otros datos/);
});
await check('forged metadata cannot grant an exception',async()=>{
 await rejected(`update orders set extra_fields='{"crm":{"authorized":true}}',status='queued' where id=102`);
});
await check('cannot schedule beyond authorization; approved date works',async()=>{
 await rejected(`update orders set extra_fields=jsonb_build_object('schedule',jsonb_build_object('date',((now() at time zone 'America/Caracas')::date+2)::text)) where id=101`);
 await db.exec(`update orders set status='ready' where id=101`);
});
await check('existing gift composition stays editable after expiry with authorization',async()=>{
 await db.exec("update order_items set notes='2 Minis + 2 Cachitas + 2 Empanadas' where id=1010");
 assert.equal((await state(101)).eligible,true);
});
await check('minimum still enforced independently from validity',async()=>{
 await rejected('update order_items set line_total_usd=1 where id=1011',/requiere una compra/);
});
await check('authorized expired reservation delivers once; economics preserved',async()=>{
 const money=(await rows('select advisor_charge_usd,company_cost_usd from crm_play_redemptions where order_id=101'))[0];
 await role('counter');await db.exec("update orders set status='delivered' where id=101");
 assert.equal((await rows('select benefit_status from crm_play_members where id=101'))[0].benefit_status,'redeemed');
 assert.equal((await rows("select count(*) n from crm_play_redemptions where order_id=101 and status='redeemed'"))[0].n,1);
 assert.deepEqual((await rows('select advisor_charge_usd,company_cost_usd from crm_play_redemptions where order_id=101'))[0],money);
});
await check('admin can authorize; changing client or advisor invalidates',async()=>{
 await role('admin');await authorize(102);
 await rejected('update orders set client_id=999 where id=102');
 await rejected("update orders set attributed_advisor_id='00000000-0000-0000-0000-000000000002' where id=102");
});
await check('removing gift releases reservation and does not require extension',async()=>{
 await db.exec('delete from order_items where id=1030');
 assert.equal((await rows('select status from crm_play_redemptions where order_id=103'))[0].status,'voided');
 await db.exec("update orders set status='ready' where id=103");
});
await check('different gift identity invalidates fingerprint',async()=>{
 await authorize(104);
 await rejected('update order_items set id=99999 where id=1040');
});
await check('cancelled/removed/paused memberships cannot use date authorization',async()=>{
 await authorize(105);
 await db.exec("update crm_play_members set workflow_status='removed' where id=105");
 assert.equal((await state(105)).eligible,false);
 await rejected("update orders set status='ready' where id=105");
 await db.exec("update orders set status='cancelled' where id=105");
 await assert.rejects(authorize(105),/cancelación/);
 await db.exec("update crm_plays set status='paused' where id=1");
 await assert.rejects(authorize(106),/no admiten/);
 await db.exec("update crm_plays set status='closed' where id=1");
});
await check('another order cannot reuse authorized benefit',async()=>{
 await authorize(106);
 await db.exec("insert into orders(id,client_id,attributed_advisor_id) select 108,client_id,attributed_advisor_id from orders where id=106");
 await rejected('insert into order_items(id,order_id,product_id,qty,crm_play_member_id,crm_play_benefit_id,line_total_usd) values(1080,108,61,1,106,1,0)',/ya no está disponible|otra orden/);
});
await check('active campaign scheduled beyond end is rejected on create, not delivery',async()=>{
 await rejected(` ${seed(109,0,2)} update orders set extra_fields=jsonb_build_object('schedule',jsonb_build_object('date',((now() at time zone 'America/Caracas')::date+2)::text)) where id=109;`);
 assert.equal((await rows('select count(*) n from orders where id=109'))[0].n,0);
});
await check('ledger and helpers cannot be invoked or written by clients',async()=>{
 const [p]=await rows(`select has_table_privilege('authenticated','app_private.crm_order_validity_exceptions','INSERT') writable,
 has_function_privilege('authenticated','app_private.crm_order_has_validity_exception_v1(bigint,bigint)','EXECUTE') helper,
 has_function_privilege('anon','public.crm_authorize_order_validity_v1(uuid,bigint,bigint,text,date,text)','EXECUTE') anonymous`);
 assert.deepEqual(p,{writable:false,helper:false,anonymous:false});
});
console.log(`${passed} validity exception checks passed`);
await db.close();
