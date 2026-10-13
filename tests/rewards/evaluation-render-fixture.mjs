import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url);
export function compile(path,imports={}){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(output,{exports:module.exports,module,require:name=>name in imports?imports[name]:require(name),console,Intl,Date,URLSearchParams});
 return module.exports;
}
const goal=compile('../../src/lib/commissions/goal-engine.ts');
export const model=compile('../../src/lib/rewards/evaluation-model.ts',{'../commissions/goal-engine.ts':goal});
export const advisor='00000000-0000-0000-0000-000000000002';
export const link=({children,prefetch,...props})=>React.createElement('a',props,children);
export const input=()=>({period:'2026-09-01',rule_version:'awards-v2',calculated_at:'2026-10-13T12:00:00Z',ambiguous_clients:0,evidence_total:0,evidence:[],execution:{plays:[],counts:[],volume:[]},
 cohort_metrics:['alchemist','influential'].map(category=>({category,advisor_id:advisor,advisor_name:'Advisor',incorporation:13,return_pct:15,regularity_pct:20,repeat_orders:6,revenue:700,older_pool:10,older_returned:2,inferred_new:1})),
 strategic_metrics:[{advisor_id:advisor,advisor_name:'Advisor',current_active:11,prior_active:10,continuity_pct:40,dormant_60_180:10,reactivation_pct:12,multi_day_buyers_pct:30,current_orders:11,prior_orders:10,current_revenue:1100,prior_revenue:1000}],
 seasonal_samples:[2023,2024,2025].flatMap(year=>Array.from({length:4},()=>({year,previous_active:100,current_active:100,previous_orders:100,current_orders:100,previous_revenue:100,current_revenue:100}))),
});
