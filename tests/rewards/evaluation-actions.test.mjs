import test from 'node:test';
import assert from 'node:assert/strict';
import { compile,model,advisor,input } from './evaluation-render-fixture.mjs';
function actions({authorized=true,error=null}={}){
 const calls=[];const revalidated=[];const rules={...model.defaultAwardRules('2026-09'),globalMinimum:90};
 const context={user:{id:advisor},supabase:{rpc:async(name,args)=>{calls.push({name,args});return {data:advisor,error};},from:table=>{assert.equal(table,'award_month_reports');const q={select(){return q;},eq(){return q;},single:async()=>({data:{input_snapshot:input(),rules_snapshot:rules},error:null})};return q;}}};
 const result=compile('../../src/app/app/admin/evaluacion/actions.ts',{
  '@/lib/auth':{requireAdminContext:async()=>{if(!authorized)throw Error('No autorizado.');return context;}},
  '@/lib/rewards/evaluation-model':model,'@/lib/rewards/wallet-model':{UUID_PATTERN:/^[0-9a-f-]{36}$/},'next/cache':{revalidatePath:path=>revalidated.push(path)},
  '@/lib/rewards/evaluation-server':{awardCalculationServer:()=>context.supabase},
 });return{...result,calls,revalidated};
}
test('preparation and resume calculate from authoritative stored input/rules, not browser scores',async()=>{
 const a=actions();const rules={...model.defaultAwardRules('2026-09'),globalMinimum:80,points:99999};
 const result=await a.prepareAwardReview('2026-09',rules,advisor);assert.equal(result.ok,true);
 assert.equal(a.calls[0].name,'admin_award_prepare_v2');assert.equal(a.calls[1].name,'admin_award_calculate_v2');
 assert.equal(a.calls[1].args.p_results.globalMinimum,90);assert.equal(a.calls[1].args.p_results.advisors[0].total,100);
 assert.equal(a.calls[1].args.p_results.points,undefined);assert.equal(a.calls.some(c=>c.name.includes('reward_issue')),false);
 assert.equal((await a.resumeAwardReview(advisor)).ok,true);
});
test('admin auth, explicit confirmation, validation and errors prevent publication side effects',async()=>{
 const denied=actions({authorized:false});assert.equal((await denied.prepareAwardReview('2026-09',model.defaultAwardRules('2026-09'),advisor)).ok,false);assert.equal((await denied.publishAwardReview(advisor,null,'Reviewed this month.',true)).ok,false);assert.equal(denied.calls.length,0);
 const valid=actions();assert.equal((await valid.publishAwardReview(advisor,null,'Reviewed this month.',false)).ok,false);assert.equal(valid.calls.length,0);
 assert.equal((await valid.publishAwardReview(advisor,null,'Reviewed this month.',true)).ok,true);assert.equal(valid.calls[0].name,'admin_award_publish_v2');assert.ok(valid.revalidated.includes('/app/advisor/reconocimientos'));
 const failed=actions({error:{message:'Publication changed; refresh first.'}});assert.equal((await failed.publishAwardReview(advisor,null,'Reviewed this month.',true)).ok,false);assert.equal(failed.revalidated.length,0);
});
