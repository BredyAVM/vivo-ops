import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryDeductionPlan, parseDeliveryDebts, type DeliveryDebt } from '../../src/lib/admin-finance/delivery-debts.ts';
const debt: DeliveryDebt = { id: '00000000-0000-4000-8000-000000000001', responsibleKey: 'external:1', responsible: 'Test', date: '2026-09-01',
  kind: 'loan', concept: 'Test loan', original: 60, balance: 60, balancePrecise: 60, deducted: 0, orderId: null, client: null, voided: false, voidReason: null, fingerprint: 'a'.repeat(32), history: [] };
test('100 earned, 60 owed, choose 20: pay 80 and carry 40', () => {
  const p = deliveryDeductionPlan([debt], { [debt.id]: '20' }, 100);
  assert.equal(p.net, 80); assert.equal(p.remaining, 40); assert.equal(p.discount, 20); assert.equal(p.error, '');
});
test('zero is optional, not an automatic debt sweep', () => {
  for (const v of ['', '0', '0.00']) { const p = deliveryDeductionPlan([debt], { [debt.id]: v }, 100); assert.equal(p.net, 100); assert.equal(p.remaining, 60); assert.deepEqual(p.deductions, []); }
});
test('zero payout leaves remaining debt without negative cash', () => {
  const p = deliveryDeductionPlan([debt], { [debt.id]: '25' }, 25); assert.equal(p.net, 0); assert.equal(p.remaining, 35); assert.equal(p.error, '');
});
test('reject excess, fractions, NaN, unknown and voided debts', () => {
  for (const v of ['-1', '60.01', '0.001', 'NaN', 'Infinity']) assert.ok(deliveryDeductionPlan([debt], { [debt.id]: v }, 100).error);
  assert.ok(deliveryDeductionPlan([debt], { [debt.id]: '26' }, 25).error);
  assert.ok(deliveryDeductionPlan([debt], { wrong: '10' }, 100).error);
  assert.ok(deliveryDeductionPlan([{ ...debt, voided: true }], { [debt.id]: '10' }, 100).error);
});
test('cent sums are stable for several debts', () => {
  const second = { ...debt, id: '00000000-0000-4000-8000-000000000002', balance: .2, balancePrecise: .2 };
  const p = deliveryDeductionPlan([{ ...debt, balance: .1, balancePrecise: .1 }, second], { [debt.id]: '.1', [second.id]: '.2' }, .3);
  assert.equal(p.discount, .3); assert.equal(p.net, 0); assert.equal(p.remaining, 0);
});
test('purchase residual below a cent closes, exact cent remains', () => {
  assert.equal(deliveryDeductionPlan([{ ...debt, balance: 2.62, balancePrecise: 2.619 }], { [debt.id]: '2.61' }, 3).remaining, 0);
  assert.equal(deliveryDeductionPlan([{ ...debt, balance: 2.62, balancePrecise: 2.62 }], { [debt.id]: '2.61' }, 3).remaining, .01);
});
test('debt parser retains prior-week debt and rejects malformed, future and duplicate rows', () => {
  const data = { version: 1, to: '2026-09-13', rows: [debt] };
  assert.equal(parseDeliveryDebts(data, data.to)[0].date, '2026-09-01');
  for (const rows of [[debt, debt], [{ ...debt, date: '2026-09-14' }], [{ ...debt, balance: -1 }], [{ ...debt, kind: 'order', orderId: null }]])
    assert.throws(() => parseDeliveryDebts({ ...data, rows }, data.to));
});
