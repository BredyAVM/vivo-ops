import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countedAdvisorNewClientType,
  isAdvisorCommercialOrder,
  summarizeAdvisorNewClients,
} from '../../src/lib/commissions/commercial-criteria.ts';

test('excluye de los cierres los pedidos cuyo monto a pagar es cero', () => {
  assert.equal(isAdvisorCommercialOrder(0), false);
  assert.equal(isAdvisorCommercialOrder('0.00'), false);
  assert.equal(isAdvisorCommercialOrder(0.004), false);
  assert.equal(isAdvisorCommercialOrder(0.01), true);
  assert.equal(isAdvisorCommercialOrder(35.46), true);
});

test('solo reconoce clientes nuevos propios y asignados', () => {
  assert.equal(countedAdvisorNewClientType('own'), 'own');
  assert.equal(countedAdvisorNewClientType('ASSIGNED'), 'assigned');
  assert.equal(countedAdvisorNewClientType('legacy'), null);
  assert.equal(countedAdvisorNewClientType(null), null);
});

test('muestra otras clasificaciones sin sumarlas como clientes nuevos', () => {
  const summary = summarizeAdvisorNewClients([
    { name: 'Propio 1', clientType: 'own' },
    { name: 'Propio 2', clientType: 'own' },
    { name: 'Asignado', clientType: 'assigned' },
    { name: 'Antiguo', clientType: 'legacy' },
  ]);

  assert.equal(summary.countedTotal, 3);
  assert.equal(summary.own.length, 2);
  assert.equal(summary.assigned.length, 1);
  assert.equal(summary.other.length, 1);
  assert.equal(summary.other[0].name, 'Antiguo');
});
