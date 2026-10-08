import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  commissionCalculationTimestamp, commissionCalculationTimeLabel,
  latestPreliminaryCalculation, commissionCalculationFeedback,
  type CommissionCalculationReading,
} from '../../src/lib/commissions/calculation-feedback.ts';

function row(input: Partial<CommissionCalculationReading> = {}): CommissionCalculationReading {
  return { advisor_user_id: 'ramon', status: 'preliminary', snapshot: {},
    generated_at: '2026-10-08T20:00:00Z', payable_usd: 13.98, pending_collection_usd: 85.18,
    ...input };
}
const next = (input: Partial<CommissionCalculationReading> = {}) => row({
  generated_at: '2026-10-08T21:00:00Z', ...input,
});

test('calculation date uses settlement cutoff, never an unrelated edit date', () => {
  const input = { ...row(), updated_at: '2026-10-09T00:00:00Z', snapshot: {
    settlement: { calculationCutoffAt: '2026-10-08T21:45:52.168Z' },
  } };
  assert.equal(commissionCalculationTimestamp(input), '2026-10-08T21:45:52.168Z');
});

test('legacy and malformed timestamps fall back to generated_at safely', () => {
  assert.equal(commissionCalculationTimestamp(row()), '2026-10-08T20:00:00.000Z');
  assert.equal(commissionCalculationTimestamp(row({ snapshot: { settlement: { calculationCutoffAt: 'bad' } } })), '2026-10-08T20:00:00.000Z');
  assert.equal(commissionCalculationTimestamp(row({ generated_at: 'bad' })), null);
  assert.equal(commissionCalculationTimeLabel(null), 'Sin cálculo registrado');
});

test('Caracas date/time is explicit and crosses midnight correctly', () => {
  const label = commissionCalculationTimeLabel('2026-10-09T01:45:52Z');
  assert.match(label, /08/);
  assert.match(label, /21:45:52/);
});

test('global timestamp is scoped to preliminary rows, not newer paid closures', () => {
  assert.equal(latestPreliminaryCalculation([row(), next({ status: 'paid' })]), '2026-10-08T20:00:00.000Z');
  assert.equal(latestPreliminaryCalculation([next({ status: 'closed' })]), null);
});

test('successful refresh with identical cents reports no monetary changes', () => {
  const result = commissionCalculationFeedback([row()], [next({ payable_usd: '13.9800001' })]);
  assert.equal(result.recalculated, 1);
  assert.equal(result.changed, 0);
  assert.equal(result.payableBefore, 13.98);
  assert.equal(result.payableAfter, 13.98);
});

test('released debt shows before and after without attributing it to a payment', () => {
  const result = commissionCalculationFeedback([row()], [next({ payable_usd: 24.69, pending_collection_usd: 74.47 })]);
  assert.deepEqual(result, { recalculated: 1, changed: 1, payableBefore: 13.98, payableAfter: 24.69,
    debtBefore: 85.18, debtAfter: 74.47 });
});

test('closed, paid and unchanged timestamps are not counted as recalculated', () => {
  for (const status of ['closed', 'paid']) {
    const result = commissionCalculationFeedback([row({ status })], [next({ status, payable_usd: 100 })]);
    assert.equal(result.recalculated, 0);
    assert.equal(result.changed, 0);
    assert.equal(result.payableAfter, 0);
  }
  assert.equal(commissionCalculationFeedback([row()], [row()]).recalculated, 0);
});

test('new preliminary is reported as changed; locked source never compared', () => {
  assert.equal(commissionCalculationFeedback([], [next()]).changed, 1);
  assert.equal(commissionCalculationFeedback([row({ status: 'paid' })], [next()]).recalculated, 0);
});

test('changes to rate, count and carried amounts are visible even with identical payable', () => {
  for (const input of [{ base_commission_pct: 9 }, { delivered_orders_count: 1 },
    { snapshot: { settlement: { carriedCommissionUsd: 3.88 } } }]) {
    assert.equal(commissionCalculationFeedback([row()], [next(input)]).changed, 1);
  }
});

test('pending button is nested in calculation form and disables duplicate submissions', () => {
  const page = readFileSync(new URL('../../src/app/app/commissions/page.tsx', import.meta.url), 'utf8');
  const button = readFileSync(new URL('../../src/app/app/commissions/CommissionCalculationButton.tsx', import.meta.url), 'utf8');
  assert.match(page, /action=\{calculateCommissionPeriodAction\}[\s\S]*?<CommissionCalculationButton[\s\S]*?<\/WorkspaceForm>/);
  assert.match(button, /useFormStatus\(\)/);
  assert.match(button, /disabled=\{disabled \|\| pending\}/);
  assert.match(button, /aria-live="polite"/);
  assert.match(page, /commissionCalculationTimestamp\(row.closure\)/);
});
