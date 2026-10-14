import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile,model,advisor,input,link } from './evaluation-render-fixture.mjs';
const indicators=compile('../../src/components/rewards/AwardIndicators.tsx',{'@/lib/rewards/evaluation-model':model}).default;
const page=(data,calls,error=null)=>compile('../../src/app/app/advisor/reconocimientos/page.tsx',{
 'next/link':{default:link},'@/components/rewards/AwardIndicators':{default:indicators},'@/lib/rewards/evaluation-model':model,
 '@/lib/auth':{requireAuthContext:async()=>({user:{id:advisor},supabase:{rpc:async(name,args)=>{calls.push({name,args});return{data,error};}}})},
}).default;
test('advisor renders frozen own evidence, minimums, recommendations and separate reward issuance',async()=>{
 const rules=model.defaultAwardRules('2026-09');const calculated=model.evaluateAwards(input(),rules);
 const data={id:advisor,period:'2026-09-01',published_at:'2026-10-13T12:00:00Z',rules,own:calculated.advisors[0],leaders:calculated.categoryLeaders,board:[{name:'Advisor',total:100,qualified:true}],evidence_total:1,
 evidence:[{client_id:77,client_name:'<script>unsafe</script>',metrics:{first_purchase_on:'2026-07-01',period_repeat_orders:2},orders:[{fact_origin:'live',source_record_id:501,source_control:'501',purchased_on:'2026-09-20',net_total_usd:20}]}]};
 const calls=[];const html=renderToStaticMarkup(await page(data,calls)({searchParams:Promise.resolve({month:'2026-09',category:'alchemist'})}));
 assert.equal(calls[0].name,'advisor_award_month_view_v2');assert.equal('p_advisor' in calls[0].args,false);
 for(const text of ['Mis reconocimientos','Mínimos:','80 puntos sin redondear','Retorno de al menos 10%','Datos congelados','monedero','no es un abono automático','501','Generar compras posteriores'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));assert.ok(!html.includes('Guardar corte'));assert.ok(!html.includes('Cerrar y publicar'));
});

test('own indicator component explains gradual volume without displaying reference as maximum',()=>{
 const i={label:'Propuestas · volumen único',result:66,target:10,weight:20,points:20*66/76,unit:'count',scoring:'gradual',guidance:'Cada cliente cuenta una vez.'};
 const html=renderToStaticMarkup(React.createElement(indicators,{evaluation:{score:90,available:true,qualified:true,minimums:['80 puntos sin redondear.'],failures:[],indicators:[i]}}));
 assert.ok(html.includes('mitad de puntos'));assert.ok(html.includes('no es una meta máxima'));assert.ok(!html.includes('Meta completa'));
});
test('unpublished/missing/error states never invent score zero or show administrative previews',async()=>{
 const calls=[];
 const empty=renderToStaticMarkup(await page(null,calls)({searchParams:Promise.resolve({month:'2026-09'})}));assert.ok(empty.includes('Todavía no hay un cierre publicado'));assert.ok(!empty.includes('0.00 puntos'));
 const failed=renderToStaticMarkup(await page(null,calls,{code:'denied'})({searchParams:Promise.resolve({month:'2026-09'})}));assert.ok(failed.includes('No se pudieron consultar'));assert.ok(!failed.includes('Global:'));
 const before=calls.length;await page(null,calls)({searchParams:Promise.resolve({month:'2099-01'})});assert.equal(calls.length,before);
});
