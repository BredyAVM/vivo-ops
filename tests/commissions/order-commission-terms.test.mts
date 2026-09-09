import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commissionTermsEqual,
  formatOrderCommissionTerms,
  parseOrderCommissionAdjustmentPayload,
  validateOrderCommissionTerms,
} from '../../src/lib/commissions/order-commission-terms.ts';

test('interpreta un ajuste administrativo de comisión por producto', () => {
  const parsed = parseOrderCommissionAdjustmentPayload({
    kind: 'order_commission_terms',
    action: 'set',
    commission_mode: 'fixed_item',
    commission_value: 4.5,
  });

  assert.deepEqual(parsed, {
    kind: 'order_commission_terms',
    action: 'set',
    terms: { mode: 'fixed_item', value: 4.5 },
  });
  assert.equal(formatOrderCommissionTerms(parsed!.terms!), '4.5% sobre este producto');
});

test('un borrado administrativo deja que vuelvan a aplicar los términos heredados', () => {
  assert.deepEqual(
    parseOrderCommissionAdjustmentPayload({
      kind: 'order_commission_terms',
      action: 'clear',
      commission_mode: 'fixed_item',
      commission_value: 5,
    }),
    {
      kind: 'order_commission_terms',
      action: 'clear',
      terms: null,
    }
  );
});

test('conserva compatibilidad con los términos comerciales de eventos', () => {
  assert.deepEqual(
    parseOrderCommissionAdjustmentPayload({
      kind: 'event_commercial_terms',
      commission_mode: 'fixed_order',
      commission_value: 7,
    }),
    {
      kind: 'event_commercial_terms',
      action: 'set',
      terms: { mode: 'fixed_order', value: 7 },
    }
  );
});

test('valida el porcentaje y compara términos sin depender del formato numérico', () => {
  assert.deepEqual(validateOrderCommissionTerms('none', null), { mode: 'none', value: null });
  assert.equal(
    commissionTermsEqual(
      validateOrderCommissionTerms('fixed_item', '5'),
      validateOrderCommissionTerms('fixed_item', 5)
    ),
    true
  );
  assert.throws(() => validateOrderCommissionTerms('fixed_item', null), /obligatorio/);
  assert.throws(() => validateOrderCommissionTerms('fixed_item', 101), /entre 0 y 100/);
});
