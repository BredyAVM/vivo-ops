import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

function compile(relativePath, imports={}) {
 const source=readFileSync(new URL(relativePath,import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,require:name=>{
  if(!(name in imports))throw Error('Unexpected test import: '+name);
  return imports[name];
 },console,Intl,Date,process:{env:{SUPABASE_URL:'http://local.test',SUPABASE_SERVICE_ROLE_KEY:'local-fixture-only'}}});
 return module.exports;
}
const prices=compile('../../src/lib/pricing/order-snapshots.ts');
const approvals=compile('../../src/lib/orders/approved-price-preservation.ts');
const operational=compile('../../src/lib/orders/operational-edit-pricing.ts',{'./approved-price-preservation.ts':approvals,'../pricing/order-snapshots.ts':prices});
const wallet=compile('../../src/lib/rewards/wallet-model.ts');
const funding=compile('../../src/lib/rewards/order-funding.ts',{'../pricing/order-snapshots.ts':prices,'./wallet-model.ts':wallet});
const details=compile('../../src/lib/orders/order-change-detail.ts');
const advisor='00000000-0000-0000-0000-000000000002';

function fixture(previousFunding={},rpcError=null,actor=advisor) {
 const calls=[],selections=[],invalidations=[];
 const original={id:7,product_id:25,product_name_snapshot:'Aderezo',qty:1,pricing_origin_currency:'USD',pricing_origin_amount:1.5,
  pricing_fx_rate_snapshot:850,unit_price_usd_snapshot:1.5,line_total_usd:1.5,unit_price_bs_snapshot:1275,line_total_bs_snapshot:1275,
  admin_price_override_usd:null,admin_price_override_reason:null,notes:null,crm_play_member_id:null,crm_play_benefit_id:null,crm_play_benefit_upgrade_id:null,...previousFunding};
 const order={id:11,client_id:1,attributed_advisor_id:advisor,status:'queued',last_modified_at:'2026-10-16T12:00:00Z',extra_fields:{pricing:{fx_rate:850}},total_usd:1.5,fulfillment:'pickup'};
 const data={orders:order,order_items:[original],products:[{id:25,name:'Aderezo'}],product_components:[],clients:[{id:1,full_name:'Client'}]};
 const db={from(table){const q={select(columns){selections.push({table,columns});return q;},eq(){return q;},in(){return q;},order(){return q;},maybeSingle:async()=>({data:data[table],error:null}),then(resolve){return Promise.resolve({data:data[table],error:null}).then(resolve);}};return q;},
  async rpc(name,args){calls.push({name,args});return {data:{last_modified_at:'2026-10-16T13:00:00Z'},error:rpcError};}};
 const actions=compile('../../src/app/app/advisor/new/actions.ts',{
  'next/cache':{revalidatePath:path=>invalidations.push(path)},
  '@/lib/rewards/revalidate-wallet':{revalidateRewardWallet:()=>invalidations.push('wallet')},
  '@/lib/rewards/order-funding':funding,
  '@supabase/supabase-js':{createClient:()=>db},'@/lib/auth':{requireAuthContext:async()=>({user:{id:actor},supabase:db})},
  '@/lib/domain/order-domain':{canAdvisorModifyOrder:status=>['created','queued'].includes(status)},
  '@/lib/crm/advisor-order-context':{},'@/lib/crm/catalog-gift':{},'@/lib/events/event-budget':{},
  '@/lib/orders/order-change-detail':details,'@/lib/orders/order-labels':{},
  '@/lib/orders/order-detail-persistence':{normalizeOrderDetailForSave:(_product,_qty,lines)=>lines},
  '@/lib/orders/approved-price-preservation':approvals,'@/lib/orders/operational-edit-pricing':operational,'@/lib/push':{},
 });
 const input={orderId:11,expectedLastModifiedAt:order.last_modified_at,payload:{client_id:1,attributed_advisor_id:advisor,source:'advisor',status:'created',fulfillment:'pickup',extra_fields:{pricing:{fx_rate:850}},total_usd:0,total_bs_snapshot:0},
  items:[{orderItemId:7,productId:25,qty:1,sourcePriceCurrency:'USD',sourcePriceAmount:1.5,unitPriceUsdSnapshot:0,lineTotalUsd:0,unitPriceBsSnapshot:0,lineTotalBsSnapshot:0,productNameSnapshot:'Aderezo',editableDetailLines:[],crmPlayMemberId:null,crmPlayBenefitId:null,crmPlayBenefitUpgradeId:null,
   rewardGrantId:1,rewardPurpose:'customer_gift',rewardAmountUsd:1.5}]};
 return {actions,input,calls,selections,invalidations};
}

test('actual advisor edit action keeps selected credit/net price instead of restoring the original charge',async()=>{
 const f=fixture();const result=await f.actions.replaceAdvisorOrderItemsAction(f.input);
 assert.equal(result.ok,true,result.message);assert.equal(f.calls[0].name,'update_order_core_atomic_v1');
 const item=f.calls[0].args.p_items[0];assert.equal(item.order_item_id,7);assert.equal(item.line_total_usd,0);assert.equal(item.line_total_bs_snapshot,0);
 assert.equal(item.reward_grant_id,1);assert.equal(item.reward_amount_usd,1.5);
 assert.ok(f.selections.some(s=>s.table==='order_items'&&s.columns.includes('reward_grant_id')));assert.ok(f.invalidations.includes('wallet'));
});
test('actual action does not reinstate a former discount when removing or changing its funding',async()=>{
 const previous={reward_grant_id:1,reward_purpose:'customer_gift',reward_amount_usd:1.5,unit_price_usd_snapshot:0,line_total_usd:0,unit_price_bs_snapshot:0,line_total_bs_snapshot:0};
 for(const remove of [false,true]){
  const f=fixture(previous);const item=f.input.items[0];
  Object.assign(item,remove?{rewardGrantId:null,rewardPurpose:null,rewardAmountUsd:null,unitPriceUsdSnapshot:1.5,lineTotalUsd:1.5,unitPriceBsSnapshot:1275,lineTotalBsSnapshot:1275}
   :{rewardAmountUsd:0.5,unitPriceUsdSnapshot:1,lineTotalUsd:1,unitPriceBsSnapshot:850,lineTotalBsSnapshot:850});
  const r=await f.actions.replaceAdvisorOrderItemsAction(f.input);assert.equal(r.ok,true,r.message);
  assert.equal(f.calls[0].args.p_items[0].line_total_usd,remove?1.5:1);
 }
});
test('ordinary historical prices are still protected; failed or unauthorized edits never report success',async()=>{
 const ordinary=fixture();Object.assign(ordinary.input.items[0],{rewardGrantId:null,rewardPurpose:null,rewardAmountUsd:null});
 assert.equal((await ordinary.actions.replaceAdvisorOrderItemsAction(ordinary.input)).ok,true);
 assert.equal(ordinary.calls[0].args.p_items[0].line_total_usd,1.5);
 const failed=fixture({}, {message:'No se pudo conservar el premio y su reserva.'});
 assert.equal((await failed.actions.replaceAdvisorOrderItemsAction(failed.input)).ok,false);assert.equal(failed.invalidations.length,0);
 const denied=fixture({},null,'00000000-0000-0000-0000-000000000003');
 assert.equal((await denied.actions.replaceAdvisorOrderItemsAction(denied.input)).ok,false);assert.equal(denied.calls.length,0);
});
