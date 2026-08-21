import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdvisorCommissionBankFeeDescription,
  buildAdvisorCommissionPaymentDescription,
  calculateAdvisorCommissionPaymentOperation,
  getAdvisorCommissionClosureIdFromPaymentDescription,
} from '../../src/lib/commissions/payment-ledger.ts';

test('vincula un abono con su cierre usando una descripción legible', () => {
  const description = buildAdvisorCommissionPaymentDescription({
    closureId: 42,
    periodName: 'Agosto 1',
    advisorName: 'Ana Pérez',
  });

  assert.equal(
    description,
    'Liquidación de comisión · Cierre 42 · Agosto 1 · Ana Pérez'
  );
  assert.equal(getAdvisorCommissionClosureIdFromPaymentDescription(description), 42);
});

test('no confunde egresos ordinarios con pagos de comisión', () => {
  assert.equal(
    getAdvisorCommissionClosureIdFromPaymentDescription('Compra de insumos'),
    null
  );
  assert.equal(
    getAdvisorCommissionClosureIdFromPaymentDescription(
      'Liquidación de comisión · Cierre inválido · Agosto 1 · Ana'
    ),
    null
  );
});

test('convierte el abono a bolívares sin sumar la comisión bancaria al pago del asesor', () => {
  const operation = calculateAdvisorCommissionPaymentOperation({
    amountUsd: 100,
    feeAmountNative: 38.65,
    currencyCode: 'VES',
    exchangeRateVesPerUsd: 773,
  });

  assert.deepEqual(operation, {
    paymentUsd: 100,
    paymentNativeAmount: 77300,
    bankFeeNativeAmount: 38.65,
    bankFeeUsdEquivalent: 0.05,
    totalNativeAmount: 77338.65,
    totalUsdOutflow: 100.05,
  });
});

test('mantiene el abono y la comisión en dólares cuando la cuenta es USD', () => {
  const operation = calculateAdvisorCommissionPaymentOperation({
    amountUsd: 100,
    feeAmountNative: 2.5,
    currencyCode: 'USD',
  });

  assert.equal(operation.paymentNativeAmount, 100);
  assert.equal(operation.bankFeeUsdEquivalent, 2.5);
  assert.equal(operation.totalNativeAmount, 102.5);
});

test('construye una descripción auditable para la comisión bancaria', () => {
  const paymentDescription = buildAdvisorCommissionPaymentDescription({
    closureId: 42,
    periodName: 'Agosto 1',
    advisorName: 'Ana Pérez',
  });

  assert.equal(
    buildAdvisorCommissionBankFeeDescription(paymentDescription),
    'Comisión bancaria · Liquidación de comisión · Cierre 42 · Agosto 1 · Ana Pérez'
  );
});
