// Component-handler tests with an isolated hook driver (no server actions/network).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const root = new URL('../../src/app/app/counter/', import.meta.url);
function moduleWithHooks(name, hooks) {
  const source = readFileSync(new URL(name, root), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'module', compiled)((id) => {
    if (id === 'react') return hooks;
    if (id === './actions' || id === './read-actions') return {};
    if (id.startsWith('./')) return moduleWithHooks(id.slice(2) + '.ts', hooks);
    return require(id);
  }, module.exports, module);
  return module.exports;
}
function driver(overrides={}) {
  const slots=[]; let cursor=0; const calls=[];
  const hooks={
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial==='function'?initial():initial; return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}]; },
    useRef(initial) { const i=cursor++; if (!(i in slots)) slots[i]={current:initial}; return slots[i]; },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; }, useEffect() {},
  };
  const { CounterDeliveryDispatchPanel } = moduleWithHooks('CounterDeliveryWorkspace.tsx', hooks);
  const props={order:{id:1,hasAdvisor:true,balanceUsd:75.5,paymentMethod:'cash_usd',paymentRequiresChange:true,paymentChangeFor:'100',paymentChangeCurrency:'USD',deliveryAssigneeName:'Motorizado de prueba',paymentQuote:{pendingUsd:75.5,pendingBs:66198.4,exchangeRate:876.8,collectionMode:'snapshot_quote'},...overrides},
    paymentAccounts:[{accountId:1,accountName:'Caja prueba',currencyCode:'USD',accountKind:'cash',canConfirmPayment:true}],
    activeBsRate:876.8,isWorking:false,onSubmit:async intent=>{calls.push(intent);return {};},onCancel:()=>{}};
  const render=()=>{cursor=0;return CounterDeliveryDispatchPanel(props);};
  const nodes=(node)=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)];
  const find=(predicate)=>{const node=nodes(render()).find(predicate);assert.ok(node,'Expected rendered node');return node;};
  const click=(text)=>{const node=find(n=>n.type==='button'&&String(n.props.children).trim()===text);assert.ok(!node.props.disabled);node.props.onClick();};
  const edit=(name,lines)=>find(n=>n.type?.name===name).props.onChange(lines);
  return {calls,render,find,click,edit};
}
const cash=(amount)=>[{id:'cash-test',accountId:1,amount,referenceCode:''}];
const expected=(amount)=>[{id:'expected-test',currencyCode:'USD',amount,referenceCode:''}];
test('ETA → actual cash 24 → confirm expected 100 without forced digital', async()=>{
  const ui=driver();ui.click('Continuar');ui.edit('DeliveryCashDrafts',cash('24'));ui.click('Continuar');
  assert.equal(ui.find(n=>n.props?.label==='Efectivo enviado para cambio').props.value,'$24.00');
  assert.equal(ui.find(n=>n.props?.label==='Debe regresar').props.value,'$100.00');
  ui.click('Entregar y marcar en camino');await Promise.resolve();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].cashChangeLines[0].amount,24);
  assert.equal(ui.calls[0].expectedCollectionLines[0].amount,100);assert.deepEqual(ui.calls[0].digitalChangeLines,[]);
});
test('partial collection below balance with change is allowed', async()=>{
  const ui=driver();ui.click('Continuar');ui.edit('DeliveryValueDrafts',expected('20'));ui.edit('DeliveryCashDrafts',cash('5'));
  ui.click('Continuar');ui.click('Entregar y marcar en camino');await Promise.resolve();
  assert.equal(ui.calls[0].expectedCollectionLines[0].amount,20);assert.equal(ui.calls[0].cashChangeLines[0].amount,5);
});
test('change above suggested amount can leave customer debt', async()=>{
  const ui=driver();ui.click('Continuar');ui.edit('DeliveryCashDrafts',cash('25'));ui.click('Continuar');ui.click('Entregar y marcar en camino');await Promise.resolve();
  assert.equal(ui.calls[0].cashChangeLines[0].amount,25);
});
test('removing suggested change and going back does not silently restore it',()=>{
  const ui=driver();ui.click('Continuar');ui.edit('DeliveryCashDrafts',[]);ui.click('Volver');ui.click('Continuar');
  assert.deepEqual(ui.find(n=>n.type?.name==='DeliveryCashDrafts').props.lines,[]);ui.click('Continuar');
});
test('invalid or blank lines cannot silently disappear during dispatch',()=>{
  for (const value of ['', '2.300','-24','0','NaN','24.001']) {
    const ui=driver();ui.click('Continuar');ui.edit('DeliveryCashDrafts',cash(value));ui.click('Continuar');
    ui.find(n=>n.type==='div'&&String(n.props.children).startsWith('Revisa los montos'));assert.equal(ui.calls.length,0);
  }
});
test('no cash prescription keeps advisor collection out of dispatch',async()=>{
  const ui=driver({paymentMethod:'pending',paymentRequiresChange:false});ui.click('Continuar');
  ui.click('Entregar y marcar en camino');await Promise.resolve();assert.deepEqual(ui.calls[0].cashChangeLines,[]);assert.deepEqual(ui.calls[0].expectedCollectionLines,[]);
});
