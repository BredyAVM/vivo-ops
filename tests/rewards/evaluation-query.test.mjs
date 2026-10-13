import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,admin,advisor,other,counter} from './evaluation-fixture.mjs';
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
