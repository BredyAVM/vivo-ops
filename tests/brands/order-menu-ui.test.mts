import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { orderMenuGraph, ids } from './order-menu-fixtures.ts';
import { defaultMenuOrderSelection } from '../../src/lib/brands/order-menu.ts';
const stub='data:text/javascript,export async function loadMuerdemeOrderMenu(){};export async function quoteMuerdemeOrderProduct(){};export async function searchMuerdemeOrderMenu(){};';
Reflect.get(nodeModule,'registerHooks')({resolve(s,c,next){
 if(s==='@/lib/brands/order-menu-actions')return{url:stub,shortCircuit:true};
 if(s.startsWith('@/lib/brands/'))return next(new URL('../../src/lib/brands/'+s.split('/').at(-1)+'.ts',import.meta.url).href,c);
 return next(s,c);
},load(url,c,next){
 if(url.endsWith('/MuerdemeOrderPicker.tsx'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};
 return next(url,c);
}});
const {default:Picker,MuerdemeProductConfigurator:Configurator}=await import('../../src/components/orders/MuerdemeOrderPicker.tsx');
const graph=orderMenuGraph();
test('menu picker starts closed without automatic data or administrative links',()=>{
 const html=renderToStaticMarkup(createElement(Picker,{onAdd:()=>{}}));assert.ok(html.includes('Muérdeme · menú'));
 assert.doesNotMatch(html,/Consultar menú|Desde USD|Administrar catálogo/);assert.match(html,/aria-expanded="false"/);
});
test('burger configuration displays included ingredients, forbidden removals and extra quantities with USD labels',()=>{
 const entry=graph.entries.find(e=>e.entryId===ids.burger)!;
 const html=renderToStaticMarkup(createElement(Configurator,{graph,initial:defaultMenuOrderSelection(entry),onCancel:()=>{},onConfirm:()=>{}}));
 for(const text of ['Incluye','desmarca para retirar','Extras · USD','USD 0,75','USD 5,00','Añadir al pedido'])assert.ok(html.includes(text));
 assert.match(html,/<input[^>]*disabled=""[^>]*checked=""/);assert.ok(html.includes('Cantidad de Ensayo Tocineta'));
});
test('combo config gives each burger its own choices and keeps base-price total compact',()=>{
 const entry=graph.entries.find(e=>e.entryId===ids.combo)!;const selection=defaultMenuOrderSelection(entry);selection.slots[0].removed=['sauce'];
 const html=renderToStaticMarkup(createElement(Configurator,{graph,initial:selection,onCancel:()=>{},onConfirm:()=>{}}));
 for(const text of ['Hamburguesas 1','Hamburguesas 2','Elegir hamburguesas 1','Elegir hamburguesas 2','Papas 1','Papas 2','Bebida 1','USD 15,00'])assert.ok(html.includes(text));
 assert.ok(html.includes('1 retiro(s)'));assert.doesNotMatch(html,/@muerdeme|text-3xl|text-4xl/);
});
