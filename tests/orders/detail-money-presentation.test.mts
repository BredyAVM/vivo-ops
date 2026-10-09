import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { orderDetailLineCurrency, orderDetailPrimaryCurrency, orderDetailLineBs, orderDetailCollectionSnapshot }
  from '../../src/lib/orders/detail-money-presentation.ts';

const usdLine = { pricingOriginCurrency: 'USD' as const, qty: 4, priceBs: 11500, lineTotalBs: 46000 };
const vesLine = { ...usdLine, pricingOriginCurrency: 'VES' as const };

test('USD items and fully paid USD orders show USD without using catalog, creation date or current FX', () => {
  assert.equal(orderDetailLineCurrency(usdLine), 'USD');
  assert.equal(orderDetailPrimaryCurrency([usdLine], 'closed'), 'USD');
  assert.equal(orderDetailPrimaryCurrency([usdLine], 'snapshot_quote'), 'USD');
});
test('old Bs items keep the actual agreed currency, including mixed orders with new USD additions', () => {
  assert.equal(orderDetailLineCurrency(vesLine, 'snapshot_quote'), 'VES');
  assert.equal(orderDetailLineCurrency(vesLine, 'post_delivery_usd'), 'VES');
  assert.equal(orderDetailPrimaryCurrency([vesLine, usdLine]), 'VES');
  assert.equal(orderDetailLineCurrency(usdLine, 'snapshot_quote'), 'USD');
});
test('only certified native USD mode overrides the item currency for display', () => {
  assert.equal(orderDetailLineCurrency(vesLine, 'native_usd'), 'USD');
  assert.equal(orderDetailPrimaryCurrency([vesLine], 'native_usd'), 'USD');
  assert.equal(orderDetailPrimaryCurrency([], 'native_usd'), 'USD');
});
test('missing historical currency does not guess from the current catalog or pretend to be a new sale', () => {
  const unknown = { qty: 1, priceBs: 11500 };
  assert.equal(orderDetailLineCurrency(unknown), 'VES');
  assert.equal(orderDetailPrimaryCurrency([unknown]), 'VES');
  assert.equal(orderDetailPrimaryCurrency([]), 'VES');
});
test('stored exact Bs line totals and free gifts survive unit rounding', () => {
  assert.equal(orderDetailLineBs({ ...vesLine, qty: 3, priceBs: 33.33, lineTotalBs: 100 }), 100);
  assert.equal(orderDetailLineBs({ ...vesLine, lineTotalBs: 0 }), 0);
  assert.equal(orderDetailLineBs({ qty: 4, priceBs: 11500 }), 46000);
});
test('native USD pending Bs is the certified outstanding balance, not the full total or budget FX', () => {
  const input = { pendingBs: 8100, paymentCollectionMode: 'native_usd', paymentStateOperationDate: '2026-10-09' };
  assert.deepEqual(orderDetailCollectionSnapshot(input, '2026-10-09'), {
    pendingBs: 8100, mode: 'native_usd', label: 'Por cobrar en Bs · tasa vigente', operationDate: '2026-10-09',
  });
  assert.equal(input.pendingBs, 8100);
});
test('Bs agreed quotations and old post-delivery collection are explicitly distinct', () => {
  const base = { pendingBs: 5175, paymentStateOperationDate: '2026-10-09' };
  assert.equal(orderDetailCollectionSnapshot({ ...base, paymentCollectionMode: 'snapshot_quote' })?.label, 'Por cobrar en Bs · monto acordado');
  assert.equal(orderDetailCollectionSnapshot({ ...base, paymentCollectionMode: 'post_delivery_usd' })?.label, 'Por cobrar en Bs · tasa vigente');
});
test('zero canonical balance remains zero and stale, unknown or invalid balances are not advertised', () => {
  assert.equal(orderDetailCollectionSnapshot({ pendingBs: 0, paymentCollectionMode: 'closed' })?.pendingBs, 0);
  for (const pendingBs of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(orderDetailCollectionSnapshot({ pendingBs, paymentCollectionMode: 'native_usd' }), null);
  }
  assert.equal(orderDetailCollectionSnapshot({ pendingBs: 10, paymentCollectionMode: 'unknown' }), null);
  assert.equal(orderDetailCollectionSnapshot({ pendingBs: 10, paymentCollectionMode: 'native_usd', paymentStateOperationDate: '2026-10-08' }, '2026-10-09'), null);
});
test('the common detail is used by Admin, Master and the old dashboard without new balance queries', () => {
  const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  for (const path of ['src/components/orders/OrdersWorkspaceClient.tsx', 'src/app/app/master/dashboard/MasterDashboardClient.tsx']) {
    assert.match(read(path), /<MasterOrderDetailBody/);
  }
  const core = read('src/app/app/master/_components/MasterOrderDetailCore.tsx');
  assert.match(core, /masterOrderLineText\(line, orderDetailLineCurrency\(line, order.paymentCollectionMode\)\)/);
  assert.match(core, /Tasa del presupuesto/);
  assert.doesNotMatch(core, /Tasa snapshot|\.rpc\(|\.from\(/);
  assert.match(core, /orderDetailCollectionSnapshot\(order\)/);
  const detail = read('src/app/app/master/ops/actions.ts');
  const projection = detail.slice(detail.indexOf('const loadOrderItems ='), detail.indexOf('const [', detail.indexOf('const loadOrderItems =')));
  assert.match(projection, /pricing_origin_currency/);
  assert.match(projection, /line_total_bs_snapshot/);
  const legacy = read('src/app/app/master/dashboard/page.tsx');
  assert.match(legacy, /pendingBs: financialState\?\.pending_bs/);
  assert.match(legacy, /paymentCollectionMode: financialState\?\.collection_mode/);
  const legacyUI = read('src/app/app/master/dashboard/MasterDashboardClient.tsx');
  assert.match(legacyUI, /if \(canonical\) return canonical.pendingBs/);
  assert.match(legacyUI, /paymentCollectionGuidance\(true, false\)/);
});
