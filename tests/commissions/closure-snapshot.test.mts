import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVISOR_COMMISSION_FORMULA_VERSION,
  ADVISOR_COMMISSION_SNAPSHOT_VERSION,
  readAdvisorCommissionSettlementSnapshot,
  writeAdvisorCommissionSettlementSnapshot,
} from '../../src/lib/commissions/closure-snapshot.ts';
import { calculateAdvisorCommissionSettlement } from '../../src/lib/commissions/settlement-engine.ts';

test('enriquece el snapshot existente sin perder ordenes ni indicadores historicos', () => {
  const currentSnapshot = {
    version: 1,
    advisor: { id: 'advisor-1', name: 'Asesor' },
    orders: [{ orderId: 91, commissionUsd: 12.5 }],
    products: [{ productId: 7, qty: 2 }],
    totals: {
      billedUsd: 500,
      grossCommissionUsd: 99,
      customHistoricalIndicator: 4,
    },
  };
  const calculation = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: 63.6,
    grossCommissionUsd: 331.03,
    giftDeductionsUsd: 42.5,
    directDeductionsUsd: 71.33,
    outstandingCustomerDebtUsd: 0.01,
  });

  const snapshot = writeAdvisorCommissionSettlementSnapshot({
    currentSnapshot,
    calculation,
    calculationCutoffAt: '2026-08-07T16:00:00-04:00',
    scheduledLiquidationDate: '2026-08-07',
  });

  assert.equal(snapshot.version, ADVISOR_COMMISSION_SNAPSHOT_VERSION);
  assert.deepEqual(snapshot.orders, currentSnapshot.orders);
  assert.deepEqual(snapshot.products, currentSnapshot.products);
  assert.equal(snapshot.totals.billedUsd, 500);
  assert.equal(snapshot.totals.customHistoricalIndicator, 4);
  assert.equal(snapshot.totals.grossCommissionUsd, 331.03);
  assert.equal(snapshot.totals.giftDeductionsUsd, 42.5);
  assert.equal(snapshot.totals.manualDeductionsUsd, 71.33);
  assert.equal(snapshot.totals.pendingCollectionUsd, 0.01);
  assert.equal(snapshot.totals.payableUsd, 280.79);
  assert.deepEqual(snapshot.settlement, {
    formulaVersion: ADVISOR_COMMISSION_FORMULA_VERSION,
    calculationCutoffAt: '2026-08-07T20:00:00.000Z',
    scheduledLiquidationDate: '2026-08-07',
    carriedCommissionUsd: 63.6,
    priorAdvisorDebtUsd: 0,
    positiveAdjustmentsUsd: 0,
    negativeAdjustmentsUsd: 0,
    retainedCommissionUsd: 0.01,
    advisorDebtOutUsd: 0,
    uncoveredCustomerDebtUsd: 0,
  });
});

test('preserva metadatos de liquidacion ajenos al motor', () => {
  const calculation = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 100,
  });
  const snapshot = writeAdvisorCommissionSettlementSnapshot({
    currentSnapshot: {
      settlement: {
        administrativeNote: 'Conservar',
      },
    },
    calculation,
    calculationCutoffAt: '2026-08-01T12:00:00.000Z',
  });

  assert.equal(snapshot.settlement.administrativeNote, 'Conservar');
  assert.equal(snapshot.settlement.scheduledLiquidationDate, null);
});

test('lee snapshots historicos sin exigir campos nuevos', () => {
  const state = readAdvisorCommissionSettlementSnapshot({
    version: 1,
    totals: { payableUsd: 100 },
  });

  assert.deepEqual(state, {
    snapshotVersion: 1,
    formulaVersion: 'legacy',
    calculationCutoffAt: null,
    scheduledLiquidationDate: null,
    carriedCommissionUsd: 0,
    priorAdvisorDebtUsd: 0,
    positiveAdjustmentsUsd: 0,
    negativeAdjustmentsUsd: 0,
    retainedCommissionUsd: 0,
    advisorDebtOutUsd: 0,
    uncoveredCustomerDebtUsd: 0,
  });
});

test('rechaza fechas administrativas ambiguas', () => {
  const calculation = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 100,
  });

  assert.throws(
    () =>
      writeAdvisorCommissionSettlementSnapshot({
        currentSnapshot: {},
        calculation,
        calculationCutoffAt: 'sin-fecha',
      }),
    /calculationCutoffAt/
  );
  assert.throws(
    () =>
      writeAdvisorCommissionSettlementSnapshot({
        currentSnapshot: {},
        calculation,
        calculationCutoffAt: '2026-08-01T12:00:00.000Z',
        scheduledLiquidationDate: '01/08/2026',
      }),
    /scheduledLiquidationDate/
  );
});
