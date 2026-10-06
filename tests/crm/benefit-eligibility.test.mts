import test from 'node:test';
import assert from 'node:assert/strict';
import { countsTowardCrmMinimum, dailyBenefitConflict } from '../../src/lib/crm/benefit-eligibility.ts';

test('paid food counts; delivery, the gift and the upgrade difference do not', () => {
  assert.equal(countsTowardCrmMinimum({ productName: 'Food', lineUsd: 8 }), true);
  for (const line of [
    { productName: 'Delivery Zona 1', lineUsd: 2 },
    { sku: 'PROMO_DEL_Z1', lineUsd: 2 },
    { productName: 'Gift', isCrmBenefit: true, lineUsd: 0 },
    { productName: 'Pack 8', isCrmBenefit: true, lineUsd: 2 },
    { productName: 'Free discretionary gift', lineUsd: 0 },
  ]) assert.equal(countsTowardCrmMinimum(line), false);
});
test('same-day reservation blocks a second order, not editing the original or another day', () => {
  const uses = [{ day: '2026-10-06', orderId: 100 }];
  assert.equal(dailyBenefitConflict(uses,'2026-10-06')?.orderId,100);
  assert.equal(dailyBenefitConflict(uses,'2026-10-06',100),null);
  assert.equal(dailyBenefitConflict(uses,'2026-10-07'),null);
});
