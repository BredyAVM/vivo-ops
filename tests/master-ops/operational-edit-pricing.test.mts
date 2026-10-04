import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { preservedOperationalSnapshot, requiresProtectedPriceAuthorization } from '../../src/lib/orders/operational-edit-pricing.ts';
import { hasUnauthorizedPriceChange, preservedApprovedPriceSnapshot, type ApprovedPriceLine } from '../../src/lib/orders/approved-price-preservation.ts';

const line: ApprovedPriceLine = { orderItemId: 1, productId: 30, qty: 2, sourcePriceCurrency: 'VES',
  sourcePriceAmount: 2300, adminPriceOverrideUsd: null, adminPriceOverrideReason: null,
  editableDetailLines: [], unitPriceUsdSnapshot: 2.64, lineTotalUsd: 5.28, unitPriceBsSnapshot: 2300, lineTotalBsSnapshot: 4600 };
test('fully paid orders permit product/quantity changes, not renegotiated commercial terms', () => {
  assert.equal(requiresProtectedPriceAuthorization({ isAdmin: false, isPriceProtected: true, commercialTermsChanged: false }), false);
  assert.equal(requiresProtectedPriceAuthorization({ isAdmin: false, isPriceProtected: true, commercialTermsChanged: true }), true);
});
test('quantity reduction preserves native Bs and agreed USD snapshots, irrespective of new catalog/rate', () => {
  assert.deepEqual(preservedOperationalSnapshot({ ...line, qty: 1 }, line), { unitUsd: 2.64, unitBs: 2300, lineUsd: 2.64, lineBs: 2300 });
  assert.deepEqual(preservedOperationalSnapshot({ ...line, qty: 3 }, line), { unitUsd: 2.64, unitBs: 2300, lineUsd: 7.92, lineBs: 6900 });
  assert.equal(preservedOperationalSnapshot({ ...line, productId: 40 }, line), null);
  assert.equal(preservedOperationalSnapshot({ ...line, sourcePriceAmount: 1 }, line), null);
});
test('unchanged lines retain exact historical totals, including rounding', () => {
  const historic = { ...line, lineTotalUsd: 5.27 };
  assert.equal(preservedOperationalSnapshot(historic, historic)?.lineUsd, 5.27);
});
test('approved unit terms can be retained with changed quantities or removed, never copied or repriced', () => {
  const approved = { ...line, adminPriceOverrideUsd: 2.64, adminPriceOverrideReason: 'Acuerdo original' };
  assert.equal(hasUnauthorizedPriceChange([], [approved], true), false);
  assert.equal(hasUnauthorizedPriceChange([{ ...approved, qty: 1 }], [approved], true), false);
  assert.equal(preservedApprovedPriceSnapshot({ ...approved, qty: 1 }, approved, true)?.lineBs, 2300);
  for (const patch of [{ productId: 40 }, { sourcePriceAmount: 1 }, { adminPriceOverrideUsd: 1 }, { orderItemId: null }])
    assert.equal(hasUnauthorizedPriceChange([{ ...approved, ...patch }], [approved], true), true);
});
test('CRM benefits and incomplete historical snapshots remain guarded', () => {
  const crm = { ...line, adminPriceOverrideUsd: 0, crmPlayMemberId: 1 };
  assert.equal(hasUnauthorizedPriceChange([], [crm], true), true);
  assert.equal(hasUnauthorizedPriceChange([{ ...crm, qty: 1 }], [crm], true), true);
  assert.equal(preservedOperationalSnapshot(line, { ...line, unitPriceBsSnapshot: null }), null);
});
test('Master UI/server and shared save apply the same operational preservation policy', () => {
  for (const path of ['src/app/app/master/ops/actions.ts', 'src/app/app/master/ops/MasterOpsOrderEditor.tsx', 'src/app/app/master/dashboard/actions.ts']) {
    const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    assert.match(source, /preservedOperationalSnapshot/);
    assert.match(source, /hasUnauthorizedPriceChange\([^\n]+true\)/);
  }
  const validation = readFileSync(new URL('../../src/app/app/master/ops/order-editor-validation.ts', import.meta.url), 'utf8');
  assert.match(validation, /requiresProtectedPriceAuthorization/);
});
