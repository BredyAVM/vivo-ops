import assert from 'node:assert/strict';
import test from 'node:test';

import {
  crmPlayDetailLine,
  isCrmOnlyCatalogProduct,
  isInternalOrderDetailLine,
  isPlayOrderAvailableAt,
} from '../../src/lib/crm/play-order.ts';

const now = new Date('2026-09-09T16:00:00.000Z');

test('allows order benefits only while an active play is inside its window', () => {
  assert.equal(isPlayOrderAvailableAt({ status: 'active', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', now }), true);
  assert.equal(isPlayOrderAvailableAt({ status: 'paused', startsAt: null, endsAt: null, now }), false);
  assert.equal(isPlayOrderAvailableAt({ status: 'active', startsAt: '2026-09-10T00:00:00Z', endsAt: null, now }), false);
  assert.equal(isPlayOrderAvailableAt({ status: 'active', startsAt: null, endsAt: '2026-09-09T16:00:00Z', now }), false);
});

test('recognizes configuration and CRM metadata as internal order details', () => {
  assert.equal(isInternalOrderDetailLine('@sel|15|6'), true);
  assert.equal(isInternalOrderDetailLine('@crm|play:Aniversario'), true);
  assert.equal(isInternalOrderDetailLine('Para: Gloria'), false);
});

test('normalizes internal CRM metadata to a single safe line', () => {
  assert.equal(
    crmPlayDetailLine('play', 'Aniversario\nseptiembre|interno'),
    '@crm|play:Aniversario septiembre interno',
  );
});

test('keeps regular products searchable and reserves Gambit products for CRM', () => {
  assert.equal(isCrmOnlyCatalogProduct({ type: 'gambit', extra_fields: {} }), true);
  assert.equal(
    isCrmOnlyCatalogProduct({ type: 'combo', extra_fields: { catalog_access_scope: 'crm_only' } }),
    true,
  );
  assert.equal(isCrmOnlyCatalogProduct({ type: 'combo', extra_fields: {} }), false);
});
