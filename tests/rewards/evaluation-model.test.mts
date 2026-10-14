import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAwards, awardValue, defaultAwardRules, deliveryTargetsForDays, validateAwardPeriodRules, type EvaluationInput } from '../../src/lib/rewards/evaluation-model.ts';
const input = (): EvaluationInput => ({
 period:'2026-09-01',calculated_at:'2026-10-13T12:00:00Z',rule_version:'awards-preview-v1',ambiguous_clients:0,evidence_total:0,evidence:[],
 seasonal_samples:[2023,2024,2025].flatMap(year=>Array.from({length:4},()=>({year,previous_active:100,current_active:100,previous_orders:100,current_orders:100,previous_revenue:100,current_revenue:100}))),
 cohort_metrics: ['alchemist','influential'].map(category=>({advisor_id:'a',advisor_name:'A',category,incorporation:category==='alchemist'?13:7,return_pct:15,regularity_pct:20,repeat_orders:6,revenue:700,older_pool:10,inferred_new:0,older_returned:2})) as EvaluationInput['cohort_metrics'],
 strategic_metrics:[{advisor_id:'a',advisor_name:'A',current_active:11,prior_active:10,continuity_pct:40,dormant_60_180:10,reactivation_pct:12,multi_day_buyers_pct:30,current_orders:11,prior_orders:10,current_revenue:1100,prior_revenue:1000}],
});
test('executor is balanced by rates and unique client volume; temporal targets affect delivery only',()=>{
 const d=input();d.rule_version='awards-v2';d.period='2026-10-01';
 const count={advisor_id:'a',advisor_name:'A',play_id:27,assigned:100,contact:90,response:70,proposal:70,delivered:20};
 d.execution={plays:[{id:27,name:'Example',available_days:20}],counts:[count],volume:[{advisor_id:'a',proposal_clients:30}]};
 const rules={globalMinimum:80,executorEnabled:true,executorReason:'',deliveryTargets:{'27':20}};
 const r=evaluateAwards(d,rules);assert.equal(r.executorAvailable,true);assert.equal(r.advisors[0].categories.executor.score,100);
 assert.equal(r.effectiveWeights.executor,25);assert.equal(r.advisors[0].qualified,true);
 const harder=evaluateAwards(d,{...rules,deliveryTargets:{'27':40}}).advisors[0].categories.executor;
 assert.equal(harder.score,84);assert.deepEqual(harder.indicators.slice(0,3),r.advisors[0].categories.executor.indicators.slice(0,3));
 d.execution.volume[0].proposal_clients=3;assert.equal(evaluateAwards(d,rules).advisors[0].categories.executor.score,82); // small-volume rates alone do not get 100
 assert.equal(evaluateAwards(d,{...rules,deliveryTargets:{}}).executorAvailable,false);
 d.period='2026-09-01';assert.equal(evaluateAwards(d,rules).executorAvailable,false);
 assert.ok(evaluateAwards(d,defaultAwardRules(d.period)).advisors[0].categories.executor.minimums.length>0);
});
test('targets score 100, one qualified category is enough, ties explicit and weights renormalized',()=>{
 const d=input();const r=evaluateAwards(d);assert.equal(r.advisors[0].total,100);assert.equal(r.advisors[0].qualified,true);
 d.cohort_metrics.forEach(row=>{if(row.category==='influential')row.older_pool=0;});d.strategic_metrics[0].dormant_60_180=0;
 const one=evaluateAwards(d);assert.equal(one.advisors[0].qualifiedCategories,1);assert.equal(one.advisors[0].qualified,true);
 const clone={...d.strategic_metrics[0],advisor_id:'b',advisor_name:'B'};d.strategic_metrics.push(clone);d.cohort_metrics.push(...d.cohort_metrics.map(c=>({...c,advisor_id:'b',advisor_name:'B'})));
 assert.equal(evaluateAwards(d).leaders.length,2);
});
test('contact reference 80 preserves legacy 90 and does not change proposal, response, delivery or qualification gates',()=>{
 const d=input();d.rule_version='awards-v2';d.period='2026-10-01';
 d.execution={plays:[{id:27,name:'Short campaign',available_days:10}],counts:[{advisor_id:'a',advisor_name:'A',play_id:27,assigned:100,contact:80,response:70,proposal:70,delivered:20}],volume:[{advisor_id:'a',proposal_clients:30}]};
 const legacy={globalMinimum:80,executorEnabled:true,executorReason:'',deliveryTargets:{'27':20}};
 const old=evaluateAwards(d,legacy).advisors[0].categories.executor;
 const current=evaluateAwards(d,{...legacy,contactTargetPct:80}).advisors[0].categories.executor;
 assert.equal(current.indicators[0].points,8);assert.equal(current.score,100);assert.equal(old.indicators[0].target,90);
 assert.deepEqual(current.indicators.slice(1),old.indicators.slice(1));
 d.execution.counts[0].contact=60;assert.equal(evaluateAwards(d,{...legacy,contactTargetPct:80}).advisors[0].categories.executor.indicators[0].points,6);
 assert.equal(evaluateAwards(d,{...legacy,contactTargetPct:80}).advisors[0].categories.executor.qualified,false);
 assert.equal(defaultAwardRules('2026-10').contactTargetPct,80);
});
test('delivery day references only change delivery and September inclusion needs explicit acceptance',()=>{
 assert.deepEqual(deliveryTargetsForDays([{id:18,available_days:23},{id:24,available_days:20},{id:26,available_days:9},{id:25,available_days:8}],40),{'18':30.6667,'24':26.6667,'26':12,'25':10.6667});
 assert.throws(()=>deliveryTargetsForDays([{id:1,available_days:0}],40));assert.throws(()=>deliveryTargetsForDays([],0));
 const d=input();d.rule_version='awards-v2';d.execution={plays:[{id:27,name:'September',available_days:15}],counts:[{advisor_id:'a',advisor_name:'A',play_id:27,assigned:100,contact:80,response:70,proposal:70,delivered:20}],volume:[{advisor_id:'a',proposal_clients:30}]};
 const rules={...defaultAwardRules('2026-09'),executorEnabled:true,deliveryTargets:deliveryTargetsForDays(d.execution.plays,40)};
 assert.equal(evaluateAwards(d,rules).executorAvailable,false);assert.ok(validateAwardPeriodRules(d.period,rules)?.includes('Septiembre'));
 const accepted={...rules,executorReviewNote:'Aceptamos los registros disponibles y dejamos constancia de sus limitaciones.'};
 assert.equal(validateAwardPeriodRules(d.period,accepted),null);assert.equal(evaluateAwards(d,accepted).advisors[0].categories.executor.score,100);
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
