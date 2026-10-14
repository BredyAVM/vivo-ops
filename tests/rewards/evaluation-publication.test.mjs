import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup,admin,advisor,other,counter } from './evaluation-fixture.mjs';
import { evaluateAwards,defaultAwardRules } from '../../src/lib/rewards/evaluation-model.ts';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
async function complete(){
 const db=await setup();
 await db.exec(`create schema app_private;create role service_role;alter table profiles add primary key(id);
 insert into profiles values('${admin}','Admin',true,false);
 insert into user_roles values('${admin}','admin');
 create function public.has_role(p_role text) returns boolean language sql stable as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role=p_role)$$;
 create table crm_plays(id bigint,name text,activated_at timestamptz,ends_at timestamptz);
 create table crm_play_members(id bigint,play_id bigint,client_id bigint,advisor_id_snapshot uuid,created_at timestamptz,updated_at timestamptz,workflow_status text,contacted_at timestamptz,responded_at timestamptz,play_launched_at timestamptz);
 create table crm_play_member_events(id bigint,play_member_id bigint,event_type text,note text,created_at timestamptz);
 create table crm_play_no_apply_requests(play_member_id bigint,status text,reviewed_at timestamptz,requested_at timestamptz);
 create table crm_play_amendments(id bigint,play_id bigint,client_id bigint,created_at timestamptz,amendment_type text);
 alter table orders add column status text;alter table orders add column client_id bigint;
 create table order_items(id bigint,order_id bigint,product_id bigint,qty numeric,crm_play_member_id bigint);
 create table crm_play_redemptions(id bigint,play_member_id bigint,order_id bigint,order_item_id bigint,product_id bigint,status text,redeemed_at timestamptz,advisor_charge_usd numeric,company_cost_usd numeric);
 insert into crm_plays values(18,'Anniversary','2026-09-10T12:00:00-04:00','2026-10-01T03:59:59Z'),(19,'Season','2026-09-20T12:00:00-04:00','2026-10-01T03:59:59Z');
 insert into crm_play_members values
 (101,18,1,'${advisor}','2026-09-10','2026-09-20','converted',null,null,null),
 (102,18,2,'${advisor}','2026-09-10','2026-09-20','pending',null,null,null),
 (103,18,3,'${advisor}','2026-09-10','2026-09-21','removed',null,null,null),
 (104,18,4,'${advisor}','2026-09-10','2026-10-02','removed',null,null,null),
 (105,19,1,'${advisor}','2026-09-20','2026-09-25','launched',null,null,'2026-09-25'),
 (106,18,6,'${other}','2026-09-10','2026-09-11','contacted','2026-09-11',null,null);
 insert into crm_play_no_apply_requests values(102,'pending',null,'2026-09-20'),(103,'approved','2026-09-21','2026-09-20'),(104,'approved','2026-10-02','2026-09-20'),(101,'approved','2026-09-25','2026-09-24');
 insert into crm_play_member_events values(1,106,'contact','Manual contact','2026-09-11'),(2,101,'responded','Inferido por entrega','2026-09-20');
 insert into orders values(501,'{}','delivered',1),(502,'{}','delivered',4);
 insert into order_items values(9001,501,777,1,101),(9002,501,777,1,101),(9003,502,777,1,104);
 insert into crm_play_redemptions values(1,101,501,9001,777,'redeemed','2026-09-20',1,2),(2,101,501,9002,777,'redeemed','2026-09-20',2,2),(3,104,502,9003,777,'voided','2026-09-20',1,2);
 alter table crm_play_no_apply_requests add column review_note text;alter table crm_play_no_apply_requests add column justification text;
 alter table crm_play_amendments add column reason text;
 update crm_play_no_apply_requests set review_note='Excluded after admin review.' where play_member_id=103;
 `);
 await db.exec(read('../../supabase/migrations/20261013163522_award_executor_and_capture.sql'));
 await db.exec(read('../../supabase/migrations/20261013163559_award_monthly_publication.sql'));
 await db.exec(read('../../supabase/migrations/20261014150107_award_executor_contact_and_september_review.sql'));
 await db.exec(read('../../supabase/migrations/20261014162250_award_executor_balanced_volume.sql'));
 return db;
}
const token=n=>'10000000-0000-0000-0000-'+String(n).padStart(12,'0');
const auth=(db,user)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
const prepare=async(db,n=1,rules=defaultAwardRules('2026-09'),month='2026-09-01')=>(await db.query('select admin_award_prepare_v2($1::date,$2::jsonb,$3::uuid) id',[month,JSON.stringify(rules),token(n)])).rows[0].id;
const row=async(db,id)=>(await db.query('select * from award_month_reports where id=$1',[id])).rows[0];
const calculate=async(db,id)=>{const r=await row(db,id);const results=evaluateAwards(r.input_snapshot,r.rules_snapshot);await db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify(results),admin]);return results;};
const publish=(db,id,expected=null,reason='Monthly review approved after checking rules and evidence.')=>db.query('select admin_award_publish_v2($1,$2,$3)',[id,expected,reason]);

