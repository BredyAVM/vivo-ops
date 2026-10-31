import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../../src/app/app/counter/CounterPaymentEngine.tsx',import.meta.url),'utf8');

function cashier() {
  const slots=[], pending=[];let cursor=0;const calls=[];
  const hooks={useState(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},
    useMemo:f=>f(),useRef(v){const i=cursor++;return slots[i]??(slots[i]={current:v});},useTransition(){return[false,f=>pending.push(f())];}};
  const module={exports:{}};
  const review=Object.defineProperty(function(){},'name',{value:'AmountReview'});
  new Function('require','exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>{
    if(id==='react')return hooks;
    if(id==='react/jsx-runtime')return require(id);
    if(id.endsWith('OrderPaymentEntry'))return {default:Object.defineProperty(function(){},'name',{value:'PaymentEntry'})};
    if(id.endsWith('order-labels'))return {getPaymentMethodLabel:m=>m};
    if(id.endsWith('payment-entry'))return require('../../src/lib/payments/payment-entry.ts');
    if(id.endsWith('rate-review'))return {withRateReviewRequest:n=>n};
    if(id==='./CounterAmountReview')return {CounterAmountReview:review};
    if(id==='./amount-review')return require('../../src/app/app/counter/amount-review.ts');
    if(id.endsWith('payment-report-rules'))return require('../../src/lib/payments/payment-report-rules.ts');
    throw new Error(id);
  },module.exports,module);
  const quote={operationDate:'2026-10-30',pendingUsd:14,pendingBs:12454.12,exchangeRate:889.58,snapshotRate:889.26,dayRates:[889.58,889.26],collectionMode:'native_usd'};
  const props={order:{id:3686,clientName:'Prueba',paymentMethod:'pos',changeAvailableUsd:0,paymentQuote:quote},
    paymentAccounts:[{accountId:11,accountName:'BDV 2',accountKind:'pos',currencyCode:'VES',paymentMethodCode:'pos',canReportPayment:true,canConfirmPayment:true,autoConfirmsReport:true,reviewRequired:false}],
    isWorking:false,onFinish(){},onSubmit:async()=>{throw new Error('No real payments in this test');},
    onLoadPaymentQuote:async input=>{calls.push(input);if(input.operationDate==='2026-10-29')throw new Error('Sin conexión');
      return {...quote,operationDate:input.operationDate,exchangeRate:input.exchangeRate??889.58,pendingBs:input.exchangeRate===889.26?12449.64:12454.12};}};
  const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
  const render=()=>{cursor=0;return nodes(module.exports.CounterPaymentEngine(props));};
  const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):'';
  const find=p=>render().find(p);
  const click=label=>{const b=find(n=>n.type==='button'&&text(n)===label);assert.ok(b,label);b.props.onClick();};
  return {find,click,calls,flush:async()=>{await Promise.all(pending.splice(0));}};
}

test('Counter forwards the shared payment entry and keeps explicit confirmation and POS reference',async()=>{
  const ui=cashier();
  const entry=ui.find(n=>n.type?.name==='PaymentEntry');
  assert.ok(entry);entry.props.onChange({operationDate:'2026-10-30',exchangeRate:'889.26',amount:'12449.64'});
  entry.props.onQuoteChange({operationDate:'2026-10-30',exchangeRate:889.26,pendingUsd:14,pendingBs:12449.64,snapshotRate:889.26,collectionMode:'native_usd',dayRates:[889.58,889.26]});
  entry.props.onReadyChange(true);
  ui.find(n=>n.type==='input'&&n.props.maxLength===4).props.onChange({target:{value:'1372'}});
  ui.click('Revisar este pago');const review=ui.find(n=>n.type?.name==='AmountReview');
  assert.equal(review.props.immediate,true);assert.equal(review.props.amount,12449.64);
  assert.equal(review.props.operationDate,'2026-10-30');assert.equal(review.props.exchangeRate,889.26);
});

test('Counter cannot submit while the shared entry has no certified date/rate',async()=>{
  const ui=cashier();
  ui.find(n=>n.type==='input'&&n.props.maxLength===4).props.onChange({target:{value:'1372'}});
  const entry=ui.find(n=>n.type?.name==='PaymentEntry');
  entry.props.onChange({operationDate:'2026-10-29',exchangeRate:'',amount:''});entry.props.onReadyChange(false);
  ui.click('Revisar este pago');assert.ok(!ui.find(n=>n.type?.name==='AmountReview'));
});
