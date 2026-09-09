import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommercialSummary,
  buildTreasurySummary,
  type FinancialMovementRow,
} from '../../src/lib/admin-finance/model.ts';
import { buildAdminFinancePeriod } from '../../src/lib/admin-finance/period.ts';

const period = buildAdminFinancePeriod('today', new Date('2026-09-08T16:00:00.000Z'));

test('separates delivered commercial sales from contractual tax and scheduled pipeline', () => {
  const summary = buildCommercialSummary({
    period,
    deliveredEvents: [
      { order_id: 101, created_at: '2026-09-08T14:00:00.000Z' },
      { order_id: 101, created_at: '2026-09-08T15:00:00.000Z' },
      { order_id: 102, created_at: '2026-09-07T14:00:00.000Z' },
    ],
    deliveredOrders: [
      {
        id: 101,
        total_usd: 116,
        extra_fields: {
          pricing: {
            subtotal_after_discount_usd: 100,
            invoice_tax_amount_usd: 16,
            total_usd: 116,
          },
        },
      },
      {
        id: 102,
        total_usd: 58,
        extra_fields: {
          pricing: {
            subtotal_after_discount_usd: 50,
            invoice_tax_amount_usd: 8,
            total_usd: 58,
          },
        },
      },
    ],
    scheduledOrders: [
      {
        id: 103,
        total_usd: 232,
        extra_fields: {
          pricing: {
            subtotal_after_discount_usd: 200,
            invoice_tax_amount_usd: 32,
            total_usd: 232,
          },
        },
      },
      {
        id: 104,
        total_usd: 116,
        queued_needs_reapproval: true,
        extra_fields: {
          pricing: {
            subtotal_after_discount_usd: 100,
            invoice_tax_amount_usd: 16,
            total_usd: 116,
          },
        },
      },
    ],
  });

  assert.equal(summary.deliveredOrders, 1);
  assert.equal(summary.deliveredSalesUsd, 100);
  assert.equal(summary.previousDeliveredOrders, 1);
  assert.equal(summary.previousDeliveredSalesUsd, 50);
  assert.equal(summary.deliveredSalesChangePct, 100);
  assert.equal(summary.scheduledOrders, 1);
  assert.equal(summary.scheduledSalesUsd, 200);
  assert.equal(summary.blockedScheduledOrders, 1);
  assert.equal(summary.quality, 'Q1_exact');
  assert.deepEqual(summary.series, [{ dateKey: '2026-09-08', salesUsd: 100 }]);
});

test('excludes both principal legs of an internal transfer while retaining its fee', () => {
  const confirmedMovements: FinancialMovementRow[] = [
    {
      id: 1,
      movement_date: '2026-09-08',
      direction: 'outflow',
      movement_type: 'withdrawal',
      amount_usd_equivalent: 100,
      movement_group_id: 'transfer-1',
    },
    {
      id: 2,
      movement_date: '2026-09-08',
      direction: 'inflow',
      movement_type: 'other_income',
      amount_usd_equivalent: 100,
      movement_group_id: 'transfer-1',
    },
    {
      id: 3,
      movement_date: '2026-09-08',
      direction: 'outflow',
      movement_type: 'fee_charge',
      amount_usd_equivalent: 2,
      movement_group_id: 'transfer-1',
    },
    {
      id: 4,
      movement_date: '2026-09-08',
      direction: 'inflow',
      movement_type: 'order_payment',
      amount_usd_equivalent: 50,
      movement_group_id: null,
    },
    {
      id: 5,
      movement_date: '2026-09-08',
      direction: 'outflow',
      movement_type: 'expense_payment',
      amount_usd_equivalent: 10,
      movement_group_id: null,
    },
  ];

  const summary = buildTreasurySummary({
    period,
    confirmedMovements,
    pendingPaymentReports: [],
    pendingMovements: [],
  });

  assert.equal(summary.confirmedCollectionsUsd, 50);
  assert.equal(summary.otherExternalIncomeUsd, 0);
  assert.equal(summary.externalOutflowsUsd, 12);
  assert.equal(summary.netExternalCashFlowUsd, 38);
  assert.equal(summary.internalTransferGroupsExcluded, 1);
  assert.equal(summary.derivedWithdrawalCount, 0);
  assert.equal(summary.netCashFlowQuality, 'Q1_exact');
});

test('blocks net external cash flow when an adjustment lacks financial classification', () => {
  const summary = buildTreasurySummary({
    period,
    confirmedMovements: [
      {
        id: 10,
        movement_date: '2026-09-08',
        direction: 'inflow',
        movement_type: 'order_payment',
        amount_usd_equivalent: 50,
        movement_group_id: null,
      },
      {
        id: 11,
        movement_date: '2026-09-08',
        direction: 'outflow',
        movement_type: 'adjustment',
        amount_usd_equivalent: 7,
        movement_group_id: null,
      },
    ],
    pendingPaymentReports: [],
    pendingMovements: [],
  });

  assert.equal(summary.confirmedCollectionsUsd, 50);
  assert.equal(summary.netExternalCashFlowUsd, null, 'an unknown net result must not become zero');
  assert.equal(summary.netCashFlowQuality, 'Q4_blocked');
  assert.equal(summary.outflowQuality, 'Q3_incomplete');
  assert.equal(summary.unclassifiedAdjustmentCount, 1);
  assert.equal(summary.unclassifiedAdjustmentUsd, 7);
});

test('rejects a confirmed movement without a USD equivalent instead of converting it to zero', () => {
  assert.throws(
    () =>
      buildTreasurySummary({
        period,
        confirmedMovements: [
          {
            id: 12,
            movement_date: '2026-09-08',
            direction: 'inflow',
            movement_type: 'order_payment',
            amount_usd_equivalent: null,
            movement_group_id: null,
          },
        ],
        pendingPaymentReports: [],
        pendingMovements: [],
      }),
    /no tiene equivalente USD/
  );
});

test('excludes an internal transfer but blocks its net when the USD legs do not reconcile', () => {
  const summary = buildTreasurySummary({
    period,
    confirmedMovements: [
      {
        id: 20,
        movement_date: '2026-09-08',
        direction: 'outflow',
        movement_type: 'withdrawal',
        amount_usd_equivalent: 100,
        movement_group_id: 'transfer-fx-gap',
        description: 'Traspaso salida · POS a banco',
      },
      {
        id: 21,
        movement_date: '2026-09-08',
        direction: 'inflow',
        movement_type: 'other_income',
        amount_usd_equivalent: 96,
        movement_group_id: 'transfer-fx-gap',
        description: 'Traspaso entrada · POS a banco',
      },
    ],
    pendingPaymentReports: [],
    pendingMovements: [],
  });

  assert.equal(summary.otherExternalIncomeUsd, 0);
  assert.equal(summary.externalOutflowsUsd, 0);
  assert.equal(summary.internalTransferGroupsExcluded, 1);
  assert.equal(summary.incompleteTransferGroups, 1);
  assert.equal(summary.netExternalCashFlowUsd, null);
  assert.equal(summary.netCashFlowQuality, 'Q4_blocked');
});
