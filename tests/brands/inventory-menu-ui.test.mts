import test from'node:test';import assert from'node:assert/strict';import*as nodeModule from'node:module';import{readFileSync}from'node:fs';import{fileURLToPath}from'node:url';import ts from'typescript';import{createElement}from'react';import{renderToStaticMarkup}from'react-dom/server';
import{orderMenuGraph,stockRecipes,stocks}from'./inventory-menu-fixtures.ts';import{defaultMenuOrderSelection,quoteMenuOrder}from'../../src/lib/brands/order-menu.ts';
const stub='data:text/javascript,export const calls=[];export async function saveMuerdemeStockRecipe(){calls.push("save");};export async function previewMuerdemePreparation(){calls.push("preview");};';
Reflect.get(nodeModule,'registerHooks')({resolve(s,c,next){
 if(s==='@/lib/brands/inventory-menu-actions')return{url:stub,shortCircuit:true};
 if(s.startsWith('@/lib/'))return next(new URL('../../src/lib/'+s.slice('@/lib/'.length)+'.ts',import.meta.url).href,c);
 return next(s,c);
},load(url,c,next){if(url.endsWith('/MuerdemeInventoryEditor.tsx')||url.endsWith('/MuerdemePreparationPreview.tsx'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};return next(url,c);}});
const{default:Editor}=await import('../../src/components/admin/MuerdemeInventoryEditor.tsx');const{default:Preview}=await import('../../src/components/orders/MuerdemePreparationPreview.tsx');const control=await import(stub);
const graph=orderMenuGraph(),entry=graph.entries[0],recipe=stockRecipes(graph)[0];
test('recipe editor labels physical units and ingredient conditions, supports precise quantities and keeps compact/mobile controls',()=>{
 const html=renderToStaticMarkup(createElement(Editor,{data:{entryId:entry.entryId,menuRevision:1,menu:entry.document,variantKey:recipe.variantKey,
  recipe:{revision:1,document:recipe.document,updatedAt:'2026-10-29T00:00:00Z',signatureMatches:true},items:stocks,hasMore:false}}));
 for(const value of ['Cantidad · kg','Si lleva Salsa','Siempre incluido','Guardar consumo','inputMode="decimal"','md:min-h-8'])assert.ok(html.includes(value),value);
 assert.doesNotMatch(html,/text-[345]xl|USD|Precio/);assert.deepEqual(control.calls,[]);
});
test('preparation preview makes zero data calls until explicitly requested',()=>{
 const quote=quoteMenuOrder(graph,defaultMenuOrderSelection(entry));const html=renderToStaticMarkup(createElement(Preview,{quote}));
 assert.match(html,/Ver preparación e inventario/);assert.doesNotMatch(html,/Existencia física|Consumo de inventario/);assert.deepEqual(control.calls,[]);
});
