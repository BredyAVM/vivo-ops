import test from 'node:test';
import assert from 'node:assert/strict';
import { clientCommercialTypeLabel, isClientCommercialType, isSalesChannel, salesChannelLabel } from '../../src/lib/clients/commercial-classification.ts';
import { countedAdvisorNewClientType } from '../../src/lib/commissions/commercial-criteria.ts';

test('client relationship and observed channel remain independent of brand, operator and delivery', () => {
  assert.equal(clientCommercialTypeLabel('direct'), 'Directo del negocio');
  assert.equal(clientCommercialTypeLabel('legacy'), 'Antiguo');
  assert.equal(clientCommercialTypeLabel(null), 'Sin clasificar');
  for (const v of ['own', 'assigned', 'direct', 'legacy']) assert.equal(isClientCommercialType(v), true);
  for (const v of ['in_person', 'whatsapp', 'advisor']) assert.equal(isSalesChannel(v), true);
  for (const v of ['instagram', 'muerdeme', 'vivo', 'pickup', 'delivery', 'counter', '', null]) assert.equal(isSalesChannel(v), false);
  assert.equal(salesChannelLabel(null), 'Sin registrar');
  assert.equal(salesChannelLabel('whatsapp'), 'WhatsApp');
});
test('direct and historical clients cannot accidentally count as new own or assigned advisor clients', () => {
  assert.equal(countedAdvisorNewClientType('direct'), null);
  assert.equal(countedAdvisorNewClientType('legacy'), null);
  assert.equal(countedAdvisorNewClientType('own'), 'own');
  assert.equal(countedAdvisorNewClientType('assigned'), 'assigned');
});
