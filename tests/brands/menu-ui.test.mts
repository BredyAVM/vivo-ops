import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { menuDocument } from './menu-fixtures.ts';
import type { MenuDocument, MenuEditorData } from '../../src/lib/brands/menu-model.ts';
const registerHooks = Reflect.get(nodeModule,'registerHooks') as (hooks:{
  resolve(s:string,c:{parentURL?:string},next:(s:string,c:{parentURL?:string})=>{url:string;shortCircuit?:boolean}):{url:string;shortCircuit?:boolean};
  load(url:string,c:object,next:(url:string,c:object)=>{format?:string;source?:string|ArrayBufferView|null;shortCircuit?:boolean}):{format?:string;source?:string|ArrayBufferView|null;shortCircuit?:boolean};
})=>void;
registerHooks({resolve(s,c,next){
  if(s==='@/lib/brands/menu-actions')return {url:'data:text/javascript,export async function saveMuerdemeMenuDraft(){return {error:""}}',shortCircuit:true};
  if(s==='@/lib/brands/menu-model')return next(new URL('../../src/lib/brands/menu-model.ts',import.meta.url).href,c);
  return next(s,c);
},load(url,c,next){
  if(url.endsWith('/MuerdemeMenuEditor.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};
  return next(url,c);
}});
const {default:Editor}=await import('../../src/components/admin/MuerdemeMenuEditor.tsx');
const render=(document:MenuDocument)=>renderToStaticMarkup(createElement(Editor,{
  kind:document.kind,returnTo:'/app/admin/negocio/marcas/muerdeme/catalogo?consultar=1',
  data:{entry:{entryId:'00000000-0000-4000-8000-000000000010',revision:1,document,updatedAt:'2026-10-28T19:00:00Z'},lookups:[],lookupHasMore:false} satisfies MenuEditorData,
}));
test('burger editor shows per-presentation ingredients, removal permissions, extras and included fries',()=>{
  const doc=menuDocument('burger','Ensayo Hamburguesa');
  const html=render(doc);
  for(const text of ['Ingredientes incluidos','Se puede retirar','Extras permitidos','Esta presentación ya incluye papas','Precio completo · USD','Guardar preparación']) assert.ok(html.includes(text));
  assert.doesNotMatch(html,/Contenido del combo|Confirmar pago|Publicar para ventas/);
  assert.match(html,/value="Salsa"/);
});
test('combo editor provides independent groups, allowed choices and explicit USD supplements',()=>{
  const doc=menuDocument('combo','Ensayo Combo',15);
  doc.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[]}];
  const html=render(doc);
  for(const text of ['Contenido del combo','Cada hamburguesa se configurará por separado','Añadir opción permitida','Nombre del grupo']) assert.ok(html.includes(text));
  assert.match(html,/value="2"/);
  assert.match(html,/value="15,00"/);
  assert.doesNotMatch(html,/Ingredientes incluidos/);
});
test('pending prices remain blank and explicit zero is rendered as zero USD',()=>{
  const pending=render(menuDocument('drink','Ensayo Bebida',null));
  assert.match(pending,/placeholder="Pendiente" value=""/);
  assert.ok(pending.includes('Completar precios en USD'));
  const free=render(menuDocument('extra','Ensayo Extra',0));
  assert.match(free,/placeholder="Pendiente" value="0,00"/);
  assert.ok(!free.includes('Completar precios en USD'));
});
