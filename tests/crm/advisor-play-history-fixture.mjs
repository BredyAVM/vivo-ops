import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
export const advisor='advisor-fixture';
const fixedTime='2026-11-02T12:00:00Z';
class Clock extends Date { constructor(...args){super(...(args.length?args:[fixedTime]));} static now(){return new Date(fixedTime).getTime();} }
export function compile(path, overrides={}){
 const file=new URL(path,import.meta.url);
 const source=readFileSync(file,'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,console,Intl,Date:Clock,URLSearchParams,require:name=>{
  if(name in overrides)return overrides[name];
  if(name==='next/link')return {default:({children,prefetch,...props})=>React.createElement('a',props,children)};
  if(name.startsWith('@/'))return compile('../../src/'+name.slice(2)+'.ts',overrides);
  if(name.startsWith('.')){
   const relative=new URL(name.endsWith('.ts')||name.endsWith('.tsx')?name:name+'.tsx',file);
   return compile(relative.href,overrides);
  }
  return require(name);
 }});
 return module.exports;
}
export function fixtureRows(){
 const plays=[{id:27,name:'Aniversario · octubre',status:'closed',starts_at:'2026-10-01T04:00:00Z',ends_at:'2026-11-01T03:59:59.999Z'},
  {id:18,name:'Aniversario · septiembre',status:'closed',starts_at:'2026-09-01T04:00:00Z',ends_at:'2026-10-01T03:59:59.999Z'},
  {id:40,name:'Plan secreto',status:'draft',starts_at:'2026-11-01T04:00:00Z',ends_at:null},
  {id:41,name:'Lista de otro asesor',status:'closed',starts_at:'2026-10-01T04:00:00Z',ends_at:'2026-11-01T03:59:59.999Z',owner:'other'}]
 .map(p=>({description:'Reconocer la fidelidad',advisor_guidance:'Un contacto cercano',message_template:'Epa [Nombre], tenemos un detalle para ti.',rules_snapshot:{min_purchase_count:8},gift_product_id:61,gift_quantity:1,benefit_selection_mode:'single',purchase_requirement_mode:'none',minimum_order_amount_usd:null,benefit_recurrence_mode:'once',benefit_fulfillment:'any',owner:advisor,...p}));
 const members=plays.map((p,i)=>({id:100+i,play_id:p.id,client_id:20+i,advisor_id_snapshot:p.owner,client:{id:20+i,full_name:p.owner==='other'?'Cliente ajeno':'Ana de '+p.name},play:p,workflow_status:'launched',benefit_status:i===0?'redeemed':'available',purchase_count:12,net_revenue_usd:250,days_since_last_purchase:20,contact_attempt_count:1,contacted_at:'2026-10-03T12:00:00Z',responded_at:'2026-10-03T12:01:00Z',play_launched_at:'2026-10-03T12:02:00Z',next_follow_up_at:null,first_purchase_on:'2024-10-01',last_purchase_on:'2026-09-20',last_gift_on:null,last_note:'Gracias por el detalle',eligibility_reasons:['8 o más cierres'],no_apply:[]}));
 return {crm_plays:plays,crm_play_members:members,crm_play_benefits:plays.map(p=>({id:p.id,play_id:p.id,quantity:1,unit_benefit_value_usd:4,unit_advisor_cost_usd:0.75,product:{name:'Single Pack'},upgrades:[]})),crm_play_benefit_upgrades:[],crm_play_member_events:[{id:1,play_member_id:100,event_type:'launched',created_at:'2026-10-03T12:02:00Z',note:'Propuesta enviada',channel:'whatsapp'}],crm_play_redemptions:[{id:1,play_member_id:100,order_id:3000,status:'redeemed',quantity:1,advisor_charge_usd:0.75,created_at:'2026-10-04T12:00:00Z',redeemed_at:'2026-10-04T12:30:00Z',product:{name:'Single Pack'}}]};
}
export function historyFixture(rows=fixtureRows()){
 const calls=[];
 const db={from(table){const filters=[];let range=null;let single=false;const q={
  select(columns){calls.push({table,columns,filters});return q;},eq(key,value){filters.push([key,value]);return q;},in(key,values){filters.push([key,values]);return q;},order(){return q;},range(a,b){range=[a,b];return q;},maybeSingle(){single=true;return q;},
  then(resolve,reject){let data=(rows[table]??[]).filter(row=>filters.every(([key,value])=>{
   const actual=key==='assigned.advisor_id_snapshot'?row.owner:row[key];return Array.isArray(value)?value.includes(actual):actual===value;
  }));if(range)data=data.slice(range[0],range[1]+1);return Promise.resolve({data:single?data[0]??null:data,error:null}).then(resolve,reject);}
 };return q;}};
 const overrides={'@/lib/auth':{getAuthContext:async()=>({user:{id:advisor},supabase:db})}};
 return {calls,rows,
  renderList:async(query={})=>renderToStaticMarkup(await compile('../../src/app/app/advisor/plays/page.tsx',overrides).default({searchParams:Promise.resolve(query)})),
  renderMember:async(id='100')=>renderToStaticMarkup(await compile('../../src/app/app/advisor/plays/history/[memberId]/page.tsx',overrides).default({params:Promise.resolve({memberId:id})})),
 };
}
