import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historicalQuantityAddition, preservedAgreedPriceSnapshot } from '../../src/lib/orders/operational-edit-pricing.ts';
const previous = { orderItemId: 1, productId: 5, qty: 4, sourcePriceCurrency: 'VES', sourcePriceAmount: 11500,
  adminPriceOverrideUsd: null, adminPriceOverrideReason: null, editableDetailLines: [],
  unitPriceUsdSnapshot: 13.15, lineTotalUsd: 52.59, unitPriceBsSnapshot: 11500, lineTotalBsSnapshot: 46000 };
test('the same SKU separates only additional units at a different current native price', () => {
  assert.equal(historicalQuantityAddition(previous,6,{sourcePriceCurrency:'USD',sourcePriceAmount:14}),2);
  assert.equal(historicalQuantityAddition(previous,4,{sourcePriceCurrency:'USD',sourcePriceAmount:14}),0);
  assert.equal(historicalQuantityAddition(previous,2,{sourcePriceCurrency:'USD',sourcePriceAmount:14}),0);
  assert.equal(historicalQuantityAddition(previous,6,{sourcePriceCurrency:'VES',sourcePriceAmount:11500}),0);
});

test('typing a multi-digit quantity does not split intermediate keystrokes', () => {
  const source=readFileSync(new URL('../../src/app/app/master/ops/MasterOpsOrderEditor.tsx',import.meta.url),'utf8');
  const input=source.slice(source.indexOf('function OrderQuantityInput'),source.indexOf('type ClientSearchResult'));
  assert.match(input,/onChange=\{event => setText\(event.target.value\)\}/);
  assert.match(input,/onBlur=\{\(\) =>[\s\S]*onCommit\(text\)/);
  assert.match(input,/event.currentTarget.blur\(\)/);
  assert.equal(historicalQuantityAddition(previous,100,{sourcePriceCurrency:'USD',sourcePriceAmount:14}),96);
});
test('a reduction preserves the native VES amount with full-line conversion at the original rate', () => {
  assert.deepEqual(preservedAgreedPriceSnapshot({...previous,qty:3},previous,874.73),
    {unitUsd:13.15,lineUsd:39.44,unitBs:11500,lineBs:34500});
  assert.equal(preservedAgreedPriceSnapshot({...previous,qty:5},previous,874.73),null);
});
test('certified per-line FX takes precedence over later header rates', () => {
  assert.equal(preservedAgreedPriceSnapshot({...previous,qty:3},{...previous,pricingFxRateSnapshot:874.73},900)?.lineUsd,39.44);
});
test('copy, new override, CRM or a new native price cannot reuse a reduction agreement', () => {
  for(const change of [{orderItemId:null},{productId:6},{sourcePriceAmount:14},{adminPriceOverrideUsd:1},
    {crmPlayMemberId:1},{crmPlayBenefitId:1},{qty:0},{qty:Number.NaN}])
    assert.equal(preservedAgreedPriceSnapshot({...previous,qty:3,...change},previous,874.73),null);
});
test('zero and explicitly approved USD prices remain usable without extending approval to extra units', () => {
  const zero={...previous,sourcePriceCurrency:'USD',sourcePriceAmount:0,adminPriceOverrideUsd:0,
    adminPriceOverrideReason:'Cortesía autorizada',unitPriceUsdSnapshot:0,lineTotalUsd:0,unitPriceBsSnapshot:0,lineTotalBsSnapshot:0};
  assert.equal(preservedAgreedPriceSnapshot({...zero,qty:2},zero,900)?.lineUsd,0);
  assert.equal(preservedAgreedPriceSnapshot({...zero,qty:5},zero,900),null);
});
