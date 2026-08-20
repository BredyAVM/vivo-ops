import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminCommissionAuditHref,
  buildAdminCommissionAuditCalculation,
  getAdminCommissionAuditSection,
  readAdminCommissionAuditSnapshot,
} from '../../src/lib/commissions/admin-audit.ts';

test('reads audit arrays without duplicating closure data', () => {
  const snapshot = readAdminCommissionAuditSnapshot({
    advisor: { name: '  Mariángela  ' },
    orders: [{ orderId: 10 }],
    pending_orders: [{ orderId: 11 }],
    products: [{ productName: 'Tequeño' }],
    gifts: [{ productName: 'Degustación' }],
    new_clients: [{ clientName: 'Cliente nuevo' }],
  });

  assert.equal(snapshot.advisorName, 'Mariángela');
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.pendingOrders[0]?.orderId, 11);
  assert.equal(snapshot.products[0]?.productName, 'Tequeño');
  assert.equal(snapshot.gifts[0]?.productName, 'Degustación');
  assert.equal(snapshot.newClients[0]?.clientName, 'Cliente nuevo');
});

test('reconstructs commission, settlement, deductions and payment balance', () => {
  const result = buildAdminCommissionAuditCalculation({
    closure: {
      billed_usd: 300,
      gross_commission_usd: 130,
      gift_deductions_usd: 10,
      manual_deductions_usd: 5,
      pending_collection_usd: 40,
      payable_usd: 95,
      snapshot: {
        version: 2,
        products: [
          {
            commissionMode: 'fixed_item',
            lineBaseUsd: 100,
            commissionValue: 15,
          },
        ],
        orders: [
          {
            billedUsd: 100,
            commissionMode: 'fixed_order',
            commissionUsd: 20,
            pendingUsd: 0,
          },
          {
            billedUsd: 200,
            commissionMode: 'mixed_items',
            commissionUsd: 110,
            pendingUsd: 40,
          },
        ],
        pending_orders: [{ pendingUsd: 40 }],
        gifts: [{ deductionUsd: 10 }],
        settlement: {
          formulaVersion: 'advisor-settlement-v1',
          carrySource: 'settlement',
          carriedCommissionUsd: 20,
          priorAdvisorDebtUsd: 0,
          positiveAdjustmentsUsd: 0,
          negativeAdjustmentsUsd: 0,
          retainedCommissionUsd: 40,
          advisorDebtOutUsd: 0,
          uncoveredCustomerDebtUsd: 0,
        },
      },
    },
    deductions: [{ deduction_type: 'manual', amount_usd: 5 }],
    payments: [{ amount_usd_equivalent: 60 }, { amount_usd_equivalent: 15 }],
  });

  assert.equal(result.specialItemsCommissionUsd, 15);
  assert.equal(result.specialOrdersCommissionUsd, 20);
  assert.equal(result.normalCommissionUsd, 95);
  assert.equal(result.recalculation.payableUsd, 95);
  assert.equal(result.payableDifferenceUsd, 0);
  assert.equal(result.registeredDirectDeductionsUsd, 5);
  assert.equal(result.directDeductionDifferenceUsd, 0);
  assert.equal(result.paidUsd, 75);
  assert.equal(result.paymentBalanceUsd, 20);
  assert.equal(result.perOrderBilledUsd, 300);
  assert.equal(result.billedDifferenceUsd, 0);
  assert.equal(result.commissionDifferenceUsd, 0);
  assert.equal(result.pendingCollectionDifferenceUsd, 0);
  assert.equal(result.giftDeductionDifferenceUsd, 0);
});

test('marks historical snapshots that did not preserve billing by order', () => {
  const result = buildAdminCommissionAuditCalculation({
    closure: { billed_usd: 100, snapshot: { orders: [{ totalUsd: 116 }] } },
    deductions: [],
    payments: [],
  });

  assert.equal(result.perOrderBilledUsd, null);
  assert.equal(result.billedDifferenceUsd, null);
});

test('validates admin audit section links', () => {
  assert.equal(getAdminCommissionAuditSection('debts'), 'debts');
  assert.equal(getAdminCommissionAuditSection('unknown'), 'settlement');
  assert.equal(
    adminCommissionAuditHref(134, 'commission'),
    '/app/commissions/134?section=commission#audit-detail'
  );
});
