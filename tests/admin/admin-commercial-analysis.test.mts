import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analysisFilters,validateAnalysisPeriod,analysisOrderDate,buildAnalysisRows,summarizeAnalysis,estimateAnalysisCommission,type AnalysisOrder} from '../../src/lib/admin-finance/commercial-analysis-model.ts';
const filters=analysisFilters({from:'2026-09-07',to:'2026-09-13'});
const order:AnalysisOrder={id:1,status:'delivered',client_id:5,created_by_user_id:'admin',attributed_advisor_id:'advisor',created_at:'2026-09-08T02:00:00Z',source:'advisor',fulfillment:'delivery',total_usd:116,extra_fields:{schedule:{date:'2026-09-09'},pricing:{subtotal_usd:125,subtotal_after_discount_usd:100,invoice_tax_amount_usd:16,total_usd:116}}};
test('period, percentage and person validation reject unsafe or incomplete queries',()=>{
 assert.throws(()=>validateAnalysisPeriod(analysisFilters({})));
 assert.throws(()=>analysisFilters({from:'2026-02-30'}));
 assert.throws(()=>analysisFilters({person:'x),role.eq.admin'}));
 assert.throws(()=>analysisFilters({basePct:'Infinity'}));
 assert.throws(()=>validateAnalysisPeriod(analysisFilters({from:'2023-01-01',to:'2026-01-01'})));
 assert.equal(filters.details,'none');assert.equal(filters.source,'all');
});
test('scheduled and created dates use Caracas day, never UTC midnight',()=>{
 assert.equal(analysisOrderDate(order,'scheduled'),'2026-09-09');
 assert.equal(analysisOrderDate(order,'created'),'2026-09-07');
 assert.equal(analysisOrderDate({...order,extra_fields:{}},'scheduled'),'2026-09-07');
});
test('commercial net excludes tax while current paid and pending remain financial totals',()=>{
 const rows=buildAnalysisRows([order],[{order_id:1,total_usd:116,confirmed_paid_usd:80,pending_usd:36}],filters,new Map([['advisor','Asesora']]),new Map([[5,'Cliente']]));
 assert.equal(rows[0].netUsd,100);assert.equal(rows[0].paidUsd,80);assert.equal(rows[0].pendingUsd,36);
 assert.equal(rows[0].personName,'Asesora');assert.deepEqual(summarizeAnalysis(rows),{closures:1,netUsd:100,paidUsd:80,pendingUsd:36,averageUsd:100});
});
test('missing or invalid financial data never appears as zero or a partial total',()=>{
 assert.throws(()=>buildAnalysisRows([order],[],filters,new Map(),new Map()));
 assert.throws(()=>buildAnalysisRows([order],[{order_id:1,total_usd:116,confirmed_paid_usd:NaN,pending_usd:36}],filters,new Map(),new Map()));
});
test('cancelled, unfulfilled and zero-gift orders do not create commercial closures',()=>{
 const rows=buildAnalysisRows([{...order,status:'cancelled'},{...order,status:'queued'},{...order,total_usd:0}],[],filters,new Map(),new Map());
 assert.equal(rows.length,0);assert.equal(summarizeAnalysis(rows).closures,0);
});
test('estimated commissions preserve discounts, fixed-item, fixed-order and no-commission rules',()=>{
 assert.equal(estimateAnalysisCommission(order,[{baseUsd:125,terms:{mode:'default',value:null}}],10),10);
 assert.equal(estimateAnalysisCommission(order,[{baseUsd:125,terms:{mode:'fixed_item',value:20}}],10),20);
 assert.equal(estimateAnalysisCommission(order,[{baseUsd:125,terms:{mode:'none',value:null}}],10),0);
 assert.equal(estimateAnalysisCommission(order,[{baseUsd:125,terms:{mode:'fixed_order',value:15}}],10),15);
});
test('commercial detail is opt-in, bounded and separated from canonical collection writes',()=>{
 const s=readFileSync('src/lib/admin-finance/commercial-analysis-data.ts','utf8');
 assert.match(s,/if\(!requested\)return null/);assert.match(s,/filters.details==='payments'/);assert.match(s,/filters.details==='clients'/);assert.match(s,/filters.details==='commissions'/);
 assert.match(s,/rows.length>=1000/);assert.doesNotMatch(s,/\.insert\(|\.update\(|service_role/);
 const ui=readFileSync('src/app/app/admin/analisis/page.tsx','utf8');
 assert.doesNotMatch(ui,/order_number/);assert.match(ui,/No se pudo verificar|No se pudo/);
});
