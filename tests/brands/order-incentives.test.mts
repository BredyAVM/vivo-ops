import test from'node:test';import assert from'node:assert/strict';
import{applyMuerdemeIncentives,isMuerdemeCommissionLine,readMuerdemeIncentiveSnapshot,type MuerdemeIncentive}from'../../src/lib/brands/order-incentives.ts';
const receipt=(id=1,amountUsd=0.3):MuerdemeIncentive=>({orderId:id,orderNumber:String(3600+id),advisorId:'advisor',policyRevision:1,purchaseKind:id===1?'first':'recurrent',amountUsd,status:'ready',deliveryDate:'2026-10-29'});
const closure=()=>({advisor_user_id:'advisor',gross_commission_usd:8,payable_usd:6,snapshot:{totals:{grossCommissionUsd:8,payableUsd:6},orders:[{orderId:1,commissionUsd:8}]}});
test('VIVO-only snapshots preserve their exact values, references and historical formula',()=>{const c=closure();assert.equal(applyMuerdemeIncentives([c],[])[0],c);assert.equal(isMuerdemeCommissionLine({notes:'25 Mini Tequeños'}),false);assert.equal(readMuerdemeIncentiveSnapshot(c.snapshot).totalUsd,0);});
test('one or one hundred burgers and extras yield one fixed amount for the order',()=>{
 for(const pieces of[1,2,100]){const c={...closure(),pieces};const result=applyMuerdemeIncentives([c],[receipt()])[0];assert.equal(result.gross_commission_usd,8.3);assert.equal(result.payable_usd,6.3);assert.equal(readMuerdemeIncentiveSnapshot(result.snapshot).totalUsd,0.3);}
});
test('first/recurrent configured USD amounts add once and repeated calculations replace the previous incentive',()=>{
 const rows=[receipt(),receipt(2,0.2)];const a=applyMuerdemeIncentives([closure()],rows)[0];assert.equal(a.gross_commission_usd,8.5);assert.deepEqual(applyMuerdemeIncentives([a],rows)[0],a);
 assert.equal(applyMuerdemeIncentives([a],[])[0].gross_commission_usd,8);assert.equal(applyMuerdemeIncentives([closure()],[{...receipt(),amountUsd:0.75}])[0].gross_commission_usd,8.75);
});
test('incentives never cross advisors, duplicate an order or accept an unverified pending amount',()=>{
 assert.equal(applyMuerdemeIncentives([{...closure(),advisor_user_id:'another'}],[receipt()])[0].gross_commission_usd,8);
 assert.throws(()=>applyMuerdemeIncentives([closure()],[receipt(),receipt()]),/inválido/);
 assert.throws(()=>applyMuerdemeIncentives([closure()],[{...receipt(),status:'unpaid'}as unknown as MuerdemeIncentive]),/inválido/);
});
test('Muérdeme physical product lines are excluded from percentages even if legacy order terms override the whole order',()=>{
 assert.equal(isMuerdemeCommissionLine({notes:'@muerdeme|{}'}),true);
 assert.equal(isMuerdemeCommissionLine({product:{extra_fields:{commercial_brand:'muerdeme'}}}),true);
 assert.equal(isMuerdemeCommissionLine({product:{extra_fields:{commercial_brand:'vivo'}}}),false);
});
