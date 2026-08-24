import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdvisorGoalPaymentCompletionDates,
  calculateAdvisorGoalCollectionSummary,
} from '../../src/lib/commissions/goal-collection.ts';

const orders = [
  { orderId: 1, deliveryDate: '2026-08-10', totalUsd: 100, confirmedPaidUsd: 100, pendingUsd: 0 },
  { orderId: 2, deliveryDate: '2026-08-10', totalUsd: 80, confirmedPaidUsd: 80, pendingUsd: 0 },
  { orderId: 3, deliveryDate: '2026-08-10', totalUsd: 50, confirmedPaidUsd: 0, pendingUsd: 50 },
];

test('usa la fecha de registro del pago completo y no la fecha bancaria', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders,
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 40 },
      { orderId: 1, registeredDate: '2026-08-12', amountUsd: 60 },
      { orderId: 2, registeredDate: '2026-08-16', amountUsd: 80 },
    ],
  });

  assert.equal(completed.get(1), '2026-08-12');
  assert.equal(completed.get(2), '2026-08-16');
  assert.equal(completed.has(3), false);
});

test('una devolución posterior invalida la fecha anterior de pago completo', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders: [orders[0]],
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 100 },
      { orderId: 1, registeredDate: '2026-08-11', amountUsd: -20 },
      { orderId: 1, registeredDate: '2026-08-13', amountUsd: 20 },
    ],
  });

  assert.equal(completed.get(1), '2026-08-13');
});

test('resume puntual, crédito de cinco días y atraso en una sola relación', () => {
  const summary = calculateAdvisorGoalCollectionSummary({
    orders,
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 100 },
      { orderId: 2, registeredDate: '2026-08-15', amountUsd: 80 },
    ],
    asOfDate: '2026-08-20',
  });

  assert.equal(summary.ratio, 0.6);
  assert.equal(summary.punctualCount, 1);
  assert.equal(summary.creditCount, 1);
  assert.equal(summary.overdueCount, 1);
});
