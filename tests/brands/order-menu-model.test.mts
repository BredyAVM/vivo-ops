import test from 'node:test';
import assert from 'node:assert/strict';
import { orderMenuGraph,ids } from './order-menu-fixtures.ts';
import { defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines,readMenuOrderQuote,decodeOrderMenuGraph,menuUnit } from '../../src/lib/brands/order-menu.ts';
import { getVisibleEditableDetailLines } from '../../src/lib/orders/order-composer.ts';
import { isInternalOrderDetailLine } from '../../src/lib/crm/play-order.ts';
const root=(key:'burger'|'combo'|'fries'|'drink',graph=orderMenuGraph())=>graph.entries.find(e=>e.entryId===ids[key])!;
test('default recipes preserve simple/double choice without adding extras or multiplying ingredients',()=>{
  const graph=orderMenuGraph();const entry=root('burger',graph);
  const simple=defaultMenuOrderSelection(entry),double=defaultMenuOrderSelection(entry,'double');
  assert.equal(quoteMenuOrder(graph,simple).unitUsd,5);assert.equal(quoteMenuOrder(graph,double).unitUsd,7);
  assert.deepEqual(simple.removed,[]);assert.deepEqual(simple.extras,[]);assert.equal(double.slots.length,0);
});
test('two burgers in one combo retain independent removals/extras and only charge explicit supplements',()=>{
  const graph=orderMenuGraph();const selection=defaultMenuOrderSelection(root('combo',graph));
  selection.slots[0].removed=['sauce'];selection.slots[1].removed=['pickle'];selection.slots[1].variantKey='double';
  selection.slots[1].extras=[{entryId:ids.extra,variantKey:'standard',quantity:1}];
  selection.slots[2].friesUpgrade='large';
  const quote=quoteMenuOrder(graph,selection);
  assert.equal(quote.unitUsd,17);assert.deepEqual(quote.selection.slots[0].extras,[]);
  assert.equal(quote.detailLines.filter(l=>l.includes('Extra:')).length,1);
  assert.ok(quote.detailLines.includes('  Sin Salsa'));assert.ok(quote.detailLines.includes('  Sin Pepinillos'));
});
test('included fries charge only upgrade and no duplicate full side price',()=>{
  const graph=orderMenuGraph();root('burger',graph).document.variants[0].burger!.includedFries={entryId:ids.fries,variantKey:'standard',quantity:2};
  const selection=defaultMenuOrderSelection(root('burger',graph));selection.friesUpgrade='large';
  assert.equal(quoteMenuOrder(graph,selection).unitUsd,6.5);
});
test('standalone fries/drinks use their own price and zero is an explicit valid price',()=>{
  const graph=orderMenuGraph();const fries=defaultMenuOrderSelection(root('fries',graph));fries.friesUpgrade='large';
  assert.equal(quoteMenuOrder(graph,fries).unitUsd,2.75);
  root('drink',graph).document.variants[0].priceUsd=0;assert.equal(quoteMenuOrder(graph,defaultMenuOrderSelection(root('drink',graph))).unitUsd,0);
  root('drink',graph).document.variants[0].priceUsd=null;assert.throws(()=>quoteMenuOrder(graph,defaultMenuOrderSelection(root('drink',graph))),/precio/);
});
test('unauthorized removals, extras, duplicates, wrong combo choices and quantities fail closed',()=>{
  const graph=orderMenuGraph();
  for(const change of [s=>s.removed=['bread'],s=>s.removed=['unknown'],s=>s.removed=['sauce','sauce'],
    s=>s.extras=[{entryId:ids.extra,variantKey:'standard',quantity:3}],s=>s.extras=[{entryId:ids.drink,variantKey:'standard',quantity:1}],
    s=>s.friesUpgrade='large',s=>s.slots=[{...menuUnit(ids.burger,'double'),groupKey:'fake',position:0}]]){
    const selection=defaultMenuOrderSelection(root('burger',graph));change(selection);assert.throws(()=>quoteMenuOrder(graph,selection));
  }
  const combo=defaultMenuOrderSelection(root('combo',graph));combo.slots[0].variantKey='unknown';assert.throws(()=>quoteMenuOrder(graph,combo));
  combo.slots.pop();assert.throws(()=>quoteMenuOrder(graph,combo),/unidades/);
});
test('unknown fields, inactive/missing component and draft adapter absence cannot become a sellable quote',()=>{
  const graph=orderMenuGraph();const selection=defaultMenuOrderSelection(root('burger',graph));
  assert.throws(()=>quoteMenuOrder(graph,{...selection,discount:100}),/no admitidas/);
  root('burger',graph).productId=null;assert.throws(()=>quoteMenuOrder(graph,selection),/prepararlo/);
  root('burger',graph).productId=1000;root('burger',graph).document.archived=true;assert.throws(()=>quoteMenuOrder(graph,selection),/no está disponible/);
});
test('structured snapshot round-trips while technical metadata stays hidden and visible composition remains',()=>{
  const graph=orderMenuGraph();const quote=quoteMenuOrder(graph,defaultMenuOrderSelection(root('combo',graph)));
  const lines=menuQuoteDetailLines(quote);assert.deepEqual(readMenuOrderQuote(lines),quote);
  assert.deepEqual(getVisibleEditableDetailLines(lines),quote.detailLines);
  assert.ok(isInternalOrderDetailLine(lines.at(-1)!));assert.throws(()=>readMenuOrderQuote([...lines,lines.at(-1)!]),/duplicada/);
  assert.deepEqual(decodeOrderMenuGraph({version:'muerdeme-order-menu-v1',...graph}),graph);
});
test('independent portions and decimal extras use integer cents without floating drift',()=>{
  const graph=orderMenuGraph();const entry=root('burger',graph);entry.document.variants[0].priceUsd=0.1;
  graph.entries.find(e=>e.entryId===ids.extra)!.document.variants[0].priceUsd=0.2;
  const a=defaultMenuOrderSelection(entry);a.extras=[{entryId:ids.extra,variantKey:'standard',quantity:1}];
  const b=defaultMenuOrderSelection(entry);assert.equal(quoteMenuOrder(graph,a).unitUsd,0.3);assert.equal(quoteMenuOrder(graph,b).unitUsd,0.1);
});
