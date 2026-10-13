import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const admin='00000000-0000-0000-0000-000000000001';
const advisor='00000000-0000-0000-0000-000000000002';
const other='00000000-0000-0000-0000-000000000003';
const master='00000000-0000-0000-0000-000000000004';
const token='00000000-0000-0000-0000-000000000005';
const payload={advisorId:advisor,title:'Delivery credit',category:'alchemist',period:'2026-09',kind:'credit',mode:'commercial',purposes:['customer_gift'],amount:20,productId:null,productScope:'selected_products',allowedProductIds:[2],expiresOn:'2026-11-30',note:''};
const schema=`
create role anon; create role authenticated; create role service_role;
create schema auth; create schema app_private;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.profiles(id uuid primary key,full_name text,is_active boolean default true);
create table public.user_roles(user_id uuid,role text);
create function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin')$$;
create table public.products(id bigint primary key,name text,is_active boolean default true);
create table public.orders(id bigint primary key,total_usd numeric); insert into public.orders values(7,15);
create table public.commission_ledger(id bigint primary key,amount numeric); insert into public.commission_ledger values(1,2);
grant usage on schema public,auth to authenticated,anon;
insert into public.profiles(id,full_name) values('${admin}','Admin'),('${advisor}','Advisor'),('${other}','Other'),('${master}','Master');
insert into public.user_roles values('${admin}','admin'),('${advisor}','advisor'),('${other}','advisor'),('${master}','master');
insert into public.products values(2,'Delivery Zona 1',true),(3,'Single Pack',true),(4,'Inactive',false);
`;
async function setup(){const db=new PGlite();await db.exec(schema);await db.exec(readFileSync(new URL('../../supabase/migrations/20261013141407_advisor_reward_wallet_foundation.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261013143845_reward_wallet_lock_order.sql',import.meta.url),'utf8'));await asUser(db,admin);return db;}
const asUser=(db,id)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const save=(db,data=payload,key=token,id=null,version=null)=>db.query('select public.reward_save_draft_v1($1::jsonb,$2::uuid,$3::bigint,$4::integer) v',[JSON.stringify(data),key,id,version]);
test('creation is design-only, idempotent, and unrelated financial data stays intact',async()=>{
 const db=await setup();try{
  const first=(await save(db)).rows[0].v;assert.equal(first.status,'draft');
  assert.deepEqual((await save(db)).rows[0].v,first);
  assert.equal((await db.query('select count(*)::int n from advisor_reward_drafts')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from advisor_reward_draft_events')).rows[0].n,1);
  await assert.rejects(()=>save(db,{...payload,amount:30}),/diferente/);
  assert.equal((await db.query('select total_usd from orders')).rows[0].total_usd,'15');
  assert.equal((await db.query('select amount from commission_ledger')).rows[0].amount,'2');
  await assert.rejects(()=>db.exec("update advisor_reward_drafts set status='active'"),/administrador|constraint/);
 }finally{await db.close();}
});
test('advisor and master cannot configure awards; RLS keeps designs private',async()=>{
 const db=await setup();try{
  await save(db);
  for(const user of [advisor,other,master]){
   await asUser(db,user);await assert.rejects(()=>save(db),/Solo el administrador/);
   await db.exec('set role authenticated');
   assert.equal((await db.query('select count(*)::int n from advisor_reward_drafts')).rows[0].n,0);
   await assert.rejects(()=>db.exec("insert into advisor_reward_drafts(title) values('Bad')"),/permission denied/);
   await db.exec('reset role');
  }
  await asUser(db,admin);await db.exec('set role authenticated');
  assert.equal((await db.query('select count(*)::int n from advisor_reward_drafts')).rows[0].n,1);
  await db.exec('reset role;set role anon');await assert.rejects(()=>save(db),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('restriction validation and full product snapshots are authoritative in database',async()=>{
 const db=await setup();try{
  for(const data of [
   {...payload,mode:'commercial',purposes:['advisor_debt']},
   {...payload,amount:20.001},
   {...payload,allowedProductIds:[4]},
   {...payload,allowedProductIds:[2,2]},
   {...payload,kind:'product_units',amount:1.5,productId:3,allowedProductIds:[3]},
   {...payload,kind:'product_units',productId:3,allowedProductIds:[2]},
   {...payload,expiresOn:'2026-08-31'},
  ])await assert.rejects(()=>save(db,data));
  const data={...payload,kind:'product_units',mode:'flexible',purposes:['customer_gift','personal_purchase'],amount:3,productId:3,allowedProductIds:[3]};
  await save(db,data);
  const row=(await db.query('select * from advisor_reward_drafts')).rows[0];
  assert.equal(row.product_name_snapshot,'Single Pack');assert.deepEqual(row.product_names_snapshot,['Single Pack']);
  assert.equal(row.status,'draft');
 }finally{await db.close();}
});
test('optimistic editing, reasoned cancellation, immutable history, no reopening',async()=>{
 const db=await setup();try{
  const id=(await save(db)).rows[0].v.id;
  await save(db,{...payload,amount:30},token,id,1);
  await assert.rejects(()=>save(db,{...payload,amount:40},token,id,1),/cambió/);
  await assert.rejects(()=>db.exec('delete from advisor_reward_draft_events'),/inmutable/);
  await assert.rejects(()=>db.exec("update advisor_reward_draft_events set reason='Rewrite'"),/inmutable/);
  await assert.rejects(()=>db.query('select reward_cancel_draft_v1($1,2,$2)',[id,'']),/Justifica/);
  await db.query('select reward_cancel_draft_v1($1,2,$2)',[id,'Se cancela el diseño tras revisar el presupuesto.']);
  await assert.rejects(()=>save(db,payload,token,id,3),/disponible/);
  const events=(await db.query('select * from advisor_reward_draft_events order by id')).rows;
  assert.deepEqual(events.map(e=>e.event_type),['created','updated','cancelled']);
  assert.equal(events[0].after_snapshot.amount,20);assert.equal(events[1].before_snapshot.amount,20);
  assert.equal(events[1].after_snapshot.amount,30);assert.equal(events[2].after_snapshot.status,'cancelled');
 }finally{await db.close();}
});
