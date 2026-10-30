import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import ts from'typescript';
import{getOrderMoneySnapshot,getOrderLineTotalUsd,getOrderCommercialNetUsd,getOrderRoundingClosureSnapshot}from'../../src/lib/orders/order-money.ts';
import{isAdvisorCommercialOrder,countedAdvisorNewClientType}from'../../src/lib/commissions/commercial-criteria.ts';
import{resolveProductCommissionTerms}from'../../src/lib/commissions/product-commission-policy.ts';
import{isMuerdemeCommissionLine,applyMuerdemeIncentives}from'../../src/lib/brands/order-incentives.ts';
const source=readFileSync('src/app/app/master/dashboard/actions.ts','utf8'),ast=ts.createSourceFile('actions.ts',source,ts.ScriptTarget.Latest,true);
const names=['toSafeNumber','roundMoney','getEffectiveOrderPendingUsd','normalizeDateOnly','getCaracasDateString','dateOnlyFromIso','getOrderDeliveryReferenceDate','getAdvisorCommissionClient','getAdvisorCommissionProduct','getAdvisorCommissionItemTerms','getAdvisorGiftCostUsd','getAdvisorCommissionDeliveryDate','getAdvisorCommissionDiscountFactor'];
const functions=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n=>[n.name?.text,n.getText(ast)]));
const deps={getOrderMoneySnapshot,getOrderLineTotalUsd,getOrderCommercialNetUsd,getOrderRoundingClosureSnapshot,isAdvisorCommercialOrder,countedAdvisorNewClientType,resolveProductCommissionTerms,isMuerdemeCommissionLine};
const load=(builder:string)=>new Function(...Object.keys(deps),ts.transpileModule(names.map(n=>functions.get(n)).join('\n')+'\nconst ADVISOR_COMMISSION_CLIENT_IMPORT_CUTOFF="2026-06-02";\n'+builder+'\nreturn buildAdvisorCommissionSnapshots;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(...Object.values(deps));
const current=load(functions.get('buildAdvisorCommissionSnapshots')!),baseline=load(readFileSync('tests/brands/fixtures/vivo-commission-builder-baseline.ts.txt','utf8'));
const item=(id:number,amount:number,mode='default',value:number|null=null,mu=false)=>({id,product_id:id,qty:1,line_total_usd:amount,unit_price_usd_snapshot:amount,notes:null,product_name_snapshot:mu?'Muérdeme':'VIVO',product:{id,name:mu?'Muérdeme':'VIVO',type:'product',commission_mode:mode,commission_value:value,extra_fields:mu?{commercial_brand:'muerdeme'}:{}}});
const input=(items:ReturnType<typeof item>[],discount=0)=>{const raw=items.reduce((s,i)=>s+i.line_total_usd,0),total=raw*(1-discount/100);return{orders:[{id:1,order_number:'3600',attributed_advisor_id:'advisor',source:'advisor',status:'delivered',total_usd:total,created_at:'2026-10-29T10:00:00Z',extra_fields:{pricing:{subtotal_usd:raw,subtotal_after_discount_usd:total,total_usd:total},schedule:{date:'2026-10-29'}},client:{id:1,full_name:'Cliente',client_type:'own',created_at:'2026-01-01'},items}],
 financialStates:new Map([[1,{total_usd:total,confirmed_paid_usd:total,pending_usd:0,delivery_reference_date:'2026-10-29',payment_status:'paid'}]]),paymentCompletionDates:new Map(),firstPurchaseOrdersByClientId:new Map(),advisorIds:['advisor'],advisorNamesById:new Map([['advisor','Asesor']]),period:{id:1,name:'Semana',date_from:'2026-10-26',date_to:'2026-11-01'},defaultBaseCommissionPct:8,baseCommissionPctByAdvisor:new Map(),commissionTermsByOrderItemId:new Map(),giftOverridesByOrderItemId:new Map()};};
test('the actual VIVO-only commission builder matches its saved pre-integration results',()=>{
 for(const discount of[0,10,33.33])for(const rows of[[item(1,100)],[item(1,100,'fixed_item',5)],[item(1,100,'fixed_order',5),item(2,20)],[item(1,100),item(2,5,'none')],[]]){
  const next=current(input(rows,discount)),old=baseline(input(rows,discount));next[0].snapshot.generated_at='';old[0].snapshot.generated_at='';assert.deepEqual(next,old);
 }
});
test('mixed orders preserve VIVO percentages and fries/burgers never inherit a whole-order override',()=>{
 for(const pieces of[1,100]){
  const data=input([item(1,100),item(2,5*pieces,'fixed_item',100,true),item(3,2,'fixed_item',100,true)]);
  assert.equal(current(data)[0].gross_commission_usd,8);data.commissionTermsByOrderItemId.set(1,{mode:'fixed_order',value:5});assert.equal(current(data)[0].gross_commission_usd,5);
 }
 assert.equal(current(input([item(1,2,'default',null,true)]))[0].gross_commission_usd,0);
 assert.equal(current(input([item(1,100),item(2,2,'default',null,true)]))[0].gross_commission_usd,8);
});

test('separately sold VIVO drinks retain 5 percent while the combo contributes one fixed USD amount',()=>{
 const data=input([item(1,100),item(2,2,'fixed_item',5),item(3,1500,'fixed_item',100,true)]);
 const closures=current(data);assert.equal(closures[0].gross_commission_usd,8.1);
 const settled=applyMuerdemeIncentives(closures,[{orderId:1,orderNumber:'3600',advisorId:'advisor',policyRevision:1,purchaseKind:'recurrent',amountUsd:0.8,status:'ready',deliveryDate:'2026-10-29',fixedCombo:{entryId:'00000000-0000-4000-8000-000000000099',revision:1,name:'Combo',amountUsd:0.8}}]);
 assert.equal(settled[0].gross_commission_usd,8.9);assert.equal(settled[0].snapshot.muerdeme_incentives.totalUsd,0.8);
});
