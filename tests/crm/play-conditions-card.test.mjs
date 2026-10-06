import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the actual TSX component without adding a browser bundle or dependency.
const nodeRequire=createRequire(import.meta.url);
function compile(relativePath, dependencies={}) {
  const source=readFileSync(new URL(relativePath,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};
  new Function('require','exports',code)((id)=>dependencies[id]??nodeRequire(id),exports);
  return exports;
}
const helper=compile('../../src/lib/crm/play-conditions.ts');
const Card=compile('../../src/app/app/advisor/plays/PlayConditionsCard.tsx',{'@/lib/crm/play-conditions':helper}).default;
const play={starts_at:'2026-10-01T04:00:00Z',ends_at:'2026-11-01T03:59:59.999Z',status:'active',benefit_selection_mode:'single',purchase_requirement_mode:'none',minimum_order_amount_usd:null,benefit_recurrence_mode:'once',benefit_fulfillment:'any'};
const benefit={id:1,name:'Single Pack de 6',quantity:1,benefitValueUsd:4,advisorCostUsd:1.5,upgrades:[{id:8,name:'Single Pack de 8',customerDifferenceUsd:2}]};

test('actual card renders semantic compact rules, approved upgrade and advisor cost',()=>{
  const html=renderToStaticMarkup(createElement(Card,{play,benefits:[benefit]}));
  assert.match(html,/Condiciones de la jugada/);
  assert.equal((html.match(/<dt /g)??[]).length,6);
  assert.match(html,/Single Pack de 8.*cliente paga \+\$2.00/);
  assert.match(html,/Cargo asesor: \$1.50 por entrega/);
  assert.match(html,/No se convierte en dinero ni en saldo libre/);
  assert.match(html,/<details open=""/);
});
test('client detail can start collapsed; paused or unconfigured campaign never implies availability',()=>{
  const html=renderToStaticMarkup(createElement(Card,{play:{...play,status:'paused'},benefits:[],defaultOpen:false}));
  assert.doesNotMatch(html,/<details open=/);
  assert.match(html,/Jugada pausada: no aplicar/);
  assert.match(html,/Pendiente de configurar/);
  assert.doesNotMatch(html,/Cargo asesor/);
});
test('conditions do not mutate campaign data and no-upgrade benefits do not offer credit',()=>{
  const input={play,benefits:[{...benefit,upgrades:[]}]}; const before=JSON.stringify(input);
  const html=renderToStaticMarkup(createElement(Card,input));
  assert.equal(JSON.stringify(input),before);
  assert.doesNotMatch(html,/usar su beneficio de/);
  assert.match(html,/Sin ampliaciones configuradas/);
});
