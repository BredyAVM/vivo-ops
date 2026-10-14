import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const admin='00000000-0000-0000-0000-000000000001', advisor='00000000-0000-0000-0000-000000000002', other='00000000-0000-0000-0000-000000000003';
async function user(db,id){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema app_private;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table profiles(id uuid primary key,full_name text,is_active boolean default true);
 create table user_roles(user_id uuid,role text);
 create table advisor_commission_closures(id bigint primary key,period_id bigint,advisor_user_id uuid,status text,snapshot jsonb default '{}',gross_commission_usd numeric default 0,gift_deductions_usd numeric default 0,manual_deductions_usd numeric default 0,payable_usd numeric default 0,updated_at timestamptz);
 create function public.has_role(text) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role=$1)$$;
 create function public.is_admin() returns boolean language sql stable as $$select public.has_role('admin')$$;
 create function public.is_master_or_admin() returns boolean language sql stable as $$select public.has_role('admin') or public.has_role('master')$$;
 grant usage on schema public,auth to anon,authenticated;
 insert into profiles(id,full_name) values('${admin}','Admin'),('${advisor}','Advisor'),('${other}','Other');
 insert into user_roles values('${admin}','admin'),('${advisor}','advisor'),('${other}','advisor');`);
 await db.exec(read('./fixtures/redemption-installed-routines.sql'));
 await db.exec(`create type public.order_status as enum('created','queued','confirmed','in_kitchen','ready','out_for_delivery','delivered','cancelled');create type public.order_source as enum('advisor','master','walk_in');`);
 await db.exec(read('./fixtures/redemption-retention-helpers.sql'));
 await db.exec(`create type public.product_type as enum('service','delivery','gambit');alter table products alter column type type public.product_type using type::public.product_type;`);
 await db.exec(`create table advisor_commission_periods(id bigint primary key,date_from date,date_to date,status text);
 create table advisor_commission_carry_transfers(source_closure_id bigint,destination_closure_id bigint,credit_usd numeric,advisor_debt_usd numeric,order_ids bigint[],created_at timestamptz);
 create table money_movements(status text,direction text,movement_type text,description text,amount_usd_equivalent numeric);
 create function public.get_orders_financial_state(bigint[]) returns table(order_id bigint,delivery_reference_date date,total_usd numeric,confirmed_paid_usd numeric,pending_usd numeric,payment_status text) language sql as $$select null::bigint,null::date,0::numeric,0::numeric,0::numeric,''::text where false$$;
 create view public.commercial_order_facts as select order_row.id,case when exists(select 1 from order_items gift_item left join products gift_product on gift_product.id=gift_item.product_id where gift_item.order_id=order_row.id and gift_product.type::text = 'gambit'::text) then array['obsequio'] else '{}'::text[] end gift_tags from orders order_row where order_row.status='delivered';`);
 await db.exec(read('./fixtures/redemption-commission-state.sql'));
 await db.exec(`insert into clients(id,full_name,phone) values(1,'Client','584120000001'),(2,'Advisor personal','584120000002');
 create table public.order_timeline_events(order_id bigint,order_number text,event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb,created_at timestamptz);
 insert into products(id,name,sku,type,is_active,source_price_currency,source_price_amount) values
 (1,'Single Pack','PACK','service',true,'USD',4),(2,'Delivery Zona 1','DEL','delivery',true,'VES',850),(3,'CRM Gift','GIFT','gambit',true,'USD',4);
 insert into exchange_rates(rate_bs_per_usd,is_active,effective_at) values(850,true,now());
 create trigger order_items_pricing_guard before insert or update on order_items for each row execute function trg_order_items_pricing_guard();
 create trigger order_items_set_pricing before insert or update on order_items for each row execute function trg_order_items_set_pricing();`);
 for(const file of ['20261013141407_advisor_reward_wallet_foundation.sql','20261013143845_reward_wallet_lock_order.sql','20261013151045_advisor_reward_issuance.sql','20261014182352_advisor_reward_redemption_lifecycle.sql','20261014182408_advisor_reward_debt_and_read_models.sql']) await db.exec(read('../../supabase/migrations/'+file));
 await db.exec(`grant select,insert,update,delete on public.orders,public.order_items,public.order_timeline_events,public.advisor_order_drafts to authenticated;
 grant select on public.clients,public.products,public.exchange_rates to authenticated;
 grant usage,select on sequence public.orders_id_seq,public.order_items_id_seq,public.advisor_order_drafts_id_seq to authenticated;`);
 await user(db,admin);return db;
}
async function grant(db,overrides={}){
 await user(db,admin);
 const payload={advisorId:advisor,title:'September prize',category:'strategic',period:'2026-09',kind:'credit',mode:'flexible',purposes:['customer_gift','personal_purchase','advisor_debt'],amount:20,productId:null,productScope:'all_products',allowedProductIds:[],expiresOn:'2099-10-31',note:'',...overrides};
 const d=(await db.query('select reward_save_draft_v1($1::jsonb,$2::uuid) result',[JSON.stringify(payload),crypto.randomUUID()])).rows[0].result;
 return (await db.query("select reward_issue_draft_v1($1,1,'Premio revisado por administración.') result",[d.id])).rows[0].result.grant_id;
}
async function order(db,who=advisor,client=1,date='2099-10-30'){
 return (await db.query("insert into orders(client_id,attributed_advisor_id,status,fulfillment,total_usd,extra_fields) values($1,$2,'created','pickup',0,jsonb_build_object('schedule',jsonb_build_object('date',$3::text),'pricing',jsonb_build_object('fx_rate',850))) returning id",[client,who,date])).rows[0].id;
}
async function item(db,o,g,amount=4,product=1,qty=1,purpose='customer_gift'){
 return (await db.query("insert into order_items(order_id,product_id,qty,reward_grant_id,reward_purpose,reward_amount_usd,pricing_fx_rate_snapshot,notes) values($1,$2,$3,$4,$5,$6,850,'2 Tequeños\n4 Empanadas') returning *",[o,product,qty,g,purpose,amount])).rows[0];
}
const balances=async(db,g)=>(await db.query('select reserved_amount,used_amount from advisor_reward_grants where id=$1',[g])).rows[0];

test('migration patches canonical creation/edit; funding is atomic, reserved, delivered once, and cancellable',async()=>{
 const db=await setup();try{
 const g=await grant(db);await user(db,advisor);const o=await order(db);const i=await item(db,o,g,2);
 assert.equal(i.line_total_usd,'2.00');assert.equal(i.line_total_bs_snapshot,'1700.00');assert.equal(i.reward_base_line_usd,'4.00');
 assert.match(i.notes,/Tequeños/);assert.equal(i.crm_play_member_id,null);
 assert.deepEqual(await balances(db,g),{reserved_amount:'2.00',used_amount:'0.00'});
 await db.query("update orders set status='delivered' where id=$1",[o]);await db.query("update orders set status='delivered' where id=$1",[o]);
 assert.deepEqual(await balances(db,g),{reserved_amount:'0.00',used_amount:'2.00'});
 assert.equal((await db.query("select count(*)::int n from advisor_reward_use_events where event_type='used'")).rows[0].n,1);
 assert.deepEqual((await db.query('select gift_tags from commercial_order_facts')).rows[0].gift_tags,['obsequio']);
 await assert.rejects(()=>db.query('delete from order_items where id=$1',[i.id]),/entregado|retirar/);
 await assert.rejects(()=>db.query("update orders set status='ready' where id=$1",[o]),/entregado/);
 await db.query("update orders set status='cancelled' where id=$1",[o]);
 assert.deepEqual(await balances(db,g),{reserved_amount:'0.00',used_amount:'0.00'});
 assert.equal((await db.query("select event_type from advisor_reward_use_events order by id desc limit 1")).rows[0].event_type,'reversed');
 const defs=(await db.query("select pg_get_functiondef('public.advisor_create_order_atomic_v1(uuid,bigint,public.fulfillment_type,numeric,numeric,text,text,text,text,jsonb,jsonb,bigint)'::regprocedure) d")).rows[0].d;
 assert.match(defs,/input.reward_grant_id/);assert.match(defs,/reward_lock_order_grants_v1\(v_order_id,p_items\)/);
 }finally{await db.close();}
});

test('canonical order creation stores a funded configurable line exactly once and failed funding leaves no half-order',async()=>{
 const db=await setup();try{
  const g=await grant(db,{amount:4});await user(db,advisor);
  await db.exec('set role authenticated');
  const token=crypto.randomUUID();
  const inputs=[{product_id:1,qty:1,pricing_origin_currency:'USD',pricing_origin_amount:4,unit_price_usd_snapshot:0,line_total_usd:0,unit_price_bs_snapshot:0,line_total_bs_snapshot:0,
    product_name_snapshot:'Single Pack',notes:'2 Tequeños\n4 Empanadas',reward_grant_id:g,reward_purpose:'customer_gift',reward_amount_usd:4}];
  const create=(key=token)=>db.query("select advisor_create_order_atomic_v1($1::uuid,1,'pickup',0,0,null,null,null,null,$2::jsonb,$3::jsonb,null) result",[key,JSON.stringify({pricing:{fx_rate:850},schedule:{date:'2099-10-30'}}),JSON.stringify(inputs)]);
  const first=(await create()).rows[0].result;assert.equal(first.replayed,false);assert.equal((await create()).rows[0].result.orderId,first.orderId);
  assert.equal((await db.query('select count(*)::int n from orders')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from order_items')).rows[0].n,1);
  assert.equal((await balances(db,g)).reserved_amount,'4.00');await assert.rejects(()=>create(crypto.randomUUID()),/suficiente/);
  assert.equal((await db.query('select count(*)::int n from orders')).rows[0].n,1);
 }finally{await db.close();}
});

test('canonical edit releases removed gifts, retains composition and never resurrects a removed reservation',async()=>{
 const db=await setup();try{
  const g=await grant(db,{amount:20});await user(db,advisor);const o=await order(db);await db.query("update orders set source='advisor' where id=$1",[o]);
  const first=await item(db,o,g,4),second=await item(db,o,g,4);
  const input={...second,order_item_id:second.id,notes:'3 Tequeños\n3 Empanadas'};
  const patch={client_id:1,attributed_advisor_id:advisor,source:'advisor',status:'created',fulfillment:'pickup',extra_fields:{pricing:{fx_rate:850},schedule:{date:'2099-10-31'}}};
  await db.query('select app_private.update_order_core_atomic_v1($1,null,$2::jsonb,$3::jsonb)',[o,JSON.stringify(patch),JSON.stringify([input])]);
  const current=(await db.query('select * from order_items where order_id=$1',[o])).rows;
  assert.equal(current.length,1);assert.equal(current[0].id,second.id);assert.match(current[0].notes,/3 Tequeños/);
  assert.equal((await balances(db,g)).reserved_amount,'4.00');
  assert.equal((await db.query('select status from advisor_reward_uses where order_item_id=$1',[first.id])).rows[0].status,'released');
  const modified=(await db.query('select last_modified_at from orders where id=$1',[o])).rows[0].last_modified_at;
  await db.query('select app_private.update_order_core_atomic_v1($1,$2,$3::jsonb,$4::jsonb)',[o,modified,JSON.stringify(patch),JSON.stringify([{...input,notes:'2 Tequeños\n4 Empanadas'}])]);
  assert.equal((await balances(db,g)).reserved_amount,'4.00');
  assert.equal((await db.query('select count(*)::int n from advisor_reward_uses where status=\'reserved\'')).rows[0].n,1);
 }finally{await db.close();}
});

test('debt credit reduces only current advisor debt, is idempotent, survives recalculation and creates no cash payment',async()=>{
 const db=await setup();try{
  const g=await grant(db);const commercial=await grant(db,{mode:'commercial',purposes:['customer_gift']});await user(db,advisor);
  await db.exec(`insert into advisor_commission_periods values(1,'2026-10-01','2026-10-31','open');insert into advisor_commission_closures(id,period_id,advisor_user_id,status,snapshot) values(1,1,'${advisor}','preliminary','{"commissionBootstrap":{"advisorDebtCarryUsd":12}}');`);
  const token=crypto.randomUUID();
  const apply=(amount,key=token,grantId=g)=>db.query('select reward_apply_debt_v1($1,1,$2,$3::uuid) result',[grantId,amount,key]);
  await assert.rejects(()=>apply(1,crypto.randomUUID(),commercial),/no permite/);
  await assert.rejects(()=>apply(13),/supera la deuda/);
  await apply(5);const replay=(await apply(5)).rows[0].result;assert.equal(replay.replayed,true);
  assert.equal((await db.query('select count(*)::int n from money_movements')).rows[0].n,0);
  const state=async()=>(await db.query('select app_private.commission_collection_state_v1(1) s')).rows[0].s;
  assert.equal((await state()).advisorDebtUsd,7);assert.equal((await balances(db,g)).used_amount,'5.00');
  await db.exec(`update advisor_commission_closures set snapshot=jsonb_set(snapshot,'{settlement,positiveAdjustmentsUsd}','0') where id=1`);
  assert.equal((await state()).advisorDebtUsd,7);
  await assert.rejects(()=>apply(8,crypto.randomUUID()),/supera la deuda/);
  await assert.rejects(()=>apply(4),/otro/);
  await user(db,other);await assert.rejects(()=>apply(1,crypto.randomUUID()),/mismo asesor/);
  await user(db,admin);await db.exec("update advisor_commission_closures set status='closed' where id=1");await user(db,advisor);
  await assert.rejects(()=>apply(1,crypto.randomUUID()),/preliminar/);
 }finally{await db.close();}
});

test('units cover only the awarded normal product, preserve composition and never overdraw',async()=>{
 const db=await setup();try{
 const g=await grant(db,{kind:'product_units',amount:2,productId:1,productScope:'selected_products',allowedProductIds:[1],purposes:['customer_gift']});
 await user(db,advisor);const o=await order(db);const i=await item(db,o,g,4,1,2);
 assert.equal(i.reward_amount_usd,'8.00');assert.equal(Number(i.line_total_usd),0);assert.equal(Number(i.line_total_bs_snapshot),0);
 assert.deepEqual(await balances(db,g),{reserved_amount:'2.00',used_amount:'0.00'});
 await assert.rejects(()=>item(db,o,g,4),/suficiente/);
 await db.query('delete from order_items where id=$1',[i.id]);
 assert.deepEqual(await balances(db,g),{reserved_amount:'0.00',used_amount:'0.00'});
 await assert.rejects(()=>item(db,o,g,1,2),/permitido/);
 await assert.rejects(()=>item(db,o,g,1,1,1.5),/entera/);
 await assert.rejects(()=>item(db,o,g,4,3),/normal/);
 }finally{await db.close();}
});

test('VES credits use the frozen rate; insufficient funding rolls back and removals release the reservation',async()=>{
 const db=await setup();try{
 const g=await grant(db,{amount:1});await user(db,advisor);const o=await order(db);const i=await item(db,o,g,0.5,2);
 assert.equal(i.reward_base_line_usd,'1.00');assert.equal(i.line_total_usd,'0.50');assert.equal(i.line_total_bs_snapshot,'425.00');
 await assert.rejects(()=>item(db,o,g,0.75,2),/suficiente/);
 assert.equal((await db.query('select count(*)::int n from order_items')).rows[0].n,1);
 await db.query('update order_items set notes=$2 where id=$1',[i.id,'Nueva composición']);
 await assert.rejects(()=>db.query('update order_items set qty=2 where id=$1',[i.id]),/retira/i);
 await assert.rejects(()=>db.query('update order_items set reward_grant_id=null where id=$1',[i.id]),/retira/i);
 await db.query('delete from order_items where id=$1',[i.id]);assert.equal((await balances(db,g)).reserved_amount,'0.00');
 }finally{await db.close();}
});

test('owner, purpose, expiry, personal identity, immutable balances and RLS fail closed',async()=>{
 const db=await setup();try{
 const g=await grant(db);await user(db,other);const foreign=await order(db,other);await assert.rejects(()=>item(db,foreign,g),/corresponde/);
 await user(db,advisor);const o=await order(db);
 await assert.rejects(()=>item(db,o,g,1,1,1,'personal_purchase'),/vincular/);
 await assert.rejects(()=>db.query('select reward_set_personal_client_v1($1,2)',[advisor]),/administración/);
 await user(db,admin);await db.query('select reward_set_personal_client_v1($1,2)',[advisor]);await user(db,advisor);
 const own=await order(db,advisor,2);await item(db,own,g,1,1,1,'personal_purchase');
 const late=await order(db,advisor,1,'2099-11-01');await assert.rejects(()=>item(db,late,g),/vencido/);
 await assert.rejects(()=>db.query("update orders set extra_fields=jsonb_set(extra_fields,'{schedule,date}','\"2099-11-01\"') where id=$1",[own]),/vencimiento/);
 await assert.rejects(()=>db.query('update advisor_reward_grants set reserved_amount=0 where id=$1',[g]),/administrador|inmutables/);
 await user(db,admin);await assert.rejects(()=>db.query("select reward_revoke_grant_v1($1,'Revocación de un premio reservado.')",[g]),/reservado/);
 await user(db,other);await db.exec('set role authenticated');assert.equal((await db.query('select count(*)::int n from advisor_reward_uses')).rows[0].n,0);
 await assert.rejects(()=>db.exec('delete from advisor_reward_uses'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
