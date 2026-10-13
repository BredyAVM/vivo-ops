import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAwards, awardValue, type EvaluationInput } from '../../src/lib/rewards/evaluation-model.ts';
const input = (): EvaluationInput => ({
 period:'2026-09-01',calculated_at:'2026-10-13T12:00:00Z',rule_version:'awards-preview-v1',ambiguous_clients:0,evidence_total:0,evidence:[],
 seasonal_samples:[2023,2024,2025].flatMap(year=>Array.from({length:4},()=>({year,previous_active:100,current_active:100,previous_orders:100,current_orders:100,previous_revenue:100,current_revenue:100}))),
 cohort_metrics: ['alchemist','influential'].map(category=>({advisor_id:'a',advisor_name:'A',category,incorporation:category==='alchemist'?13:7,return_pct:15,regularity_pct:20,repeat_orders:6,revenue:700,older_pool:10,inferred_new:0,older_returned:2})) as EvaluationInput['cohort_metrics'],
 strategic_metrics:[{advisor_id:'a',advisor_name:'A',current_active:11,prior_active:10,continuity_pct:40,dormant_60_180:10,reactivation_pct:12,multi_day_buyers_pct:30,current_orders:11,prior_orders:10,current_revenue:1100,prior_revenue:1000}],
});
test('targets score 100, one qualified category is enough, ties explicit and weights renormalized',()=>{
 const d=input();const r=evaluateAwards(d);assert.equal(r.advisors[0].total,100);assert.equal(r.advisors[0].qualified,true);
 d.cohort_metrics.forEach(row=>{if(row.category==='influential')row.older_pool=0;});d.strategic_metrics[0].dormant_60_180=0;
 const one=evaluateAwards(d);assert.equal(one.advisors[0].qualifiedCategories,1);assert.equal(one.advisors[0].qualified,true);
 const clone={...d.strategic_metrics[0],advisor_id:'b',advisor_name:'B'};d.strategic_metrics.push(clone);d.cohort_metrics.push(...d.cohort_metrics.map(c=>({...c,advisor_id:'b',advisor_name:'B'})));
 assert.equal(evaluateAwards(d).leaders.length,2);
});
test('high score never bypasses sample or mandatory gates, cap at each weight, no rounding qualification',()=>{
 const d=input();d.cohort_metrics.forEach(c=>{c.incorporation=1000;c.older_pool=0;});d.strategic_metrics[0].current_revenue=800;
 const r=evaluateAwards(d).advisors[0];assert.equal(r.categories.alchemist.score,100);assert.equal(r.categories.alchemist.qualified,false);
 assert.equal(r.categories.strategic.qualified,false);assert.ok(r.categories.strategic.failures.some(f=>f.includes('90%')));
 d.cohort_metrics[0]={...d.cohort_metrics[0],incorporation:0,older_pool:10,revenue:699.999};
 const almost=evaluateAwards(d).advisors[0].categories.alchemist;assert.ok(almost.score<80);assert.equal(almost.score.toFixed(2),'80.00');assert.equal(almost.qualified,false);
});
test('missing seasonality disables strategic globally, no invented zeros or incomplete rows',()=>{
 const d=input();d.seasonal_samples=[];const r=evaluateAwards(d);assert.equal(r.seasonalReliable,false);assert.equal(r.advisors[0].categories.strategic.available,false);assert.equal(r.advisors[0].total,100);
 d.cohort_metrics=[];assert.throws(()=>evaluateAwards(d),/Faltan/);
 const broken=input();delete broken.strategic_metrics[0].prior_active;assert.throws(()=>evaluateAwards(broken),/Indicador inválido/);
 assert.equal(awardValue(null,'percent'),'Sin base');assert.equal(awardValue(1.1,'ratio'),'110%');
});
