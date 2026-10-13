import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const admin='00000000-0000-0000-0000-000000000001';
const advisor='00000000-0000-0000-0000-000000000002';
const outsider='00000000-0000-0000-0000-000000000003';
const master='00000000-0000-0000-0000-000000000004';
const token='00000000-0000-0000-0000-000000000005';
const reason='Reconocimiento revisado y aprobado por administración.';
const payload={advisorId:advisor,title:'Delivery credit',category:'alchemist',period:'2026-09',kind:'credit',mode:'commercial',purposes:['customer_gift'],amount:20,productId:null,productScope:'selected_products',allowedProductIds:[2],expiresOn:'2099-11-30',note:'Private configuration note'};
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
async function asUser(db,user){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);}
async function setup(){
 const db=new PGlite();
 await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create schema app_private;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table profiles(id uuid primary key,full_name text,is_active boolean default true);
 create table user_roles(user_id uuid,role text);
 create function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role='admin')$$;
 create table products(id bigint primary key,name text,is_active boolean default true);
 create table orders(id bigint,total_usd numeric);insert into orders values(7,15);
 create table commission_ledger(id bigint,amount numeric);insert into commission_ledger values(1,2);
 grant usage on schema public,auth to authenticated,anon;
 insert into profiles(id,full_name) values('${admin}','Admin'),('${advisor}','Advisor'),('${outsider}','Other'),('${master}','Master');
 insert into user_roles values('${admin}','admin'),('${advisor}','advisor'),('${outsider}','advisor'),('${master}','master');
 insert into products values(2,'Delivery Zona 1',true),(3,'Single Pack',true);
 `);
 for(const file of ['20261013141407_advisor_reward_wallet_foundation.sql','20261013143845_reward_wallet_lock_order.sql','20261013151045_advisor_reward_issuance.sql'])await db.exec(read('../../supabase/migrations/'+file));
 await asUser(db,admin);return db;
}
const save=(db,input=payload,key=token)=>db.query('select reward_save_draft_v1($1::jsonb,$2::uuid) v',[JSON.stringify(input),key]);
const issue=(db,id,version=1,note=reason)=>db.query('select reward_issue_draft_v1($1,$2,$3) v',[id,version,note]);
const revoke=(db,id,note=reason)=>db.query('select reward_revoke_grant_v1($1,$2) v',[id,note]);

test('issuance freezes exactly one grant and public terms; retry never awards twice',async()=>{
 const db=await setup();try{
  const id=(await save(db)).rows[0].v.id;const first=(await issue(db,id)).rows[0].v;
  assert.equal(first.status,'active');assert.equal(first.replayed,false);
  const replay=(await issue(db,id)).rows[0].v;assert.equal(replay.grant_id,first.grant_id);assert.equal(replay.replayed,true);
  assert.equal((await db.query('select count(*)::int n from advisor_reward_grants')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from advisor_reward_events')).rows[0].n,1);
  const draft=(await db.query('select * from advisor_reward_drafts')).rows[0];assert.equal(draft.status,'issued');assert.equal(draft.version,2);
  const grant=(await db.query('select * from advisor_reward_grants')).rows[0];
  assert.equal(grant.source_version,1);assert.equal(grant.terms_snapshot.title,payload.title);
  assert.equal(grant.terms_snapshot.note,undefined);assert.equal(grant.terms_snapshot.request_token,undefined);
  assert.equal(grant.period.toISOString().slice(0,10),'2026-09-01');
  await assert.rejects(()=>issue(db,id,2),/otra solicitud/);
  await assert.rejects(()=>issue(db,id,1,'Se intenta emitir con un motivo cambiado.'),/otra solicitud/);
  await assert.rejects(()=>db.query('select reward_save_draft_v1($1::jsonb,$2::uuid,$3,2)',[JSON.stringify(payload),token,id]),/disponible/);
  await assert.rejects(()=>db.query('select reward_cancel_draft_v1($1,2,$2)',[id,reason]),/disponible/);
  assert.equal((await db.query('select total_usd from orders')).rows[0].total_usd,'15');
  assert.equal((await db.query('select amount from commission_ledger')).rows[0].amount,'2');
 }finally{await db.close();}
});
test('only admin issues/revokes; RLS exposes only own grants and their history',async()=>{
 const db=await setup();try{
  const id=(await save(db)).rows[0].v.id;
  for(const user of [advisor,outsider,master]){await asUser(db,user);await assert.rejects(()=>issue(db,id),/Solo el administrador/);}
  await asUser(db,admin);const grantId=(await issue(db,id)).rows[0].v.grant_id;
  const second=(await save(db,{...payload,advisorId:outsider},'00000000-0000-0000-0000-000000000006')).rows[0].v.id;await issue(db,second);
  for(const [user,count] of [[advisor,1],[outsider,1],[master,0],[admin,2]]){
   await asUser(db,user);await db.exec('set role authenticated');
   assert.equal((await db.query('select count(*)::int n from advisor_reward_grants')).rows[0].n,count);
   assert.equal((await db.query('select count(*)::int n from advisor_reward_events')).rows[0].n,count);
   await assert.rejects(()=>db.exec('delete from advisor_reward_grants'),/permission denied/);
   await assert.rejects(()=>db.exec("update advisor_reward_grants set amount=100"),/permission denied/);
   await db.exec('reset role');
   if(user!==admin)await assert.rejects(()=>revoke(db,grantId),/Solo el administrador/);
  }
  await db.exec('set role anon');await assert.rejects(()=>issue(db,id),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('stale, cancelled, expired, inactive products and inactive advisors cannot issue',async()=>{
 const db=await setup();try{
  const id=(await save(db)).rows[0].v.id;
  await assert.rejects(()=>issue(db,id,9),/cambió/);
  await assert.rejects(()=>issue(db,id,1,''),/motivo/);
  await db.exec('update products set is_active=false where id=2');await assert.rejects(()=>issue(db,id),/inactivos/);await db.exec('update products set is_active=true where id=2');
  await db.exec(`update profiles set is_active=false where id='${advisor}'`);await assert.rejects(()=>issue(db,id),/activo/);await db.exec(`update profiles set is_active=true where id='${advisor}'`);
  await db.query('select reward_cancel_draft_v1($1,1,$2)',[id,reason]);await assert.rejects(()=>issue(db,id),/disponible/);
  const expired=(await save(db,{...payload,expiresOn:'2026-09-01'},'00000000-0000-0000-0000-000000000007')).rows[0].v.id;
  await assert.rejects(()=>issue(db,expired),/vencido/);
  assert.equal((await db.query('select count(*)::int n from advisor_reward_grants')).rows[0].n,0);
 }finally{await db.close();}
});
test('units are immutable units; revocation preserves terms, history and no reissuance',async()=>{
 const db=await setup();try{
  const id=(await save(db,{...payload,kind:'product_units',productId:3,allowedProductIds:[3],amount:3})).rows[0].v.id;
  const grantId=(await issue(db,id)).rows[0].v.grant_id;
  const before=(await db.query('select * from advisor_reward_grants')).rows[0];
  assert.equal(before.kind,'product_units');assert.equal(before.amount,'3.00');
  await assert.rejects(()=>db.exec("update advisor_reward_grants set amount=10"),/inmutables/);
  await assert.rejects(()=>db.exec('delete from advisor_reward_events'),/inmutable/);
  await assert.rejects(()=>revoke(db,grantId,''),/Justifica/);
  await revoke(db,grantId);assert.equal((await revoke(db,grantId)).rows[0].v.replayed,true);
  const after=(await db.query('select * from advisor_reward_grants')).rows[0];
  assert.deepEqual(after.terms_snapshot,before.terms_snapshot);assert.equal(after.status,'revoked');
  const replay=(await issue(db,id)).rows[0].v;assert.equal(replay.status,'revoked');
  assert.deepEqual((await db.query('select event_type from advisor_reward_events order by id')).rows.map(e=>e.event_type),['issued','revoked']);
  await assert.rejects(()=>db.exec("update advisor_reward_grants set status='active',revoked_by=null,revoked_at=null,revoke_reason=null"),/inmutables/);
 }finally{await db.close();}
});
