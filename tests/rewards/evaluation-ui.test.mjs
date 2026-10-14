import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url);
const advisor='00000000-0000-0000-0000-000000000002';
const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
function compile(path,imports={}){
 const output=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(output,{exports:module.exports,module,require:name=>name in imports?imports[name]:require(name),console,Intl,Date,URLSearchParams});
 return module.exports;
}
const goal=compile('../../src/lib/commissions/goal-engine.ts');
const model=compile('../../src/lib/rewards/evaluation-model.ts',{'../commissions/goal-engine.ts':goal});
const fixture=()=>({
 period:'2026-09-01',rule_version:'awards-preview-v1',calculated_at:'2026-10-13T12:00:00Z',ambiguous_clients:0,evidence_total:1,
 cohort_metrics:['alchemist','influential'].map(category=>({category,advisor_id:advisor,advisor_name:'Demo',incorporation:13,return_pct:15,regularity_pct:20,repeat_orders:6,revenue:700,older_pool:10,older_returned:2,inferred_new:1})),
 strategic_metrics:[{advisor_id:advisor,advisor_name:'Demo',current_active:11,prior_active:10,continuity_pct:40,dormant_60_180:10,reactivation_pct:12,multi_day_buyers_pct:30,current_orders:11,prior_orders:10,current_revenue:1100,prior_revenue:1000}],
 seasonal_samples:[2023,2024,2025].flatMap(year=>Array.from({length:4},()=>({year,previous_active:100,current_active:100,previous_orders:100,current_orders:100,previous_revenue:100,current_revenue:100}))),
 evidence:[{client_id:1,client_name:'<script>bad</script>',metrics:{period_orders:2,period_repeat_orders:1,period_revenue:20,first_purchase_on:'2026-07-01',previous_month_orders:1,origin:'direct_assigned'},orders:[]}],
});
const link=({children,prefetch,...props})=>React.createElement('a',props,children);
const controls=compile('../../src/app/app/admin/evaluacion/AwardReviewControls.tsx',{
 'next/navigation':{useRouter:()=>({push(){},refresh(){}})},
 './actions':{prepareAwardReview:async()=>({ok:true}),publishAwardReview:async()=>({ok:true}),resumeAwardReview:async()=>({ok:true})},
 '@/lib/rewards/evaluation-model':model,
}).default;
function pageWith(response,calls){return compile('../../src/app/app/admin/evaluacion/page.tsx',{
 'next/link':{default:link},
 '@/lib/auth':{requireAdminContext:async()=>({supabase:{from:()=>{const q={select(){return q;},eq(){return q;},order(){return q;},limit:async()=>({data:[],error:null}),maybeSingle:async()=>({data:null,error:null})};return q;},rpc:async(name,args)=>{calls.push({name,args});return response;}}})},
 '@/lib/rewards/evaluation-model':model,
 '@/lib/rewards/wallet-model':{UUID_PATTERN:/^[0-9a-f-]{36}$/},
 './AwardReviewControls':{default:controls},
}).default;}
test('actual evaluation page renders explainable preview, minima, safe evidence and no issuance',async()=>{
 const calls=[];const page=pageWith({data:fixture(),error:null},calls);
 const html=renderToStaticMarkup(await page({searchParams:Promise.resolve({month:'2026-09',evaluate:'1',advisor,category:'alchemist'})}));
 assert.equal(calls[0].name,'admin_award_evaluation_preview_v2');assert.equal(calls[0].args.p_offset,0);
 for(const text of ['Ranking','Lidera la simulación: Demo','septiembre sin premio','confirmarse antes de publicar','Guardar corte para revisar','Base de los dos meses previos: 10','Resultado','Meta completa','Clientes que sustentan','Cómo se calcula y cómo mejorar'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!html.includes('<script>bad'));
 assert.ok(!html.includes('reward_issue'));assert.ok(!html.includes('Publicar ganadores'));
});
test('saved report renders frozen rules, review confirmation and no oversized raw data props',async()=>{
 const calls=[];const data=fixture();data.rule_version='awards-v2';data.execution={plays:[],counts:[],volume:[]};
 const rules={globalMinimum:81,executorEnabled:false,executorReason:'Septiembre sin premio por registros incompletos.',deliveryTargets:{}};
 const response={data:{id:advisor,status:'review',input:data,rules,result:model.evaluateAwards(data,rules)},error:null};
 const page=pageWith(response,calls);
 const html=renderToStaticMarkup(await page({searchParams:Promise.resolve({month:'2026-09',report:advisor})}));
 assert.equal(calls[0].name,'admin_award_report_view_v2');assert.ok(html.includes('Datos y reglas no se sobrescriben'));
 assert.ok(html.includes('Cerrar y publicar para los asesores'));assert.ok(html.includes('Revisé mínimos'));
 assert.ok(html.includes('Mínimo confirmado en este corte'));assert.ok(html.includes('81'));
});
test('initial and invalid-period pages do not run heavy queries; failures never fabricate rankings',async()=>{
 const calls=[];const page=pageWith({data:null,error:{code:'test'}},calls);
 const initial=renderToStaticMarkup(await page({searchParams:Promise.resolve({month:'2026-09'})}));assert.equal(calls.length,0);assert.ok(initial.includes('pulsa Evaluar'));
 await page({searchParams:Promise.resolve({month:'2099-01',evaluate:'1'})});assert.equal(calls.length,0);
 const failed=renderToStaticMarkup(await page({searchParams:Promise.resolve({month:'2026-09',evaluate:'1'})}));assert.equal(calls.length,1);assert.ok(failed.includes('No se pudo calcular'));assert.ok(!failed.includes('Lidera la simulación'));
});
test('September controls expose contact 80, day-only delivery references and explicit review limitations',()=>{
 const html=renderToStaticMarkup(React.createElement(controls,{period:'2026-09',initialRules:{...model.defaultAwardRules('2026-09'),executorEnabled:true,executorReviewNote:'Aceptación explícita con limitaciones de registro.'},plays:[{id:18,name:'Aniversario',available_days:23}],currentPublication:null,isClosed:true}));
 for(const text of ['Referencia de contacto','value="80"','Propuesta conserva su referencia del 70%','Referencia de entrega para 30 días','value="40"','Calcular referencias por días','obligatorio para septiembre','no convierte los estados reconstruidos'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('checked=""'));assert.ok(!html.includes('disabled=""'));
});
