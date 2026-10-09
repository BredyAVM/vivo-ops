import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { preservedUnchangedPriceSnapshot } from '../../src/lib/orders/operational-edit-pricing.ts';
import type { ApprovedPriceLine } from '../../src/lib/orders/approved-price-preservation.ts';

const original: ApprovedPriceLine = {
  orderItemId: 42, productId: 9, qty: 3, sourcePriceCurrency: 'VES', sourcePriceAmount: 2300,
  adminPriceOverrideUsd: null, adminPriceOverrideReason: null, editableDetailLines: ['Sin hielo'],
  unitPriceUsdSnapshot: 2.76, lineTotalUsd: 8.29, unitPriceBsSnapshot: 2300, lineTotalBsSnapshot: 6900,
};
test('Admin, Master and Advisor use the same certified unchanged VES snapshots, not rounded USD × qty', () => {
  assert.deepEqual(preservedUnchangedPriceSnapshot({ ...original, unitPriceUsdSnapshot: 99, lineTotalUsd: 297 }, original),
    { unitUsd: 2.76, lineUsd: 8.29, unitBs: 2300, lineBs: 6900 });
});
test('ordinary composition/notes edits do not renegotiate prices', () => {
  assert.equal(preservedUnchangedPriceSnapshot({ ...original, editableDetailLines: ['Con hielo'] }, original)?.lineBs, 6900);
});
test('native USD keeps its original Bs equivalent instead of using a new daily rate', () => {
  const usd = { ...original, sourcePriceCurrency: 'USD', sourcePriceAmount: 14, unitPriceUsdSnapshot: 14,
    lineTotalUsd: 42, unitPriceBsSnapshot: 11654.86, lineTotalBsSnapshot: 34964.58 };
  assert.equal(preservedUnchangedPriceSnapshot(usd, usd)?.lineBs, 34964.58);
});
test('a real Admin price change, including zero, is not swallowed by preservation', () => {
  for (const patch of [{ sourcePriceAmount: 0 }, { adminPriceOverrideUsd: 0 }, { sourcePriceCurrency: 'USD' }])
    assert.equal(preservedUnchangedPriceSnapshot({ ...original, ...patch }, original), null);
});
test('an existing zero-price administrative agreement remains zero with its evidence', () => {
  const zero = { ...original, sourcePriceCurrency: 'USD', sourcePriceAmount: 0, adminPriceOverrideUsd: 0,
    adminPriceOverrideReason: 'Acuerdo previo', unitPriceUsdSnapshot: 0, lineTotalUsd: 0,
    unitPriceBsSnapshot: 0, lineTotalBsSnapshot: 0 };
  assert.deepEqual(preservedUnchangedPriceSnapshot(zero, zero), { unitUsd: 0, lineUsd: 0, unitBs: 0, lineBs: 0 });
  assert.equal(preservedUnchangedPriceSnapshot({ ...zero, adminPriceOverrideReason: 'Otro acuerdo' }, zero), null);
});
test('approval includes full composition, not just price/name', () => {
  const approved = { ...original, adminPriceOverrideUsd: 2.76, adminPriceOverrideReason: 'Autorizado' };
  assert.equal(preservedUnchangedPriceSnapshot({ ...approved, editableDetailLines: ['Otra preparación'] }, approved), null);
});
test('new, copied, replaced and increased/reduced rows do not inherit an unchanged-line entitlement', () => {
  for (const patch of [{ orderItemId: null }, { orderItemId: 51 }, { productId: 10 }, { qty: 4 }, { qty: 2 }])
    assert.equal(preservedUnchangedPriceSnapshot({ ...original, ...patch }, original), null);
  assert.equal(preservedUnchangedPriceSnapshot(original), null);
});
test('CRM continues through its canonical validation, never an ordinary price exception', () => {
  for (const patch of [{ crmPlayMemberId: 1 }, { crmPlayBenefitId: 1 }, { crmPlayBenefitUpgradeId: 1 }])
    assert.equal(preservedUnchangedPriceSnapshot({ ...original, ...patch }, { ...original, ...patch }), null);
});
test('missing/negative/non-finite historical snapshots fail closed, not fabricated as zero', () => {
  for (const patch of [{ unitPriceBsSnapshot: null }, { lineTotalBsSnapshot: Number.NaN },
    { lineTotalUsd: -1 }, { unitPriceUsdSnapshot: Number.POSITIVE_INFINITY }])
    assert.equal(preservedUnchangedPriceSnapshot(original, { ...original, ...patch }), null);
});
test('all shared edit entry points use persisted unchanged-line preservation', () => {
  for (const path of ['src/app/app/master/dashboard/actions.ts', 'src/app/app/master/ops/actions.ts',
    'src/app/app/master/ops/MasterOpsOrderEditor.tsx', 'src/app/app/advisor/new/actions.ts',
    'src/app/app/advisor/new/AdvisorOrderComposer.tsx']) {
    const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    assert.match(source, /preservedUnchangedPriceSnapshot/);
  }
});
