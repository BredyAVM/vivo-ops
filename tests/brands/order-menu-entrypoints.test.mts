import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { orderMenuGraph,ids } from './order-menu-fixtures.ts';
import { defaultMenuOrderSelection,quoteMenuOrder,menuQuoteDetailLines } from '../../src/lib/brands/order-menu.ts';
const stub='data:text/javascript,'+encodeURIComponent(`
 export const calls=[];export let roles=['admin'];export let response={data:{salesEnabled:false,rows:[],hasNext:false,page:1},error:null};
 export const supabase={rpc:async(name,args)=>{calls.push([name,args]);return typeof response==='function'?response(name,args):response;}};
 export async function requireAuthContext(){calls.push(['auth']);return {supabase,user:{id:'admin'},roles};}
 export function reset(){calls.length=0;roles=['admin'];response={data:{salesEnabled:false,rows:[],hasNext:false,page:1},error:null};}
 export function setResponse(value){response=value;}export function setRoles(value){roles=value;}
`);
const register=Reflect.get(nodeModule,'registerHooks');
register({resolve(s,c,next){
 if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};
 if(s==='@/lib/auth')return{url:stub,shortCircuit:true};
 if(s.startsWith('./')&&c.parentURL?.includes('/src/lib/brands/')&&!s.endsWith('.ts'))return next(new URL(s+'.ts',c.parentURL).href,c);
 return next(s,c);
}});
const control=await import(stub);
const {verifyMuerdemeOrderItems}=await import('../../src/lib/brands/order-menu-save.ts');
const {searchMuerdemeOrderMenu,loadMuerdemeOrderMenu,quoteMuerdemeOrderProduct}=await import('../../src/lib/brands/order-menu-actions.ts');
const graph=orderMenuGraph();const root=graph.entries.find(e=>e.entryId===ids.burger)!;
const quote=quoteMenuOrder(graph,defaultMenuOrderSelection(root));
const item=()=>({productId:quote.productId,qty:1,sourcePriceCurrency:'USD',sourcePriceAmount:quote.unitUsd,editableDetailLines:menuQuoteDetailLines(quote)});
test('VIVO-only verification performs no added RPC or table query',async()=>{
 control.reset();await verifyMuerdemeOrderItems(control.supabase,[{productId:1,qty:2,editableDetailLines:['50 Mini tequeños']}]);assert.deepEqual(control.calls,[]);
});
test('preparation cannot create a Muérdeme order and never asks for a financial writer',async()=>{
 control.reset();await assert.rejects(()=>verifyMuerdemeOrderItems(control.supabase,[item()]),/preparación/);
 assert.equal(control.calls.length,1);assert.equal(control.calls[0][0],'muerdeme_order_menu_search_v1');
});
test('mixed VIVO/Muérdeme checks preserve the ordinary lines and validate each configurable line',async()=>{
 control.reset();control.setResponse(name=>({data:name==='muerdeme_order_menu_search_v1'?{salesEnabled:true}:quote,error:null}));
 const vivo={productId:1,qty:2,editableDetailLines:['50 Mini tequeños']};const a=item();const b=item();
 const value=await verifyMuerdemeOrderItems(control.supabase,[vivo,a,b]);assert.equal(value.size,1);assert.deepEqual(vivo.editableDetailLines,['50 Mini tequeños']);
 assert.equal(control.calls.filter(c=>c[0]==='muerdeme_order_quote_v1').length,1);assert.deepEqual(a.editableDetailLines,b.editableDetailLines);
});
test('forged price, identity, quantities, CRM and reward funding fail before any order write',async()=>{
 for(const change of [{qty:2},{sourcePriceAmount:0},{productId:1},{crmPlayMemberId:7},{rewardGrantId:8},{sourcePriceCurrency:'VES'}]){
  control.reset();control.setResponse(name=>({data:name==='muerdeme_order_menu_search_v1'?{salesEnabled:true}:quote,error:null}));
  await assert.rejects(()=>verifyMuerdemeOrderItems(control.supabase,[{...item(),...change}]),/conserva/);
  assert.ok(control.calls.every(c=>c[0].startsWith('muerdeme_order_')));
 }
});
test('stale menu does not silently reprice an order',async()=>{
 control.reset();control.setResponse(name=>name==='muerdeme_order_menu_search_v1'?{data:{salesEnabled:true},error:null}:{data:null,error:{code:'40001'}});
 await assert.rejects(()=>verifyMuerdemeOrderItems(control.supabase,[item()]),/menú cambió/);
});
test('menu actions authorize independently and validate filters before accessing data',async()=>{
 control.reset();control.setRoles(['kitchen']);await assert.rejects(()=>searchMuerdemeOrderMenu(),/permisos/);assert.deepEqual(control.calls,[['auth']]);
 control.reset();await assert.rejects(()=>searchMuerdemeOrderMenu('',null,-1),/filtros/);assert.deepEqual(control.calls,[['auth']]);
 control.reset();await assert.rejects(()=>loadMuerdemeOrderMenu('bad'),/producto válido/);assert.deepEqual(control.calls,[['auth']]);
});
test('menu reads are bounded and returns no historical data or financial calls',async()=>{
 control.reset();const result=await searchMuerdemeOrderMenu('Original','burger',1);assert.equal(result.rows.length,0);
 assert.deepEqual(control.calls,[['auth'],['muerdeme_order_menu_search_v1',{p_query:'Original',p_kind:'burger',p_page:1}]]);
});
test('quote action uses database-approved prices, not a price sent by the browser',async()=>{
 control.reset();control.setResponse({data:quote,error:null});assert.deepEqual(await quoteMuerdemeOrderProduct(quote.selection,quote.revisions),quote);
 assert.equal(control.calls[1][0],'muerdeme_order_quote_v1');assert.equal('unitUsd'in control.calls[1][1],false);
});
test('all shared entry points verify Muérdeme before creating/updating client or order data',()=>{
 for(const file of ['src/app/app/master/ops/actions.ts','src/app/app/master/dashboard/actions.ts','src/app/app/advisor/new/actions.ts']){
  assert.ok(readFileSync(file,'utf8').includes('verifyMuerdemeOrderItems'));
 }
 for(const file of ['src/app/app/master/ops/MasterOpsOrderEditor.tsx','src/app/app/advisor/new/AdvisorOrderComposer.tsx']){
  const source=readFileSync(file,'utf8');assert.ok(source.includes('MuerdemeOrderPicker'));assert.ok(source.includes('menuQuoteDetailLines'));
 }
});
