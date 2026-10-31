import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const preview=require('../../src/lib/payments/payment-entry.ts').paymentEntryPreview;
const source=read('src/components/orders/OrderPaymentEntry.tsx');

function driver({rates=[888.9,888.12],currency='VES',snapshot=false,remote}={}) {
  const slots=[],effects=[];let cursor=0,ready=false;const calls=[];
  const hooks={useId:()=> 'entry',useState(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;
    return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef(v){const i=cursor++;return slots[i]??(slots[i]={current:v});},
    useCallback(f,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j]))slots[i]={f,deps};return slots[i].f;},
    useEffect(f,deps){const i=cursor++;const old=slots[i];if(!deps||!old||deps.some((v,j)=>v!==old.deps[j])){
      slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=f();});}}};
  const module={exports:{}};
  new Function('require','exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>{
    if(id==='react')return hooks;if(id==='react/jsx-runtime')return require(id);
    if(id.endsWith('payment-entry'))return require('../../src/lib/payments/payment-entry.ts');
    if(id.endsWith('day-quote-actions'))return {loadOrderPaymentDayQuoteAction:async input=>{
      calls.push(input);if(remote)return remote(input);
      const rate=input.exchangeRate??rates[0];return {operationDate:input.operationDate,pendingUsd:snapshot?2.68:45,
        pendingBs:snapshot?2300:Number((45*rate).toFixed(2)),exchangeRate:rate,snapshotRate:888.12,
        collectionMode:snapshot?'snapshot_quote':'native_usd',dayRates:rates};}};
    throw Error(id);
  },module.exports,module);
  const props={orderId:3628,currency,value:{operationDate:'2026-10-28',exchangeRate:'',amount:''},
    onChange:value=>{props.value=value;},onReadyChange:value=>{ready=value;}};
  const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
  const render=()=>{cursor=0;return nodes(module.exports.default(props));};
  const find=p=>render().find(p);
  const flush=async()=>{for(let i=0;i<5;i++){render();for(const f of effects.splice(0))f();await new Promise(resolve=>setImmediate(resolve));}};
  const select=async rate=>{find(n=>n.type==='select').props.onChange({target:{value:String(rate)}});await flush();};
  const amount=async value=>{find(n=>n.type==='input'&&n.props.inputMode==='decimal').props.onChange({target:{value}});await flush();};
  return {props,find,flush,select,amount,calls,ready:()=>ready};
}

test('multiple daily rates require explicit selection; partial amount survives rate changes and never triggers a payment',async()=>{
  const ui=driver();await ui.flush();assert.equal(ui.props.value.exchangeRate,'');assert.equal(ui.ready(),false);
  assert.equal(ui.find(n=>n.type==='input'&&n.props.inputMode==='decimal').props.disabled,true);
  await ui.select(888.12);assert.equal(ui.props.value.amount,'39965.4');assert.equal(ui.ready(),true);
  await ui.amount('37301,04');const callCount=ui.calls.length;assert.equal(callCount,2,'no query per amount keystroke');
  await ui.select(888.9);assert.equal(ui.props.value.amount,'37301,04','keep deliberate partial amount');
  assert.equal(ui.props.value.exchangeRate,'888.9');assert.equal(ui.ready(),true);
  ui.find(n=>n.type==='button'&&n.props.children==='Completar saldo').props.onClick();await ui.flush();
  assert.equal(ui.props.value.amount,'40000.5');assert.equal(ui.calls.length,3);
});

test('one daily rate is automatic, USD has no rate selector, and legacy Bs keeps its native quote',async()=>{
  const one=driver({rates:[888.12]});await one.flush();assert.equal(one.props.value.exchangeRate,'888.12');assert.equal(one.ready(),true);
  const usd=driver({currency:'USD'});await usd.flush();assert.ok(!usd.find(n=>n.type==='select'));assert.equal(usd.props.value.amount,'45');
  await usd.amount('20');assert.equal(usd.ready(),true);
  const legacy=driver({snapshot:true});await legacy.flush();await legacy.select(888.12);
  assert.equal(legacy.props.value.amount,'2300','never round-trip a native Bs amount through displayed USD');
});

