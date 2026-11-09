import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateCoupon, readCrmCoupon, isCouponCatalogProduct } from '../../src/lib/crm/coupon.ts';

test('one allowance covers a drink and delivery, never four dollars per line', () => {
  const quotes = allocateCoupon(4, [{ benefitId: 2, grossUsd: 4 }, { benefitId: 1, grossUsd: 3.5 }]);
  assert.deepEqual(quotes.map(q => [q.discountUsd, q.netUsd]), [[3.5, 0], [0.5, 3.5]]);
  assert.deepEqual(allocateCoupon(4, [{ benefitId: 2, grossUsd: 4 }]).map(q => q.netUsd), [0]);
  assert.deepEqual(allocateCoupon(4, [{ benefitId: 1, grossUsd: 3.5 }]).map(q => q.discountUsd), [3.5]);
  assert.equal(allocateCoupon(4, [{ benefitId: 1, grossUsd: 10.5 }])[0].netUsd, 6.5);
});
test('rounding, over-cap totals and duplicate references cannot increase the allowance', () => {
  const quotes = allocateCoupon(4, Array.from({ length: 20 }, (_, n) => ({ benefitId: n + 1, grossUsd: 0.333333 })));
  assert.equal(Math.round(quotes.reduce((n, q) => n + q.discountUsd, 0) * 100), 400);
  assert.throws(() => allocateCoupon(4, [{ benefitId: 1, grossUsd: 4 }, { benefitId: 1, grossUsd: 4 }]));
  assert.throws(() => allocateCoupon(4, [{ benefitId: 1, grossUsd: NaN }]));
});
test('costs remain pending until a valid split is approved; eligible catalog excludes food', () => {
  const raw = { coupon_draft: { maximum_discount_usd: 4, economics: { review_status: 'pending' } } };
  assert.equal(readCrmCoupon(raw)?.economics.review_status, 'pending');
  assert.equal(readCrmCoupon({}), null);
  assert.throws(() => readCrmCoupon({ coupon_draft: { maximum_discount_usd: 4, economics: { review_status: 'approved', advisor_contribution_usd: 1, company_contribution_usd: 4 } } }));
  assert.equal(isCouponCatalogProduct({ name: 'Single Pack', type: 'combo', inventory_group: 'other' }), false);
  assert.equal(isCouponCatalogProduct({ name: 'Cola', type: 'product', inventory_group: 'beverages' }), true);
  assert.equal(isCouponCatalogProduct({ name: 'Delivery Zona 7', type: 'product' }), true);
  assert.equal(isCouponCatalogProduct({ name: 'Delivery Zona 8', type: 'product' }), true);
  assert.equal(isCouponCatalogProduct({ name: 'Envío costa', sku: 'DEL_COAST', type: 'product' }), true);
  assert.equal(isCouponCatalogProduct({ name: 'Agua nueva', type: 'product', inventory_group: 'beverages' }, ['beverages']), true);
  assert.equal(isCouponCatalogProduct({ name: 'Delivery express', type: 'product' }, ['beverages']), false);
  assert.equal(isCouponCatalogProduct({ name: 'Agua', type: 'product', inventory_group: 'beverages' }, ['delivery']), false);
  assert.deepEqual(readCrmCoupon({ coupon_draft: { maximum_discount_usd: 4, eligible_categories: ['beverages'] } })?.families, ['beverages']);
  assert.throws(() => readCrmCoupon({ coupon_draft: { maximum_discount_usd: 4, eligible_categories: [] } }));
  assert.equal(isCouponCatalogProduct({ name: 'Cola', type: 'product', inventory_group: 'beverages', is_active: false }), false);
});
