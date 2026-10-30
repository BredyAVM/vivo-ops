import test from'node:test';import assert from'node:assert/strict';import*as nodeModule from'node:module';import{readFileSync}from'node:fs';import{fileURLToPath}from'node:url';import ts from'typescript';import{createElement}from'react';import{renderToStaticMarkup}from'react-dom/server';
Reflect.get(nodeModule,'registerHooks')({resolve(s,c,next){if(s==='@/lib/brands/order-incentives')return next(new URL('../../src/lib/brands/order-incentives.ts',import.meta.url).href,c);return next(s,c);},load(url,c,next){if(url.endsWith('/MuerdemeIncentiveBreakdown.tsx'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};return next(url,c);}});
const{default:Breakdown}=await import('../../src/components/commissions/MuerdemeIncentiveBreakdown.tsx');
test('VIVO history has no new section or implied incentive',()=>{assert.equal(renderToStaticMarkup(createElement(Breakdown,{snapshot:{orders:[]}})),'');});
test('compact breakdown shows short numbers, USD and original policy; order detail stays folded',()=>{
 const html=renderToStaticMarkup(createElement(Breakdown,{snapshot:{muerdeme_incentives:{version:1,totalUsd:0.3,rows:[{orderId:88889999,orderNumber:'3650',advisorId:'private-user-uuid',policyRevision:1,purchaseKind:'first',amountUsd:0.3,status:'ready',deliveryDate:'2026-10-29'}]}}}));
 for(const text of['Estímulos por hamburguesas','#3650','Primera compra','Tarifa v1','USD','0,30'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/88889999|private-user-uuid|<details open|text-[345]xl/);
});

test('a selected combo condition shows its saved name and revision instead of implying the usual tariff',()=>{
 const html=renderToStaticMarkup(createElement(Breakdown,{snapshot:{muerdeme_incentives:{version:1,totalUsd:0.65,rows:[{orderId:99999,orderNumber:'3600',advisorId:'advisor',policyRevision:1,purchaseKind:'recurrent',amountUsd:0.65,status:'ready',deliveryDate:'2026-10-30',fixedCombo:{entryId:'00000000-0000-4000-8000-000000000099',revision:2,name:'Combo doble',amountUsd:0.65}}]}}}));
 for(const text of['#3600','Combo doble','Condición v2','0,65','mayor importe aplicable'])assert.ok(html.includes(text));
 assert.doesNotMatch(html,/99999|Tarifa v1/);
});