test('reformed capture separates inferred response, infers contact from proposal, deduplicates monthly volume and keeps raw states',async()=>{
 const db=await complete();try{
  await db.exec(`insert into crm_play_member_events values(3,105,'launched','Manual proposal','2026-09-25'),(4,105,'responded','Respuesta inferida automáticamente al lanzar','2026-09-25');
   update crm_play_members set responded_at='2026-09-25' where id=105;`);
  const v=(await db.query("select admin_award_evaluation_preview_v3('2026-09-01',$1,'executor',0) v",[advisor])).rows[0].v;
  assert.equal(v.execution.metrics_version,'executor-summary-v3');assert.ok(!('evidence' in v.execution));
  const c=v.execution.balanced_counts.find(x=>x.advisor_id===advisor&&x.play_id===19);
  assert.equal(c.contact,1);assert.equal(c.response,0);assert.equal(c.proposal,1);
  assert.equal(v.execution.counts.find(x=>x.play_id===19).response,1); // raw inference preserved only for comparison
  const volume=v.execution.balanced_volume.find(x=>x.advisor_id===advisor);
  assert.equal(volume.proposal_clients,1);assert.equal(volume.delivered_clients,1);
  assert.equal(v.execution.balanced_counts.find(x=>x.play_id===18&&x.advisor_id===advisor).assigned,3);
  const id=await prepare(db);const before=await row(db,id);assert.equal(before.input_snapshot.execution.metrics_version,'executor-summary-v3');
  await db.exec("update crm_play_members set responded_at='2026-09-30'");assert.deepEqual((await row(db,id)).input_snapshot,before.input_snapshot);
  await assert.rejects(()=>prepare(db,2,{...defaultAwardRules('2026-09'),executorDeliveryVolumeReference:0}),/gradual/);
  await auth(db,advisor);await assert.rejects(()=>db.query("select admin_award_evaluation_preview_v3('2026-09-01')"),/Solo el administrador/);
  await db.exec('set role authenticated');await assert.rejects(()=>db.query("select app_private.award_executor_summarize_v3('{}')"),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('executor uses confirmed deliveries, separate direct events, distinct client volume and cutoff-approved exclusions',async()=>{
 const db=await complete();try{
  const data=(await db.query("select admin_award_evaluation_preview_v2('2026-09-01',$1,'executor',0) v",[advisor])).rows[0].v;
  const c=data.execution.counts.find(x=>x.advisor_id===advisor&&x.play_id===18);
  assert.equal(c.assigned,3);assert.equal(c.excluded,1);assert.equal(c.pending_no_apply,2);
  assert.equal(c.contact,1);assert.equal(c.response,1);assert.equal(c.proposal,1);assert.equal(c.delivered,1);
  assert.equal(c.direct_response,0);assert.equal(c.advisor_investment,3);assert.equal(c.company_investment,4);
  assert.equal(data.execution.volume.find(v=>v.advisor_id===advisor).proposal_clients,1); // two proposals to the same client
  assert.equal(data.evidence_total,5);assert.equal(data.executor_evidence.find(e=>e.member_id===104).excluded,false); // October approval does not rewrite September
  assert.equal(data.executor_evidence.find(e=>e.member_id===101).excluded,false); // gift delivered never leaves denominator
  assert.ok(data.executor_evidence.find(e=>e.member_id===103).exclusion_reason.includes('Excluded after admin review.'));
 }finally{await db.close();}
});
test('cut is idempotent, freezes all evidence, can resume calculation and does not issue financial rewards',async()=>{
 const db=await complete();try{
  const id=await prepare(db);assert.equal(await prepare(db),id);
  const before=await row(db,id);assert.ok(before.input_snapshot.evidence.length>0);assert.equal(before.status,'draft');
  await db.exec('update commercial_order_facts set net_total_usd=999');
  assert.deepEqual((await row(db,id)).input_snapshot,before.input_snapshot);
  const results=await calculate(db,id);await db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify(results),admin]);
  assert.equal((await row(db,id)).status,'review');assert.equal((await db.query('select count(*)::int n from award_month_events')).rows[0].n,2);
  await assert.rejects(()=>db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify({...results,advisors:[]}),admin]),/otro cálculo/);
  await assert.rejects(()=>prepare(db,1,{...defaultAwardRules('2026-09'),globalMinimum:70}),/otra revisión/);
  await assert.rejects(()=>prepare(db,2,{...defaultAwardRules('2026-09'),executorEnabled:true}),/Septiembre/);
  await assert.rejects(()=>prepare(db,3,{...defaultAwardRules('2026-09'),globalMinimum:0}),/parámetros/);
  assert.equal((await db.query('select count(*)::int n from orders')).rows[0].n,2);
 }finally{await db.close();}
});
test('publication is review-only, past-month-only, immutable and correction preserves the superseded result',async()=>{
 const db=await complete();try{
  const first=await prepare(db);await assert.rejects(()=>publish(db,first),/Revisa/);await calculate(db,first);
  await publish(db,first);await publish(db,first);assert.equal((await row(db,first)).status,'published');
  const original=await row(db,first);
  const second=await prepare(db,2);await calculate(db,second);await assert.rejects(()=>publish(db,second),/cambió/);
  await publish(db,second,first,'Correction reviewed without overwriting the original history.');
  const old=await row(db,first);assert.equal(old.status,'superseded');assert.deepEqual(old.input_snapshot,original.input_snapshot);assert.deepEqual(old.result_snapshot,original.result_snapshot);
  assert.equal((await row(db,second)).supersedes_id,first);assert.equal((await db.query("select count(*)::int n from award_month_reports where status='published'")).rows[0].n,1);
  await assert.rejects(()=>db.exec('delete from award_month_reports'),/inmutable/);
  const current=await prepare(db,3,defaultAwardRules('2026-10'),'2026-10-01');await calculate(db,current);await assert.rejects(()=>publish(db,current),/en curso/);
 }finally{await db.close();}
});
test('September can be corrected with an admin acceptance note, full references and frozen contact target',async()=>{
 const db=await complete();try{
  const first=await prepare(db);await calculate(db,first);await publish(db,first);const original=await row(db,first);
  const rules={...defaultAwardRules('2026-09'),executorEnabled:true,contactTargetPct:80,executorReviewNote:'Aceptación administrativa de septiembre con limitaciones de registro conservadas.',deliveryTargets:{'18':28,'19':14}};
  await assert.rejects(()=>prepare(db,2,{...rules,executorReviewNote:''}),/Septiembre/);
  await assert.rejects(()=>prepare(db,3,{...rules,contactTargetPct:0}),/contacto/);
  await assert.rejects(()=>prepare(db,4,{...rules,deliveryTargets:{'18':28}}),/metas de entrega/);
  const revised=await prepare(db,5,rules);assert.equal(await prepare(db,5,rules),revised);const result=await calculate(db,revised);
  assert.equal(result.executorAvailable,true);assert.equal(result.advisors[0].categories.executor.indicators[0].target,80);
  await publish(db,revised,first,'Corrección aceptada de septiembre: contacto 80 y Ejecutor incluido con salvedades.');
  assert.equal((await row(db,first)).status,'superseded');assert.deepEqual((await row(db,first)).result_snapshot,original.result_snapshot);
  assert.equal((await row(db,revised)).rules_snapshot.executorReviewNote,rules.executorReviewNote);
 }finally{await db.close();}
});
test('advisors see only their published indicators and evidence; raw snapshots, admin actions and draft results stay private',async()=>{
 const db=await complete();try{
  const id=await prepare(db);await calculate(db,id);
  await auth(db,advisor);assert.equal((await db.query("select advisor_award_month_view_v2('2026-09-01','alchemist',0) v")).rows[0].v,null);
  await auth(db,admin);await publish(db,id);
  for(const user of [advisor,other]){
   await auth(db,user);await db.exec('set role authenticated');
   assert.equal((await db.query('select count(*)::int n from award_month_reports')).rows[0].n,0);
   const v=(await db.query("select advisor_award_month_view_v2('2026-09-01','executor',0) v")).rows[0].v;
   assert.equal(v.own.id,user);assert.ok(v.evidence.every(e=>e.advisor_id===user));assert.ok(!('input_snapshot' in v));assert.equal(v.board.length,2);
   await assert.rejects(()=>prepare(db),/Solo el administrador/);await assert.rejects(()=>publish(db,id),/Solo el administrador/);
   await assert.rejects(()=>db.exec("select app_private.award_facts_capture_v2('2026-09-01')"),/permission denied/);
   await db.exec('reset role');
  }
  await auth(db,counter);await assert.rejects(()=>db.query("select advisor_award_month_view_v2('2026-09-01')"),/No autorizado/);
  await auth(db,admin);await db.exec('set role anon');await assert.rejects(()=>publish(db,id),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('even browser-admin cannot submit scores; calculation storage is backend-only with a verified admin actor',async()=>{
 const db=await complete();try{
  const id=await prepare(db);const r=await row(db,id);const results=evaluateAwards(r.input_snapshot,r.rules_snapshot);
  await db.exec('set role authenticated');await assert.rejects(()=>db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify(results),admin]),/permission denied/);await db.exec('reset role');
  await auth(db,'');await db.exec('set role service_role');
  await assert.rejects(()=>db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify(results),advisor]),/administrador validado/);
  await db.query('select admin_award_calculate_v2($1,$2::jsonb,$3)',[id,JSON.stringify(results),admin]);await db.exec('reset role');
  assert.equal((await row(db,id)).status,'review');assert.equal((await db.query("select actor_id from award_month_events where event_type='calculated'")).rows[0].actor_id,admin);
 }finally{await db.close();}
});
