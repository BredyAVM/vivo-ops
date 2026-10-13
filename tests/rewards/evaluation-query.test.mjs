import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const admin='00000000-0000-0000-0000-000000000001';
const advisor='00000000-0000-0000-0000-000000000002';
const other='00000000-0000-0000-0000-000000000003';
const counter='00000000-0000-0000-0000-000000000004';
const migration=readFileSync(new URL('../../supabase/migrations/20261013155128_advisor_award_evaluation_preview.sql',import.meta.url),'utf8');
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function public.is_admin() returns boolean language sql stable as $$select auth.uid()='${admin}'::uuid$$;
 create table profiles(id uuid,full_name text,is_active boolean,receives_commissions boolean);
 create table user_roles(user_id uuid,role text);
 create table clients(id bigint,full_name text,client_type text);
 create table orders(id bigint,extra_fields jsonb);
 create table commercial_order_facts(fact_key text,fact_origin text,source_record_id bigint,source_control text,client_id bigint,purchased_at timestamptz,attributed_advisor_id uuid,advisor_name_snapshot text,net_total_usd numeric,event_kind text);
 insert into profiles values('${advisor}','Advisor',true,true),('${other}','Other',true,true),('${counter}','Counter',true,false);
 insert into user_roles values('${advisor}','advisor'),('${other}','advisor'),('${counter}','counter');
 insert into clients values(1,'Assigned','assigned'),(2,'Own','own'),(3,'Company mislabeled own','own'),(4,'Company assigned','assigned'),(5,'Ambiguous','own'),(6,'Mature','own');
 `);
 await db.exec(migration);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
 const insert=async(id,date,owner,price=10,key)=>{
  const fact=key??'f'+id+'-'+date+'-'+owner;
  await db.query(`insert into commercial_order_facts values($1,'live',1,$1,$2,$3::timestamptz,$4::uuid,'Advisor',$5,'purchase')`,[fact,id,date+'T12:00:00-04:00',owner,price]);
 };
 await insert(1,'2026-07-10',advisor);await insert(1,'2026-08-10',advisor);await insert(1,'2026-09-10',advisor);await insert(1,'2026-09-11',other,1000);
 await insert(2,'2026-08-10',advisor);await insert(2,'2026-09-10',advisor);await insert(2,'2026-09-11',advisor,0);
 await insert(3,'2026-05-01',counter);await insert(3,'2026-05-02',counter);await insert(3,'2026-09-05',advisor);await insert(3,'2026-09-06',advisor);
 await insert(4,'2026-08-01',counter);await insert(4,'2026-08-05',advisor);await insert(4,'2026-09-05',advisor);
 await insert(5,'2026-08-10',advisor);await insert(5,'2026-08-10',other);
 await insert(6,'2026-01-01',advisor);await insert(6,'2026-08-10',advisor);await insert(6,'2026-09-10',advisor);await insert(6,'2026-09-10',advisor,10,'same-day-second');
 return db;
}
const preview=async(db,owner=null,category=null,offset=0)=>(await db.query('select admin_award_evaluation_preview_v1($1::date,$2::uuid,$3,$4) v',['2026-09-01',owner,category,offset])).rows[0].v;
test('cohorts honor same-advisor purchases, company activation, no duplicated capture and continuity',async()=>{
 const db=await setup();try{
  const data=await preview(db,advisor,'alchemist');
  const a=data.cohort_metrics.find(r=>r.advisor_id===advisor&&r.category==='alchemist');
  assert.equal(a.incorporation,1);assert.equal(a.inferred_new,1);assert.equal(a.older_pool,2);
  assert.equal(a.older_returned,2);assert.equal(a.return_pct,100);assert.equal(a.regularity_pct,100);
  assert.equal(a.repeat_orders,3);assert.equal(a.revenue,40); // excludes 1000 through another advisor
  assert.equal(data.ambiguous_clients,1);assert.equal(data.evidence_total,3);
  const own=data.cohort_metrics.find(r=>r.advisor_id===advisor&&r.category==='influential');
  assert.equal(own.older_pool,1);assert.equal(own.repeat_orders,1);assert.equal(own.revenue,10);
  const s=data.strategic_metrics.find(r=>r.advisor_id===advisor);
  assert.equal(s.mature_portfolio,1);assert.equal(s.current_active,1);assert.equal(s.multi_day_buyers,0); // two same-day orders count one purchase date; current-month activation has no prior owner
  assert.equal((await preview(db,advisor,'alchemist',50)).evidence.length,0);
  assert.equal(data.rule_version,'awards-preview-v1');
 }finally{await db.close();}
});
test('authorization, invalid arguments and permission boundary are enforced in database',async()=>{
 const db=await setup();try{
  for(const user of [advisor,other,counter,'']){
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
   await assert.rejects(()=>preview(db),/Solo el administrador/);
  }
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
  for(const [month,owner,category,offset] of [['2026-09-02',null,null,0],['2025-09-01',null,null,0],['2099-01-01',null,null,0],['2026-09-01',advisor,null,0],['2026-09-01',advisor,'executor',0],['2026-09-01',null,null,-1]]){
   await assert.rejects(()=>db.query('select admin_award_evaluation_preview_v1($1::date,$2::uuid,$3,$4)',[month,owner,category,offset]),/inválidos/);
  }
  await db.exec('set role anon');await assert.rejects(()=>preview(db),/permission denied/);await db.exec('reset role');
  await db.exec('set role authenticated');assert.equal((await preview(db)).cohort_metrics.length,4);await db.exec('reset role');
  const before=(await db.query('select count(*)::int n from orders')).rows[0].n;await preview(db);
  assert.equal((await db.query('select count(*)::int n from orders')).rows[0].n,before);
 }finally{await db.close();}
});
