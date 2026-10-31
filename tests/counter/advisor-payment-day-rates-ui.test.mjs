import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../../src/app/app/advisor/orders/[id]/OrderDetailActions.tsx',import.meta.url),'utf8');

test('advisor selects a historical daily rate and reports the exact date/rate without a current-day replacement',async()=>{
  const slots=[],pending=[],effects=[];let cursor=0;const quotes=[],reports=[];
  const hooks={useState(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},
    useRef(v){const i=cursor++;return slots[i]??(slots[i]={current:v});},useMemo:f=>f(),useCallback:f=>f,
    useTransition(){return[false,f=>pending.push(f())];},useEffect(f,deps){const i=cursor++;const old=slots[i];
      // Function identities are stable in React; this tiny driver compares scalar dependencies.
      if(!old||deps.some((v,j)=>typeof v!=='function'&&v!==old.deps[j])){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=f();});}}};
  const module={exports:{}};
  new Function('require','exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>{
    if(id==='react')return hooks;
    if(id==='react/jsx-runtime')return require(id);
    if(id==='next/link')return {default:()=>null};
    if(id==='next/navigation')return {useRouter:()=>({refresh(){}}),useSearchParams:()=>({get:()=>null})};
    if(id.endsWith('supabase/browser'))return {createSupabaseBrowser:()=>({auth:{getUser:async()=>({data:{user:null}})}})};
    if(id.endsWith('OrderPaymentQuoteButton'))return {default:()=>null};
    if(id.endsWith('order-labels'))return {getPaymentMethodLabel:m=>m};
    if(id.endsWith('number-input'))return {parseDecimalInput:v=>Number(String(v).replace(',','.'))};
    if(id.endsWith('advisor-navigation'))return {withAdvisorReturnTo:v=>v};
    if(id.endsWith('collection-policy'))return require('../../src/lib/orders/collection-policy.ts');
    if(id.endsWith('rate-review'))return require('../../src/lib/payments/rate-review.ts');
    if(id.endsWith('payment-report-rules'))return require('../../src/lib/payments/payment-report-rules.ts');
    if(id.endsWith('day-quote-actions'))return {loadOrderPaymentDayQuoteAction:async input=>{quotes.push(input);const fx=input.exchangeRate??1000;
      return {operationDate:input.operationDate,pendingUsd:14,pendingBs:14*fx,exchangeRate:fx,dayRates:[1000,900,800],collectionMode:'native_usd'};}};
    if(id==='./actions')return {createAdvisorPaymentReportAction:async input=>{reports.push(input);return {ok:true};}};
    throw new Error(id);
  },module.exports,module);
  const props={orderId:90001,balanceUsd:14,balanceBs:15400,activeBsRate:1100,snapshotBsRate:700,nativeUsdCollection:true,
    canReportPayment:true,moneyAccounts:[{id:3,name:'Banco',currencyCode:'VES',isActive:true,paymentMethodCodes:['payment_mobile']}],
    initialReportBoxOpen:true,paymentMethod:'payment_mobile',whatsappSummary:'',deliveryReferenceDate:'2026-10-28'};
  const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
  const render=()=>{cursor=0;return nodes(module.exports.default(props));};
  const find=p=>render().find(p);
  const flush=async()=>{render();for(const f of effects.splice(0))f();await Promise.all(pending.splice(0));render();};
  await flush();
  find(n=>n.type==='select'&&n.props.value==='').props.onChange({target:{value:'3'}});await flush();
  find(n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'2026-10-28'}});await flush();
  const rate=find(n=>n.type==='select'&&n.props.value==='1000');assert.ok(rate);
  assert.deepEqual(rate.props.children.map(n=>n.props.value),['1000','900','800']);
  rate.props.onChange({target:{value:'800'}});await flush();
  assert.ok(find(n=>n.type==='input'&&n.props.value==='11200'));
  assert.equal(quotes.at(-1).operationDate,'2026-10-28');assert.equal(quotes.at(-1).exchangeRate,800);
  find(n=>n.type==='input'&&n.props.placeholder==='Numero de referencia').props.onChange({target:{value:'123456'}});
  find(n=>n.type==='input'&&n.props.placeholder==='Banco de la operacion').props.onChange({target:{value:'Venezuela'}});
  const submit=find(n=>n.type==='button'&&n.props.children==='Enviar');assert.ok(submit);assert.equal(submit.props.disabled,false);
  submit.props.onClick();await flush();
  assert.equal(reports.length,1);assert.equal(reports[0].operationDate,'2026-10-28');
  assert.equal(reports[0].reportedAmount,11200);assert.equal(reports[0].reportedExchangeRateVesPerUsd,800);
});
