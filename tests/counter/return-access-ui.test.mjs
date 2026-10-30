import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../../src/app/app/counter/CounterOrderWorkspace.tsx',import.meta.url),'utf8');
function driver(fulfillment='delivery',status='delivered',initialPaymentOpen=false) {
  const slots=[]; let cursor=0; let writes=0;
  const hooks={useState(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],v=>slots[i]=v];},useEffect(){},useMemo:f=>f(),useRef:v=>({current:v})};
  const module={exports:{}};
  const stub=name=>Object.defineProperty(function(){},'name',{value:name});
  new Function('require','exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>{
    if(id==='react')return hooks;
    if(id==='react/jsx-runtime')return require(id);
    if(id==='./delivery-contract')return {requiresCounterDeliveryMoneyHandling:()=>true};
    if(id.includes('order-labels'))return {getOperationalStatusLabel:()=>status,getPaymentMethodLabel:()=> 'Efectivo'};
    if(id==='./CounterPaymentEngine')return {CounterPaymentEngine:stub('CounterPaymentEngine')};
    if(id==='./CounterDeliveryWorkspace')return {CounterDeliverySettlementBox:stub('CounterDeliverySettlementBox'),CounterDeliveryDispatchPanel:stub('CounterDeliveryDispatchPanel')};
    return {};
  },module.exports,module);
  const props={order:{id:3677,displayNumber:'3677',clientName:'Cliente',fulfillment,status,balanceUsd:30.5,totalUsd:30.5,totalBs:27122.43,confirmedPaidUsd:0,reports:{pending:0},pickupChangeRequests:[],refundAuthorizations:[],items:[],hasAdvisor:true,paymentMethod:'cash_usd',pendingDigitalChangeUsd:0,changeAvailableUsd:0,overpaidUsd:0},initialPaymentOpen,paymentAccounts:[],quickSaleProducts:[],quickSaleProductComponents:[],activeBsRate:889.26,onPaymentSessionOpened(){},onPaymentSessionFinished(){},onPrimaryDeliveryAction(){writes++;},onCreatePaymentReport(){writes++;},onDeliverySettlementChanged(){}};
  const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
  const render=()=>{cursor=0;return nodes(module.exports.OrderDetail(props));};
  const find=p=>render().find(p);
  const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):'';
  const click=label=>{const b=find(n=>n.type==='button'&&text(n)===label);assert.ok(b,label);assert.ok(!b.props.disabled);b.props.onClick();};
  return {find,click,writes:()=>writes};
}
test('delivered and in-transit orders open exact return, not new payment',()=>{
  for(const status of ['delivered','out_for_delivery']) {
    const ui=driver('delivery',status);
    assert.ok(!ui.find(n=>n.type?.name==='CounterDeliverySettlementBox'));
    ui.click('Recibir dinero del motorizado');
    assert.equal(ui.find(n=>n.type?.name==='CounterDeliverySettlementBox').props.orderId,3677);
    assert.ok(!ui.find(n=>n.type?.name==='CounterPaymentEngine'));
    assert.equal(ui.writes(),0);
  }
});
test('auto-open from search cannot bypass explicit source choice',()=>{
  const ui=driver('delivery','delivered',true);
  assert.ok(!ui.find(n=>n.type?.name==='CounterPaymentEngine'));
  ui.click('Registrar un pago nuevo del clienteSolo dinero adicional que paga el cliente. No uses esta opción para el retorno del motorizado.');
  assert.ok(ui.find(n=>n.type?.name==='CounterPaymentEngine'));
  ui.click('Volver a elegir operación');
  ui.click('Recibir dinero del motorizadoRevisar el cambio enviado y registrar su retorno en la liquidación.');
  assert.ok(ui.find(n=>n.type?.name==='CounterDeliverySettlementBox'));
  assert.equal(ui.writes(),0);
});
test('pickup keeps ordinary checkout and cancelled orders cannot collect',()=>{
  const ui=driver('pickup','delivered',true);
  assert.ok(ui.find(n=>n.type?.name==='CounterPaymentEngine'));
  const cancelled=driver('delivery','cancelled',true);
  assert.ok(!cancelled.find(n=>n.type?.name==='CounterPaymentEngine'));
  assert.ok(!cancelled.find(n=>n.type?.name==='CounterDeliverySettlementBox'));
});
