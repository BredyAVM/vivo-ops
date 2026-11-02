import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,historyFixture,fixtureRows,advisor} from './advisor-play-history-fixture.mjs';
const model=compile('../../src/lib/crm/advisor-play-history.ts');

test('current Caracas month is the default, old deep links work, explicit month wins and invalid input is safe',()=>{
 const plays=fixtureRows().crm_plays.filter(p=>['active','paused','closed'].includes(p.status));
 const now=new Date('2026-11-01T03:00:00Z');
 assert.equal(model.advisorPlayPeriod(plays,{},now).selectedMonth,'2026-10');
 assert.equal(model.advisorPlayPeriod(plays,{play:'18'},now).selectedMonth,'2026-09');
 assert.equal(model.advisorPlayPeriod(plays,{play:'18',month:'2026-10'},now).selectedMonth,'2026-10');
 assert.equal(model.advisorPlayPeriod(plays,{month:'2026-13'},now).selectedMonth,'2026-10');
 assert.equal(model.advisorPlayIsReadOnly(plays[0],'2026-10',new Date('2026-11-02T12:00Z')),true);
 assert.equal(model.advisorPlayIsReadOnly({...plays[0],status:'active',ends_at:'2026-11-30T23:00Z'},'2026-11',new Date('2026-11-02T12:00Z')),false);
});
test('real list retains month picker on an empty current month and never exposes draft or foreign lists',async()=>{
 const f=historyFixture();const html=await f.renderList();
 assert.match(html,/No tienes jugadas en este mes/);assert.match(html,/octubre de 2026/);assert.match(html,/septiembre de 2026/);
 assert.match(html,/<option value="2026-11" selected=""/);assert.doesNotMatch(html,/Plan secreto|Lista de otro asesor|Cliente ajeno/);
 assert.ok(f.calls.find(c=>c.table==='crm_plays').filters.some(([k,v])=>k==='assigned.advisor_id_snapshot'&&v===advisor));
});
test('real historical list keeps compact colored rows and month in filters/return navigation',async()=>{
 const f=historyFixture();const html=await f.renderList({month:'2026-10'});
 assert.match(html,/Histórica · solo consulta/);assert.match(html,/h-12 min-w-0/);assert.match(html,/border-l-4/);
 assert.match(html,/\/app\/advisor\/plays\/history\/100/);assert.match(html,/month=2026-10&amp;play=27/);
 assert.doesNotMatch(html,/Ana de Aniversario · septiembre|Cliente ajeno|Plan secreto/);
 assert.ok(f.calls.find(c=>c.table==='crm_play_members').filters.some(([k,v])=>k==='advisor_id_snapshot'&&v===advisor));
});
test('real snapshot detail reads original metrics, conditions, follow-up and deliveries without write controls',async()=>{
 const f=historyFixture();const html=await f.renderMember();
 assert.match(html,/Histórica · solo consulta/);assert.match(html,/Foto de entrada/);assert.match(html,/250.00/);assert.match(html,/Propuesta enviada/);assert.match(html,/Pedido #3000/);assert.match(html,/Cargo asesor \$0.75/);
 assert.match(html,/Ver ficha actual del cliente/);assert.match(html,/month=2026-10&amp;play=27/);
 assert.doesNotMatch(html,/Marcar contacto|Marcar respondió|Crear pedido|Abrir y registrar|Solicitar.*No aplica|<form/);
 assert.ok(f.calls.every(c=>!c.columns.includes('current_customer_difference_usd')));
});
test('current active plays retain the normal client workflow, not the historical route',async()=>{
 const rows=fixtureRows();
 const current={...rows.crm_plays[0],id:50,name:'Loyal noviembre',status:'active',starts_at:'2026-11-01T04:00:00Z',ends_at:'2026-12-01T03:59:59.999Z'};
 rows.crm_plays.push(current);rows.crm_play_members.push({...rows.crm_play_members[0],id:150,play_id:50,play:current});
 const html=await historyFixture(rows).renderList();
 assert.match(html,/Activa/);assert.match(html,/Loyal noviembre/);assert.match(html,/\/app\/advisor\/clients\/20\?playMember=150/);
 assert.doesNotMatch(html,/Histórica · solo consulta|\/history\/150/);
});
test('foreign or unpublished membership and forged ID fail closed before reading any history',async()=>{
 for(const id of ['103','102','999','1 OR 1=1']){
  const f=historyFixture();const html=await f.renderMember(id);
  assert.match(html,/No pudimos abrir|Participación no válida/);assert.doesNotMatch(html,/Cliente ajeno|Plan secreto|Propuesta enviada/);
  assert.ok(f.calls.every(c=>c.table==='crm_play_members'));
 }
});
test('pagination does not truncate older campaigns and fails closed on a later-page error',async()=>{
 const calls=[];const result=await model.readAdvisorPlayPages((a,b)=>{calls.push([a,b]);return Promise.resolve({data:a<400?Array.from({length:200},(_,i)=>a+i):[400],error:null});});
 assert.equal(result.data.length,401);assert.deepEqual(calls,[[0,199],[200,399],[400,599]]);
 const failed=await model.readAdvisorPlayPages(a=>Promise.resolve(a===0?{data:Array(200).fill(1),error:null}:{data:null,error:{message:'network'}}));
 assert.equal(failed.data.length,0);assert.equal(failed.error.message,'network');
});
