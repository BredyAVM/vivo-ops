import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
function compile(relativePath, overrides = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const target = { exports: {} };
  runInNewContext(code, { module: target, exports: target.exports, require: id => overrides[id] ?? require(id), Intl, Date });
  return target.exports;
}
const model = compile('../../src/lib/rewards/wallet-model.ts');
const Card = compile('../../src/components/rewards/RewardGrantCard.tsx', { '@/lib/rewards/wallet-model': model }).default;
const grant = {
  id:1, advisor_id:'test-advisor', advisor_name_snapshot:'Advisor', amount:20, kind:'credit', period:'2026-09-01', status:'active',
  issued_at:'2026-10-13T14:00:00Z',expires_on:'2026-11-30',issue_reason:'Reconocimiento comercial aprobado.',revoke_reason:null,
  terms_snapshot:{title:'Crédito para deliveries',category:'alchemist',kind:'credit',mode:'commercial',purposes:['customer_gift'],product_scope:'selected_products',product_names_snapshot:['Delivery Zona 1'],product_name_snapshot:null},
  events:[{event_type:'issued',amount:20,reason:'Reconocimiento comercial aprobado.',created_at:'2026-10-13T14:00:00Z'}],
};
const render = item => renderToStaticMarkup(createElement(Card,{grant:item,asOf:new Date('2026-10-13T15:00:00Z')}));
test('real server card explains restrictions and separates available, reserved and used balances',()=>{
  const html=render(grant);
  for(const expected of ['Crédito para deliveries','Alquimista','Fondo comercial','Obsequios a clientes','Delivery Zona 1','Vigente','Sin efectivo','Disponible','Reservado','Utilizado'])assert.ok(html.includes(expected));
  const partial=model.rewardGrantState({...grant,reserved_amount:4,used_amount:6},new Date('2026-10-13T15:00:00Z'));
  assert.equal(partial.validAmount,10);assert.equal(partial.reserved,4);assert.equal(partial.used,6);
});
test('product award renders units, not a monetary balance',()=>{
  const html=render({...grant,kind:'product_units',amount:3,terms_snapshot:{...grant.terms_snapshot,kind:'product_units',product_name_snapshot:'Single Pack',product_names_snapshot:['Single Pack']}});
  assert.ok(html.includes('3 × Single Pack'));
  assert.ok(!html.includes('US$'));
});
test('revocation stays visible, and user-entered titles and reasons are escaped',()=>{
  const html=render({...grant,status:'revoked',terms_snapshot:{...grant.terms_snapshot,title:'<script>invalid</script>'},events:[...grant.events,{event_type:'revoked',amount:20,reason:'<img src=x onerror=alert(1)>',created_at:'2026-10-14T15:00:00Z'}]});
  assert.ok(html.includes('Revocado'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));
});
