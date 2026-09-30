import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { hasUnauthorizedPriceChange, preservedApprovedPriceSnapshot, storedApprovedPriceLine } from '../../src/lib/orders/approved-price-preservation.ts';

const approved = storedApprovedPriceLine({
  id: 10, product_id: 5, qty: .5, pricing_origin_currency: 'USD', pricing_origin_amount: 0,
  admin_price_override_usd: 0, admin_price_override_reason: 'Autorizado por Admin',
  notes: 'Empaque separado\n@sel|5|6', unit_price_usd_snapshot: 0, line_total_usd: 0,
  unit_price_bs_snapshot: 0, line_total_bs_snapshot: 0,
});
test('zero-price approval is retained, including its original snapshots', () => {
  assert.deepEqual(preservedApprovedPriceSnapshot(approved, approved), { unitUsd: 0, lineUsd: 0, unitBs: 0, lineBs: 0 });
  assert.equal(hasUnauthorizedPriceChange([approved], [approved]), false);
});
test('unchanged VES approval uses stored USD and Bs, not current FX or client totals', () => {
  const ves = { ...approved, sourcePriceCurrency: 'VES', sourcePriceAmount: 2012.5, qty: 2,
    adminPriceOverrideUsd: 2.3458718483721688, unitPriceUsdSnapshot: .7, lineTotalUsd: 1.4,
    unitPriceBsSnapshot: 2012.5, lineTotalBsSnapshot: 4025 };
  assert.deepEqual(preservedApprovedPriceSnapshot({ ...ves, lineTotalUsd: 999 }, ves),
    { unitUsd: .7, lineUsd: 1.4, unitBs: 2012.5, lineBs: 4025 });
});
test('Master can add a normal delivery line without granting a new special price', () => {
  const delivery = { ...approved, orderItemId: null, productId: 70, qty: 1,
    sourcePriceAmount: 3, adminPriceOverrideUsd: null, adminPriceOverrideReason: null };
  assert.equal(hasUnauthorizedPriceChange([approved, delivery], [approved]), false);
});
test('new, copied, removed or modified approved lines still require Administration', () => {
  for (const patch of [
    { orderItemId: null }, { orderItemId: 11 }, { productId: 6 }, { qty: 1 },
    { sourcePriceCurrency: 'VES' }, { sourcePriceAmount: 1 }, { adminPriceOverrideUsd: 1 },
    { adminPriceOverrideUsd: null }, { adminPriceOverrideReason: 'Nuevo motivo' },
    { crmPlayMemberId: 1 }, { editableDetailLines: ['Otra composición'] },
  ]) assert.equal(hasUnauthorizedPriceChange([{ ...approved, ...patch }], [approved]), true, JSON.stringify(patch));
  assert.equal(hasUnauthorizedPriceChange([], [approved]), true);
  assert.equal(hasUnauthorizedPriceChange([approved], []), true);
});
test('serialization order is harmless but duplicate composition is not', () => {
  assert.ok(preservedApprovedPriceSnapshot({ ...approved, editableDetailLines: [' @sel|5|6 ', 'Empaque separado'] }, approved));
  assert.equal(preservedApprovedPriceSnapshot({ ...approved, editableDetailLines: [...approved.editableDetailLines, '@sel|5|6'] }, approved), null);
});
test('missing historical snapshots fail closed instead of inventing Bs from USD', () => {
  assert.equal(preservedApprovedPriceSnapshot(approved, { ...approved, lineTotalBsSnapshot: null }), null);
});
test('shared update re-reads approvals before changing the client and uses canonical snapshots', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const update = source.slice(source.indexOf('export async function updateOrderAction('));
  assert.ok(update.indexOf('hasUnauthorizedPriceChange') < update.indexOf('let clientId = input.selectedClientId'));
  assert.match(update, /preservedPriceById\.get\(Number\(item\.orderItemId\)\) \?\? calculateOrderLineSnapshot/);
  assert.match(update, /preservedPriceById\.has\(Number\(item\.orderItemId\)\)/);
});
