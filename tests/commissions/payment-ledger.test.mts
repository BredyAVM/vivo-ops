import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdvisorCommissionPaymentDescription,
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
