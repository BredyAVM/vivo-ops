import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,orderMenuGraph,stockRecipes,stocks}from'./inventory-menu-fixtures.ts';
import{buildMenuStockSnapshot,parseMenuStockRecipe,menuStockSignature,readMenuStockSnapshot,MUERDEME_STOCK_PREFIX}from'../../src/lib/brands/inventory-menu.ts';
import{defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines}from'../../src/lib/brands/order-menu.ts';
import{getKitchenItemPresentation}from'../../src/lib/kitchen/order-presentation.ts';
const graph=orderMenuGraph();
const selection=(key:keyof typeof ids)=>defaultMenuOrderSelection(graph.entries.find(e=>e.entryId===ids[key])!);
const snapshot=(s=selection('burger'),g=graph,recipes=stockRecipes(g),items=stocks)=>buildMenuStockSnapshot(g,quoteMenuOrder(g,s),recipes,items);
test('stock consumption follows each burger, removals, extras and upgraded fries exactly once',()=>{
 const s=selection('combo');s.slots[0].removed=['sauce'];s.slots[1].variantKey='double';s.slots[1].extras=[{entryId:ids.extra,variantKey:'standard',quantity:2}];s.slots[2].friesUpgrade='large';
 const result=snapshot(s);assert.equal(result.status,'ready');
 assert.deepEqual(result.lines.map(l=>[l.inventoryItemId,l.quantity]),[[1,2],[2,0.3],[3,0.02],[4,0.05],[5,0.3],[6,1]]);
 assert.equal(result.kitchen.length,5);assert.deepEqual(result.kitchen[0].removed,['Salsa']);assert.equal(result.kitchen[1].extras.length,1);
 assert.equal(result.recipeRevisions[ids.combo+':standard'],0);
});
test('burger with included fries consumes one selected size and preserves portion count',()=>{
 const g=structuredClone(graph);g.entries.find(e=>e.entryId===ids.burger)!.document.variants[0].burger!.includedFries={entryId:ids.fries,variantKey:'standard',quantity:2};
 const s=selection('burger');s.friesUpgrade='large';const result=snapshot(s,g);
 assert.equal(result.lines.find(l=>l.inventoryItemId===5)?.quantity,0.4);assert.equal(result.kitchen[1].quantity,2);
 assert.match(result.kitchen[1].label,/Grandes/);
});
test('missing/stale recipes or production-only stocks prevent partial deductions',()=>{
 for(const recipes of [[],stockRecipes(graph).map(r=>({...r,signature:{}}))]){const result=snapshot(selection('combo'),graph,recipes);assert.equal(result.status,'pending');assert.deepEqual(result.lines,[]);assert.equal(result.kitchen.length,5);}
 const result=snapshot(selection('combo'),graph,stockRecipes(graph),stocks.map(s=>({...s,eligible:s.id!==2})));assert.equal(result.status,'pending');assert.deepEqual(result.lines,[]);
});
test('price updates do not stale quantities, while patty or included ingredient changes require review',()=>{
 const v=graph.entries[0].document.variants[0];assert.deepEqual(menuStockSignature('burger',v),menuStockSignature('burger',{...v,priceUsd:99}));
 assert.notDeepEqual(menuStockSignature('burger',v),menuStockSignature('burger',{...v,burger:{...v.burger!,pattyCount:2}}));
 const g=structuredClone(graph);g.entries[0].document.variants[0].burger!.ingredients[0].label='Otra salsa';assert.equal(snapshot(selection('burger'),g,stockRecipes(graph)).status,'pending');
});
test('recipe quantities support six decimals, refuse duplicate links and require explicit untracked reason',()=>{
 const variant=graph.entries[0].document.variants[0];const d={schemaVersion:1,mode:'tracked',note:'',lines:[{inventoryItemId:2,quantity:0.000001,ingredientKey:null}]};
 assert.equal(parseMenuStockRecipe(d,'burger',variant).lines[0].quantity,0.000001);
 for(const quantity of [0,-1,NaN,0.0000001])assert.throws(()=>parseMenuStockRecipe({...d,lines:[{...d.lines[0],quantity}]},'burger',variant));
 assert.throws(()=>parseMenuStockRecipe({...d,lines:[d.lines[0],d.lines[0]]},'burger',variant),/relacionados/);
 assert.throws(()=>parseMenuStockRecipe({...d,mode:'untracked',lines:[]},'burger',variant),/por qué/);
 assert.throws(()=>parseMenuStockRecipe({...d,mode:'components',lines:[]},'burger',variant),/combo/);
});
test('kitchen receives independent preparation details, no prices or internal markers, and VIVO remains unchanged',()=>{
 const s=selection('combo');s.slots[0].removed=['sauce'];s.slots[1].extras=[{entryId:ids.extra,variantKey:'standard',quantity:1}];const quote=quoteMenuOrder(graph,s);
 const saved=snapshot(s);const notes=[...menuQuoteDetailLines(quote),MUERDEME_STOCK_PREFIX+JSON.stringify(saved)].join('\n');
 const result=getKitchenItemPresentation({qty:1,name:quote.title,notes,unitsPerService:0});assert.equal(result.preparedUnits,4);assert.equal(result.totalUnits,5);assert.match(result.preparationSummary!,/2 hamburguesas · 2 porciones de papas · 1 bebida/);
 const text=JSON.stringify(result);assert.match(text,/Sin Salsa/);assert.match(text,/Extra: 1 Ensayo Tocineta/);assert.doesNotMatch(text,/USD|@muerdeme/);
 const broken=getKitchenItemPresentation({qty:1,name:quote.title,notes:menuQuoteDetailLines(quote).join('\n'),unitsPerService:0});assert.equal(broken.preparedUnits,0);assert.match(broken.quantityWarning!,/verificar/);
 assert.deepEqual(readMenuStockSnapshot(notes),saved);assert.equal(readMenuStockSnapshot('VIVO normal'),null);
 assert.throws(()=>readMenuStockSnapshot(notes+'\n'+MUERDEME_STOCK_PREFIX+'{}'),/incompleto/);
});
