import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateAdvisorCommissionSettlement } from '../../src/lib/commissions/settlement-engine.ts';

function assertReconciled(
  result: ReturnType<typeof calculateAdvisorCommissionSettlement>
) {
  assert.equal(
    result.creditBeforeDeductionsUsd,
    result.deductionsAppliedUsd
      + result.payableUsd
      + result.retainedCommissionUsd
  );
  assert.equal(
    result.requestedDeductionsUsd,
    result.deductionsAppliedUsd + result.advisorDebtOutUsd
  );
  assert.equal(
    result.outstandingCustomerDebtUsd,
    result.retainedCommissionUsd + result.uncoveredCustomerDebtUsd
  );
}

test('paga todo el credito cuando no existen deducibles ni deuda de clientes', () => {
  const result = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 200,
  });

  assert.equal(result.payableUsd, 200);
  assert.equal(result.retainedCommissionUsd, 0);
  assertReconciled(result);
});

test('aplica primero los deducibles y despues retiene el saldo del cliente', () => {
  const result = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 200,
    giftDeductionsUsd: 10,
    directDeductionsUsd: 15,
    outstandingCustomerDebtUsd: 50,
  });

  assert.equal(result.deductionsAppliedUsd, 25);
  assert.equal(result.retainedCommissionUsd, 50);
  assert.equal(result.payableUsd, 125);
  assertReconciled(result);
});

test('retiene todo el credito disponible cuando la deuda del cliente es mayor', () => {
  const result = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 200,
    outstandingCustomerDebtUsd: 300,
  });

  assert.equal(result.payableUsd, 0);
  assert.equal(result.retainedCommissionUsd, 200);
  assert.equal(result.uncoveredCustomerDebtUsd, 100);
  assertReconciled(result);
});

test('mantiene la retencion al pasar al periodo siguiente si la deuda continua', () => {
  const result = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: 50,
    grossCommissionUsd: 200,
    outstandingCustomerDebtUsd: 50,
  });

  assert.equal(result.payableUsd, 200);
  assert.equal(result.retainedCommissionUsd, 50);
  assertReconciled(result);
});

test('libera la comision arrastrada en una liquidacion con ventas en cero', () => {
  const result = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: 32.94,
    grossCommissionUsd: 0,
    outstandingCustomerDebtUsd: 0,
  });

  assert.equal(result.payableUsd, 32.94);
  assert.equal(result.retainedCommissionUsd, 0);
  assertReconciled(result);
});

test('arrastra deducibles que exceden el credito disponible', () => {
  const result = calculateAdvisorCommissionSettlement({
    priorAdvisorDebtUsd: 30,
    grossCommissionUsd: 50,
    directDeductionsUsd: 40,
    outstandingCustomerDebtUsd: 25,
  });

  assert.equal(result.deductionsAppliedUsd, 50);
  assert.equal(result.advisorDebtOutUsd, 20);
  assert.equal(result.retainedCommissionUsd, 0);
  assert.equal(result.uncoveredCustomerDebtUsd, 25);
  assertReconciled(result);
});

test('reproduce la proyeccion auditada de Ramon para Julio 2', () => {
  const result = calculateAdvisorCommissionSettlement({
    grossCommissionUsd: 262.33,
    giftDeductionsUsd: 60,
    directDeductionsUsd: 141.47,
    outstandingCustomerDebtUsd: 26.94,
  });

  assert.equal(result.payableUsd, 33.92);
  assert.equal(result.retainedCommissionUsd, 26.94);
  assertReconciled(result);
});

test('reproduce la liberacion auditada de Yujanir para Julio 2', () => {
  const result = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: 63.6,
    grossCommissionUsd: 331.03,
    giftDeductionsUsd: 42.5,
    directDeductionsUsd: 71.33,
    outstandingCustomerDebtUsd: 0.01,
  });

  assert.equal(result.payableUsd, 280.79);
  assert.equal(result.retainedCommissionUsd, 0.01);
  assertReconciled(result);
});

test('redondea cada entrada monetaria a centavos antes de calcular', () => {
  const result = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: 0.004,
    grossCommissionUsd: 10.005,
    directDeductionsUsd: 0.004,
  });

  assert.equal(result.grossCommissionUsd, 10.01);
  assert.equal(result.payableUsd, 10.01);
  assertReconciled(result);
});

test('rechaza montos negativos o no finitos', () => {
  assert.throws(
    () => calculateAdvisorCommissionSettlement({ grossCommissionUsd: -1 }),
    /grossCommissionUsd/
  );
  assert.throws(
    () => calculateAdvisorCommissionSettlement({ grossCommissionUsd: Number.NaN }),
    /grossCommissionUsd/
  );
});
