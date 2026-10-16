import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const composer = read('src/app/app/advisor/new/AdvisorOrderComposer.tsx');
const ast = ts.createSourceFile('composer.tsx',composer,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const helper = read('src/lib/crm/order-benefit-preservation.ts').replace(/^import type .*;$/gm,'').replaceAll('export ','');
const prices = read('src/lib/pricing/order-snapshots.ts').replaceAll('export ','');
const details = read('src/lib/orders/order-detail-persistence.ts').replaceAll('export ','');
const functionNames = new Set(['normalizeDraftItemsPayload','getProductSourcePricing','buildRepeatedDraftItemFromCatalog','toSafeNumber']);
const functions = ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&functionNames.has(s.name?.text)).map(s=>s.getText(ast)).join('\n');
function declaration(name, requiredText) {
  let found;
  function visit(node) {
    if(ts.isVariableDeclaration(node) && node.name.getText(ast)===name && node.initializer?.getText(ast).includes(requiredText)) found=node.initializer.getText(ast);
    ts.forEachChild(node,visit);
  }
  visit(ast); assert.ok(found,name); return found;
}
const rehydrate = declaration('orderItems','existingOrderItems.map');
const effective = declaration('effectiveDraftPricing','draftItems.map');
const drift = declaration('catalogPriceDriftItems','draftItems.filter');
function runtime(values={}) {
  const context=vm.createContext({console,...values});
  const js=ts.transpileModule(prices+'\n'+details+'\n'+helper+'\n'+functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInContext(js,context); return context;
}
const json=value=>JSON.parse(JSON.stringify(value));
const crm = {playMemberId:999,playBenefitId:39,playBenefitUpgradeId:null,eligibleUnitPriceUsd:0,catalogSourceCurrency:'VES',catalogSourceAmount:3200};
const item = {localId:'saved-gift',product_id:61,qty:1,source_price_currency:'USD',source_price_amount:0,unit_price_usd_snapshot:0,line_total_usd:0,
  editable_detail_lines:['2 Mini Tequeños Fritos','@sel|8|2'],crm_benefit:crm};
const authorized = {playMemberId:999,client:{id:894},benefits:[{playBenefitId:39,productId:61,quantity:1,upgrades:[{id:70,productId:62,quantity:1,customerDifferenceUsd:2}]}]};

test('actual draft normalizer preserves gift identity, zero price and internal composition',()=>{
  const ctx=runtime(); const restored=ctx.normalizeDraftItemsPayload([item])[0];
  assert.deepEqual(json(restored.crm_benefit),crm);
  assert.deepEqual(json(restored.editable_detail_lines),item.editable_detail_lines);
  assert.equal(restored.line_total_usd,0);
  assert.equal(ctx.savedDraftCrmMemberId([item]),999);
  assert.equal(ctx.savedDraftCrmMemberId([{...item,crm_benefit:undefined}]),null);
  assert.equal(ctx.normalizeDraftItemsPayload([{...item,crm_benefit:undefined}])[0].crm_benefit,undefined,'ordinary products stay ordinary');
});
test('fresh authorized context restores upgrade difference, never a forged draft price or another membership',()=>{
  const ctx=runtime();
  const upgrade={...item,product_id:62,crm_benefit:{...crm,playBenefitUpgradeId:70,eligibleUnitPriceUsd:0}};
  assert.equal(ctx.restoreDraftCrmItems([upgrade],authorized)[0].crm_benefit.eligibleUnitPriceUsd,2);
  for(const bad of [null,{...authorized,playMemberId:1000},{...authorized,benefits:[]}]) assert.throws(()=>ctx.restoreDraftCrmItems([item],bad),/vínculo/);
  for(const bad of [{...item,qty:2},{...item,product_id:100},{...upgrade,crm_benefit:{...upgrade.crm_benefit,playBenefitUpgradeId:100}}]) assert.throws(()=>ctx.restoreDraftCrmItems([bad],authorized),/vínculo/);
  for(const bad of [{...crm,playBenefitId:0},{...crm,playMemberId:NaN},{...crm,eligibleUnitPriceUsd:-1},{...crm,catalogSourceCurrency:'BAD'}]) assert.throws(()=>ctx.readDraftCrmBenefit(bad),/vínculo/);
  assert.equal(ctx.readDraftCrmBenefit({...crm,redemptionStatus:'redeemed'}).redemptionStatus,undefined);
  assert.throws(()=>ctx.savedDraftCrmMemberId([item,{...item,crm_benefit:{...crm,playMemberId:1001}}]),/vínculo/);
});
function editedItems({repeat=false,recalculate=true,upgrade=false}={}) {
  const products=[{id:61,name:'Single Pack (6 und)',type:'product',source_price_currency:'VES',source_price_amount:3200,base_price_usd:4},
    {id:62,name:'Single Pack (8 und)',type:'product',source_price_currency:'VES',source_price_amount:4800,base_price_usd:6},
    {id:15,name:'Mandocas Pre-Fritas',type:'product',source_price_currency:'USD',source_price_amount:14,base_price_usd:14}];
  const rows=[{id:14858,product_id:upgrade?62:61,qty:1,unit_price_usd_snapshot:upgrade?2:0,line_total_usd:upgrade?2:0,pricing_origin_currency:'USD',pricing_origin_amount:upgrade?2:0,
    crm_play_member_id:999,crm_play_benefit_id:39,crm_play_benefit_upgrade_id:upgrade?70:null,notes:'2 Mini Tequeños Fritos\n@sel|8|2'},
    {id:14857,product_id:15,qty:3,unit_price_usd_snapshot:12,line_total_usd:36,pricing_origin_currency:'USD',pricing_origin_amount:12}];
  const ctx=runtime({existingOrderItems:rows,activeProductById:new Map(products.map(p=>[p.id,p])),isRepeatingOrder:repeat,recalculationRequested:recalculate,
    redemptionStatusByOrderItemId:new Map([[14858,'reserved']]),skippedRepeatItems:[],editFxRate:1000});
  vm.runInContext(ts.transpileModule('var restored='+rehydrate,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  return json(ctx.restored);
}
test('actual edit/recalculation loader retains the exact gift line and updates only normal catalog items',()=>{
  for(const recalculate of [true,false]) for(const upgrade of [true,false]) {
    const rows=editedItems({recalculate,upgrade});
    assert.equal(rows[0].persistedOrderItemId,14858);
    assert.equal(rows[0].crm_benefit.playMemberId,999);
    assert.equal(rows[0].crm_benefit.playBenefitUpgradeId,upgrade?70:null);
    assert.equal(rows[0].crm_benefit.redemptionStatus,'reserved');
    assert.equal(rows[0].line_total_usd,upgrade?2:0);
    assert.deepEqual(rows[0].editable_detail_lines,['2 Mini Tequeños Fritos','@sel|8|2']);
    assert.equal(rows[1].line_total_usd,recalculate?42:36);
  }
});
test('repeat remains a new order and cannot duplicate a prior CRM entitlement',()=>{
  const rows=editedItems({repeat:true});
  assert.equal(rows[0].crm_benefit,undefined);
  assert.equal(rows[0].persistedOrderItemId,undefined);
  assert.equal(rows[0].line_total_usd,3.2);
});
test('actual price calculation never recharges a restored gift; unmet minimum still blocks submission',()=>{
  for(const saved of [true,false]) {
    const ctx=runtime({useMemo:fn=>fn(),draftItems:[item],crmPurchaseEligible:false,isEditingOrder:!saved,activeDraftId:saved?7:null});
    if(!saved) ctx.draftItems=[{...item,persistedOrderItemId:14858}];
    vm.runInContext(ts.transpileModule('var effective='+effective,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
    assert.deepEqual(json(ctx.effective),[{sourceCurrency:'USD',sourceAmount:0}]);
  }
  const ctx=runtime({useMemo:fn=>fn(),draftItems:[item],isEditingOrder:true,advisorRecalculationMode:true,fxRateNumber:1000,existingOrderStatus:'created',productById:new Map([[61,{}]])});
  vm.runInContext(ts.transpileModule('var drift='+drift,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  assert.equal(ctx.drift.length,0);
  const submit=composer.slice(composer.indexOf('async function handleSubmit'));
  assert.match(submit,/restoreDraftCrmItems\(restoredGifts, crmContext\)/);
  assert.match(submit,/if \(!crmPurchaseEligible\)\s*\{\s*setError\('El borrador conserva el obsequio/);
  assert.match(submit,/prepareAdvisorCrmPlayBenefitsAction/);
  assert.match(submit,/crmPlayMemberId: item\.crm_benefit/);
  const manual=composer.slice(composer.indexOf('function handleRecalculateDraftPricesFromCatalog'),composer.indexOf('function handleRecalculateDraftPricesFromCatalog')+1800);
  assert.match(manual,/if \(item.crm_benefit\) return item/);
});
test('draft route resolves the saved membership under the actual advisor session, not a cached client-side context',()=>{
  const page=read('src/app/app/advisor/new/page.tsx');
  assert.match(page,/eq\('advisor_user_id', ctx.user.id\)/);
  assert.match(page,/savedDraftCrmMemberId\(data.payload\?\.items\)/);
  assert.match(page,/clientId: Number\(data.client_id\), playMemberId: memberId/);
  assert.match(page,/advisorUserId: ctx.user.id/);
  assert.doesNotMatch(page,/service_role|createSupabaseServiceRole/);
});
