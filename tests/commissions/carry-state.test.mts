import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAdvisorCommissionCarryState,
  readAdvisorCommissionCarryOverride,
  writeAdvisorCommissionCarryOverride,
} from '../../src/lib/commissions/carry-state.ts';

test('lee el arrastre explicito de un snapshot de liquidacion', () => {
  const state = getAdvisorCommissionCarryState({
    snapshot: {
      version: 2,
      settlement: {
        formulaVersion: 'advisor-settlement-v1',
        retainedCommissionUsd: 50,
        advisorDebtOutUsd: 12.5,
      },
    },
    grossCommissionUsd: 200,
    giftDeductionsUsd: 0,
    directDeductionsUsd: 0,
    pendingCollectionUsd: 0,
  });

  assert.deepEqual(state, {
    commissionCarryUsd: 50,
    advisorDebtCarryUsd: 12.5,
    source: 'settlement',
  });
});

test('infiere una comision retenida desde un cierre historico', () => {
  const state = getAdvisorCommissionCarryState({
    snapshot: { version: 1 },
    grossCommissionUsd: 200,
    giftDeductionsUsd: 10,
    directDeductionsUsd: 15,
    pendingCollectionUsd: 50,
  });

  assert.deepEqual(state, {
    commissionCarryUsd: 50,
    advisorDebtCarryUsd: 0,
    source: 'legacy-inferred',
  });
});

test('infiere deuda propia cuando los deducibles superan la comision', () => {
  const state = getAdvisorCommissionCarryState({
    snapshot: null,
    grossCommissionUsd: 30,
    giftDeductionsUsd: 5,
    directDeductionsUsd: 45,
    pendingCollectionUsd: 25,
  });

  assert.deepEqual(state, {
    commissionCarryUsd: 0,
    advisorDebtCarryUsd: 20,
    source: 'legacy-inferred',
  });
});

test('no fabrica arrastre si un cierre historico ya libero todo su credito', () => {
  const state = getAdvisorCommissionCarryState({
    snapshot: {},
    grossCommissionUsd: 100,
    giftDeductionsUsd: 10,
    directDeductionsUsd: 5,
    pendingCollectionUsd: 0,
  });

  assert.deepEqual(state, {
    commissionCarryUsd: 0,
    advisorDebtCarryUsd: 0,
    source: 'legacy-inferred',
  });
});

test('guarda un saldo inicial auditado sin crear columnas nuevas', () => {
  const snapshot = writeAdvisorCommissionCarryOverride({
    snapshot: { version: 1, orders: [{ orderId: 91 }] },
    commissionCarryUsd: 63.6,
    advisorDebtCarryUsd: 0,
    note: 'Saldo validado contra Junio 2',
    recordedAt: '2026-08-14T10:00:00-04:00',
    recordedByUserId: 'admin-1',
  });

  assert.deepEqual(snapshot.orders, [{ orderId: 91 }]);
  assert.deepEqual(readAdvisorCommissionCarryOverride(snapshot), {
    commissionCarryUsd: 63.6,
    advisorDebtCarryUsd: 0,
    note: 'Saldo validado contra Junio 2',
    recordedAt: '2026-08-14T14:00:00.000Z',
    recordedByUserId: 'admin-1',
  });
});

test('rechaza saldos iniciales negativos', () => {
  assert.throws(
    () =>
      writeAdvisorCommissionCarryOverride({
        snapshot: {},
        commissionCarryUsd: -1,
        advisorDebtCarryUsd: 0,
        note: 'Inválido',
        recordedAt: '2026-08-14T14:00:00.000Z',
        recordedByUserId: 'admin-1',
      }),
    /saldos iniciales/
  );
});
