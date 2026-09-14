import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliveryCostEstimate, estimateInternalDeliveryCost } from '../../src/lib/domain/delivery-cost.ts';
import { deliveryPaymentBatch, deliveryServiceTotals, parseDeliveryServices, servicePayable, deliveryServicesCsv, type DeliveryService } from '../../src/lib/admin-finance/delivery-services.ts';
import { deliveryPeriodHref, deliveryServiceFilters, deliveryWeekContaining, deliveryWeekShortcuts } from '../../src/lib/admin-finance/delivery-period.ts';
import { deliveryCombinedBatch, parseDeliveryExtras, deliveryExtrasCsv, type DeliveryExtra } from '../../src/lib/admin-finance/delivery-extras.ts';
const extra: DeliveryExtra = { id: '00000000-0000-4000-8000-000000000091', responsibleKey: 'external:91', responsible: 'Test company', date: '2026-09-10', concept: 'Test errand', amount: 10, paymentId: null, voided: false, voidReason: null, fingerprint: 'a'.repeat(32) };
test('extra-only and mixed settlements include exact responsible and unpaid services', () => {
  assert.equal(deliveryCombinedBatch([], [extra], extra.responsibleKey).total, 10);
  assert.equal(deliveryCombinedBatch([], [extra], extra.responsibleKey).error, '');
  const delivery = { ...row, mode: 'external' as const, responsibleKey: extra.responsibleKey };
  const batch = deliveryCombinedBatch([delivery], [extra, { ...extra, id: 'other', responsibleKey: 'external:92' }], extra.responsibleKey);
  assert.equal(batch.total, 12.5);
  assert.equal(batch.extras.length, 1);
  assert.equal(batch.error, '');
  assert.ok(deliveryCombinedBatch([], [{ ...extra, voided: true }], extra.responsibleKey).error);
  assert.ok(deliveryCombinedBatch([], [{ ...extra, paymentId: extra.id }], extra.responsibleKey).error);
  assert.ok(deliveryCombinedBatch([], [extra], '').error);
});
test('extra selection is explicit and cannot conceal invalid or missing order costs', () => {
  assert.equal(deliveryCombinedBatch([], [extra], extra.responsibleKey, [], [extra.id]).error, '');
  for (const ids of [[extra.id, extra.id], ['missing']]) assert.ok(deliveryCombinedBatch([], [extra], extra.responsibleKey, [], ids).error);
  assert.ok(deliveryCombinedBatch([], [extra], extra.responsibleKey, [999], [extra.id]).error);
  assert.ok(deliveryCombinedBatch([{ ...row, responsibleKey: extra.responsibleKey, cost: { ...row.cost, proposed: null } }], [extra], extra.responsibleKey).error);
  assert.equal(deliveryCombinedBatch([row], [extra], row.responsibleKey, [row.id], []).extras.length, 0);
  assert.match(deliveryCombinedBatch([], Array.from({ length: 501 }, (_, i) => ({ ...extra, id: String(i) })), extra.responsibleKey).error, /500/);
});
test('extra report fails closed on malformed amounts, dates, duplicates and unsafe state', () => {
  const envelope = { version: 1, from: '2026-09-07', to: '2026-09-13', rows: [extra], payees: [{ key: extra.responsibleKey, name: extra.responsible }] };
  assert.equal(parseDeliveryExtras(envelope, envelope.from, envelope.to).rows.length, 1);
  for (const invalid of [{ amount: NaN }, { amount: -1 }, { amount: 0.001 }, { date: '2026-09-14' }, { paymentId: 'bad' }, { paymentId: extra.id, voided: true }])
    assert.throws(() => parseDeliveryExtras({ ...envelope, rows: [{ ...extra, ...invalid }] }, envelope.from, envelope.to));
  assert.throws(() => parseDeliveryExtras({ ...envelope, rows: [extra, extra] }, envelope.from, envelope.to));
  assert.throws(() => parseDeliveryExtras(envelope, '2026-09-08', envelope.to));
  assert.match(deliveryExtrasCsv([{ ...extra, concept: '=SUM(1,2)' }]), /'\=SUM/);
});
const row: DeliveryService = { id: 1, orderNumber: 'TEST-1', client: 'Cliente', date: '2026-09-10', mode: 'internal', responsible: 'Driver', responsibleKey: 'internal:test', cost: { stored: null, proposed: 2.5, fingerprint: 'a'.repeat(32), reason: null }, payment: null, legacyPaid: false };
test('one-click period payment covers all pages for the exact responsible, excluding already paid services', () => {
  const fixtures = Array.from({ length: 39 }, (_, i) => ({ ...row, id: i + 1 }));
  fixtures.push({ ...row, id: 90, responsibleKey: 'internal:other' }, { ...row, id: 91, legacyPaid: true });
  const batch = deliveryPaymentBatch(fixtures, 'internal:test');
  assert.equal(batch.error, '');
  assert.equal(batch.rows.length, 39);
  assert.equal(batch.total, 97.5);
  assert.equal(batch.rows.at(-1)?.id, 39);
  assert.equal(deliveryPaymentBatch(fixtures, '').rows.length, 0);
  assert.ok(deliveryPaymentBatch(fixtures, '').error);
});
test('whole-period payment does not silently omit unknown costs or truncate more than 500 orders', () => {
  const missing = { ...row, id: 2, cost: { ...row.cost, proposed: null } };
  assert.match(deliveryPaymentBatch([row, missing], row.responsibleKey).error, /costos faltantes/);
  assert.equal(deliveryPaymentBatch([row, missing], row.responsibleKey, [1]).error, '');
  const large = deliveryPaymentBatch(Array.from({ length: 501 }, (_, i) => ({ ...row, id: i + 1 })), row.responsibleKey);
  assert.equal(large.rows.length, 501);
  assert.match(large.error, /500/);
});
test('optional partial selection cannot include paid, foreign, duplicate or unknown orders', () => {
  const paid = { ...row, id: 2, payment: { id: 'test', movementId: 12, amountUsd: 2.5, date: '2026-09-14', status: 'confirmed' } };
  const other = { ...row, id: 3, responsibleKey: 'external:other', mode: 'external' as const };
  for (const ids of [[2], [3], [4], [1, 1], []]) {
    assert.ok(deliveryPaymentBatch([row, paid, other], row.responsibleKey, ids).error);
  }
  assert.deepEqual(deliveryPaymentBatch([row, paid, other], row.responsibleKey).rows.map(r => r.id), [1]);
  assert.ok(deliveryPaymentBatch([{ ...row, cost: { ...row.cost, stored: 0 } }], row.responsibleKey).error);
  assert.equal(deliveryPaymentBatch([other], other.responsibleKey).error, '');
});
test('compact UI keeps period payment independent of search and the confirmation above the table', () => {
  const source = readFileSync(new URL('../../src/app/app/admin/finanzas/delivery/DeliveryServicesClient.tsx', import.meta.url), 'utf8');
  assert.match(source, /deliveryCombinedBatch\(modeRows, modeExtras, responsible\)/);
  assert.doesNotMatch(source, /deliveryCombinedBatch\(visible/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /Pagar período/);
  assert.match(source, /\{partial \? <th/);
  assert.ok(source.indexOf('<DeliveryPaymentForm') < source.indexOf('<table'));
  assert.doesNotMatch(source, /Seleccionar entregas sin pago vinculado|Propuesto|<AdminKpi/);
});
test('payment form retains retry identity, explicit tariff consent and the existing authenticated action', () => {
  const source = readFileSync(new URL('../../src/app/app/admin/finanzas/delivery/DeliveryPaymentForm.tsx', import.meta.url), 'utf8');
  assert.match(source, /attempt\.current\.payload !== payload/);
  assert.match(source, /submitting\.current = true/);
  assert.match(source, /recordDeliveryPayment\(requestId, input\)/);
  assert.match(source, /name="confirmTariffs" type="checkbox" required/);
  assert.match(source, /name="confirmedUnpaid" type="checkbox" required/);
  assert.match(source, /items: rows\.map/);
  assert.match(source, /No se pudo confirmar la respuesta/);
  assert.doesNotMatch(source, /\.from\(|service_role/);
});
test('weekly service view defaults to the last complete Monday-Sunday cycle in Caracas', () => {
  const filters = deliveryServiceFilters({}, new Date('2026-09-14T16:00:00Z'));
  assert.equal(filters.from, '2026-09-07');
  assert.equal(filters.to, '2026-09-13');
  // Still Sunday in Caracas: the current cycle is not complete yet.
  const sunday = deliveryServiceFilters({}, new Date('2026-09-14T02:00:00Z'));
  assert.equal(sunday.from, '2026-08-31');
  assert.equal(sunday.to, '2026-09-06');
});
test('weekly dates cover Sunday, year boundaries and leap days without inventing dates', () => {
  assert.deepEqual(deliveryWeekContaining('2026-09-13'), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(deliveryWeekContaining('2027-01-01'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(deliveryWeekContaining('2028-02-29'), { from: '2028-02-28', to: '2028-03-05' });
  assert.throws(() => deliveryWeekContaining('2026-02-29'));
});
test('weekly navigation preserves filters while custom dates and explicit periods remain supported', () => {
  const now = new Date('2026-09-14T16:00:00Z');
  const custom = deliveryServiceFilters({ from: '2026-09-01', to: '2026-09-10' }, now);
  assert.equal(custom.from, '2026-09-01');
  assert.equal(custom.to, '2026-09-10');
  assert.equal(deliveryServiceFilters({ period: 'month' }, now).from, '2026-09-01');
  const weeks = deliveryWeekShortcuts('2026-09-14', '2026-09-07', '2026-09-13');
  assert.equal(weeks.isWeekly, true);
  assert.deepEqual(weeks.previous, { from: '2026-08-31', to: '2026-09-06' });
  assert.deepEqual(weeks.next, weeks.current);
  assert.equal(deliveryWeekShortcuts('2026-09-14', custom.from, custom.to).isWeekly, false);
  const url = new URL(deliveryPeriodHref(weeks.previous, { mode: 'external', responsible: 'external:test', query: 'Empresa & prueba' }), 'https://example.test');
  assert.equal(url.searchParams.get('responsible'), 'external:test');
  assert.equal(url.searchParams.get('q'), 'Empresa & prueba');
  assert.equal(url.searchParams.get('from'), '2026-08-31');
});
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
