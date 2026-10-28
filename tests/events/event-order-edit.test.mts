import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEventBreakdown, validateEventOrderEdit } from '../../src/lib/events/event-order-edit.ts';
const base = { combos: 35, pieces_per_combo: 5, price_per_combo: 3, stand: 30, discount_pct: 10 };
test('Bellavista original and revised totals apply discount once including the stand', () => {
  assert.deepEqual(calculateEventBreakdown(base), { products: 105, subtotal: 135, discount: 13.5, total: 121.5, pieces: 175 });
  assert.equal(calculateEventBreakdown({ ...base, combos: 60 }).total, 189);
});
test('fractional prices and a zero total are valid', () => {
  assert.equal(calculateEventBreakdown({ ...base, combos: 3, price_per_combo: 2.55, stand: 0, discount_pct: 0 }).total, 7.65);
  assert.equal(calculateEventBreakdown({ ...base, discount_pct: 100 }).total, 0);
});
test('negative, nonfinite, fractional piece counts and excessive discounts are rejected', () => {
  for (const patch of [{ combos: 0 }, { combos: 1.2 }, { pieces_per_combo: 0.5 }, { price_per_combo: NaN }, { stand: -1 }, { discount_pct: 101 }]) assert.throws(() => calculateEventBreakdown({ ...base, ...patch }));
});
test('direct total does not invent a breakdown, and requires a reason and operational units', () => {
  const input = { mode: 'total' as const, amount: 0, breakdown: null, reason: 'Obsequio autorizado', components: [{ product_id: 5, product_name: 'Mini', qty: 175, preparation_mode: 'kitchen' as const }] };
  assert.equal(validateEventOrderEdit(input), 0);
  assert.throws(() => validateEventOrderEdit({ ...input, reason: '' }));
  assert.throws(() => validateEventOrderEdit({ ...input, components: [...input.components, ...input.components] }));
  assert.throws(() => validateEventOrderEdit({ ...input, components: [{ ...input.components[0], qty: 0 }] }));
});
