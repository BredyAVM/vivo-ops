import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeliveredCommissionItem, validateDeliveredCommissionChanges } from '../../src/lib/commissions/delivered-order-commission.ts';

const catalog = { mode: 'fixed_item' as const, value: 5 };
const event = { kind: 'event_commercial_terms', commission_mode: 'fixed_order', commission_value: 7 };

test('delivered editor follows canonical admin > event > dated catalog precedence', () => {
  const row = resolveDeliveredCommissionItem(catalog, [
    { kind: 'order_commission_terms', action: 'set', commission_mode: 'fixed_item', commission_value: 4 }, event,
  ]);
  assert.deepEqual(row.effective, { mode: 'fixed_item', value: 4 });
  assert.deepEqual(row.inherited, { mode: 'fixed_order', value: 7 });
});

test('clear restores event or catalog, never an older admin override', () => {
  const clear = { kind: 'order_commission_terms', action: 'clear' };
  const old = { kind: 'order_commission_terms', action: 'set', commission_mode: 'none' };
  assert.deepEqual(resolveDeliveredCommissionItem(catalog, [clear, old, event]).effective, { mode: 'fixed_order', value: 7 });
  assert.deepEqual(resolveDeliveredCommissionItem(catalog, [clear, old]).effective, catalog);
});

test('keeps explicit zero and default separate from inherited policy', () => {
  for (const mode of ['none', 'default', 'fixed_item']) {
    const row = resolveDeliveredCommissionItem(catalog, [{ kind: 'order_commission_terms', action: 'set', commission_mode: mode, commission_value: 0 }]);
    assert.equal(row.effective.mode, mode);
    assert.equal(row.effective.value, mode === 'fixed_item' ? 0 : null);
  }
});

test('rejects absent reasons, duplicates, invalid types and percentages', () => {
  const valid = { itemId: 1, action: 'set' as const, mode: 'fixed_item', value: 5 };
  assert.throws(() => validateDeliveredCommissionChanges([valid], ' '));
  assert.throws(() => validateDeliveredCommissionChanges([valid, valid], 'Acuerdo'));
  for (const value of [-1, 101, NaN, null]) assert.throws(() => validateDeliveredCommissionChanges([{ ...valid, value }], 'Acuerdo'));
  assert.throws(() => validateDeliveredCommissionChanges([{ ...valid, mode: 'surprise' }], 'Acuerdo'));
  assert.deepEqual(validateDeliveredCommissionChanges([{ itemId: 1, action: 'clear' }], 'Restaurar'), [{ itemId: 1, action: 'clear' }]);
});
