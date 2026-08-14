import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdvisorCommissionCarryState } from '../../src/lib/commissions/carry-state.ts';

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
    payableUsd: 150,
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
    payableUsd: 125,
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
    payableUsd: -20,
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
    payableUsd: 85,
  });

  assert.deepEqual(state, {
    commissionCarryUsd: 0,
    advisorDebtCarryUsd: 0,
    source: 'legacy-inferred',
  });
});