test('changing the operation date clears selection and money; failure stays blocked and retry is read-only',async()=>{
  let fail=false;const ui=driver({remote:async input=>{if(fail)throw Error('offline');return {operationDate:input.operationDate,
    pendingUsd:45,pendingBs:39965.4,exchangeRate:input.exchangeRate??888.9,snapshotRate:888.12,collectionMode:'native_usd',dayRates:[888.9,888.12]};}});
  await ui.flush();await ui.select(888.12);fail=true;
  ui.find(n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'2026-10-27'}});await ui.flush();
  assert.equal(ui.props.value.amount,'');assert.equal(ui.props.value.exchangeRate,'');assert.equal(ui.ready(),false);
  assert.ok(ui.find(n=>n.props?.role==='alert'));fail=false;
  ui.find(n=>n.type==='button'&&n.props.children==='Reintentar').props.onClick();await ui.flush();
  assert.equal(ui.ready(),false,'must select a rate in the new date');
});

test('shared previews distinguish 42 vs 41.96 and retain three dollars for the salsa',()=>{
  const q={operationDate:'2026-10-28',pendingUsd:45,pendingBs:39965.4,exchangeRate:888.12,snapshotRate:888.12,collectionMode:'native_usd',dayRates:[888.9,888.12]};
  assert.equal(preview(q,'VES','37301,04').appliedUsd,42);assert.equal(preview(q,'VES','37301,04').pendingUsd,3);
  assert.equal(Number(preview({...q,exchangeRate:888.9,pendingBs:40000.5},'VES','37301,04').pendingUsd.toFixed(2)),3.04);
  assert.equal(preview(q,'USD','20').pendingUsd,25);assert.equal(preview(q,'VES','37.301,04'),null);
});

test('a late response from another operation date cannot replace the selected day or unblock registration',async()=>{
  const pending=[];
  const ui=driver({remote:input=>new Promise(resolve=>pending.push({input,resolve}))});
  await ui.flush();assert.equal(pending.length,1);
  ui.find(n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'2026-10-27'}});
  await ui.flush();assert.equal(pending.length,2);
  const result=(date,rate)=>({operationDate:date,pendingUsd:45,pendingBs:45*rate,exchangeRate:rate,
    snapshotRate:888.12,collectionMode:'native_usd',dayRates:[rate]});
  pending[1].resolve(result('2026-10-27',800));await ui.flush();
  assert.equal(ui.props.value.operationDate,'2026-10-27');assert.equal(ui.props.value.exchangeRate,'800');assert.equal(ui.ready(),true);
  pending[0].resolve(result('2026-10-28',888.12));await ui.flush();
  assert.equal(ui.props.value.operationDate,'2026-10-27');assert.equal(ui.props.value.exchangeRate,'800');
  assert.equal(ui.props.value.amount,'36000');assert.equal(ui.ready(),true);
});

test('all customer payment entry points use the one component and the dated canonical writer',()=>{
  for(const p of ['src/app/app/counter/CounterPaymentEngine.tsx','src/app/app/advisor/orders/[id]/OrderDetailActions.tsx',
    'src/components/orders/OrdersWorkspaceClient.tsx','src/app/app/master/dashboard/MasterDashboardClient.tsx']) {
    const s=read(p);assert.match(s,/<OrderPaymentEntry/);assert.doesNotMatch(s,/value=\{(?:paymentReportAmount|amount|paymentDraft\.amount)\}/);
  }
  for(const p of ['src/app/app/master/dashboard/actions.ts','src/app/app/advisor/orders/[id]/actions.ts']){
    const s=read(p);assert.match(s,/rpc\('create_payment_report_on_date_v1'/);assert.doesNotMatch(s,/rpc\('create_payment_report'|reportedAmount \/ snapshotEquivalentUsd|savePaymentReportOperationDate/);
  }
  assert.doesNotMatch(source,/setInterval|money_movements|create_payment_report|confirm_payment/);
});
