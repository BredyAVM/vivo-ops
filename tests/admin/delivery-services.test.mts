import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliveryCostEstimate, estimateInternalDeliveryCost } from '../../src/lib/domain/delivery-cost.ts';
import { deliveryServiceTotals, parseDeliveryServices, servicePayable, deliveryServicesCsv, type DeliveryService } from '../../src/lib/admin-finance/delivery-services.ts';
const row: DeliveryService = { id: 1, orderNumber: 'TEST-1', client: 'Cliente', date: '2026-09-10', mode: 'internal', responsible: 'Driver', responsibleKey: 'internal:test', cost: { stored: null, proposed: 2.5, fingerprint: 'a'.repeat(32), reason: null }, payment: null, legacyPaid: false };
test('table and export use the canonical short order number, never the stored long reference', () => {
  const fixture = { ...row, id: 2565, orderNumber: 'VO-LONG-REFERENCE' };
  const parsed = parseDeliveryServices({ version: 1, from: '2026-09-07', to: '2026-09-13', rows: [fixture] }, '2026-09-07', '2026-09-13');
  assert.equal(parsed[0].orderNumber, '2565');
  assert.match(deliveryServicesCsv([fixture]), /"2565"/);
  assert.doesNotMatch(deliveryServicesCsv([fixture]), /VO-LONG-REFERENCE/);
});
test('all three legacy delivery tables show the labelled cost proposal', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/MasterDashboardClient.tsx', import.meta.url), 'utf8');
  assert.equal((source.match(/row\.costAvailable \?/g) ?? []).length, 3);
  assert.doesNotMatch(source, /row\.costRecorded \? fmtUSD\(row\.costUsd\)/);
});
test('internal estimation distinguishes missing, explicit zero, invalid quantity and multiple zones', () => {
  assert.equal(estimateInternalDeliveryCost([]), null);
  assert.equal(estimateInternalDeliveryCost([{ qty: 1, rate: null, isDelivery: true }]), null);
  assert.equal(estimateInternalDeliveryCost([{ qty: 1, rate: 0, isDelivery: true }]), 0);
  assert.equal(estimateInternalDeliveryCost([{ qty: 0, rate: 2, isDelivery: true }]), null);
  assert.equal(estimateInternalDeliveryCost([{ qty: 2, rate: 1.8, isDelivery: true }, { qty: 1, rate: 2.5, isDelivery: true }]), 6.1);
});
test('legacy fallback is labelled and never replaces a stored zero or applies internal tariffs externally', () => {
  assert.deepEqual(deliveryCostEstimate(null, 'internal', 2.5), { amount: 2.5, estimated: true });
  assert.deepEqual(deliveryCostEstimate(0, 'internal', 2.5), { amount: 0, estimated: false });
  assert.deepEqual(deliveryCostEstimate(null, 'external', 2.5), { amount: null, estimated: false });
});
test('totals use all selected rows, preserve partial coverage and do not call unlinked costs debt', () => {
  const rows = Array.from({ length: 39 }, (_, i) => ({ ...row, id: i + 1 }));
  assert.equal(deliveryServiceTotals(rows).amount, 97.5);
  assert.equal(deliveryServiceTotals(rows).proposed, 39);
  assert.equal(deliveryServiceTotals([{ ...row, cost: { ...row.cost, proposed: null } }]).missing, 1);
});
test('linked historical amount wins over a changed catalog and paid rows are not payable', () => {
  const paid = { ...row, cost: { ...row.cost, proposed: 99 }, payment: { id: 'test', movementId: 12, amountUsd: 2.5, date: '2026-09-14', status: 'confirmed' } };
  assert.equal(deliveryServiceTotals([paid]).amount, 2.5);
  assert.equal(deliveryServiceTotals([paid]).unlinked, 0);
  assert.equal(servicePayable(paid), false);
  assert.equal(servicePayable({ ...row, legacyPaid: true }), false);
});
test('read contract rejects invalid amounts, duplicate orders and out-of-period rows', () => {
  const parse = (rows: unknown[]) => parseDeliveryServices({ version: 1, from: '2026-09-07', to: '2026-09-13', rows }, '2026-09-07', '2026-09-13');
  assert.equal(parse([row]).length, 1);
  assert.throws(() => parse([row, row]));
  assert.throws(() => parse([{ ...row, date: '2026-09-14' }]));
  assert.throws(() => parse([{ ...row, cost: { ...row.cost, stored: -1 } }]));
});
test('export includes all filtered rows, quotes text and protects spreadsheet formulas', () => {
  const csv = deliveryServicesCsv([{ ...row, client: '=SUM(1)' }, { ...row, id: 2, client: 'A;"B"' }]);
  assert.match(csv, /'=SUM\(1\)/); assert.match(csv, /A;""B""/);
  assert.equal(csv.split('\r\n').length, 3);
});
