import assert from 'node:assert/strict';
import test from 'node:test';
import { proposedCatalogUsdPrice, USD_CATALOG_PRICE_PROPOSAL } from '../../src/lib/pricing/catalog-usd-proposal.ts';

const product = (sku: string) => ({ sku, isActive: true, amount: USD_CATALOG_PRICE_PROPOSAL[sku].previousAmount,
  currency: USD_CATALOG_PRICE_PROPOSAL[sku].previousCurrency, productType: 'product' });

test('all 79 audited regular catalog references have their approved exact proposal', () => {
  assert.equal(Object.keys(USD_CATALOG_PRICE_PROPOSAL).length, 79);
  for (const [sku, entry] of Object.entries(USD_CATALOG_PRICE_PROPOSAL)) {
    assert.deepEqual(proposedCatalogUsdPrice(product(sku)), { kind: 'proposed', amountUsd: entry.nextUsd }, sku);
  }
});
test('same previous Bs amount never collapses sauces, beverages and presentations', () => {
  for (const [sku, price] of [['CHIN_1500', 2.5], ['FANTA_15LT', 2.5], ['SAL_TAR_5OZ', 3], ['MM_5OZ', 3],
    ['DEL_Z3', 5], ['SINGLE_8', 5.5], ['COKE_ZERO_2000', 2.5]] as const) {
    assert.deepEqual(proposedCatalogUsdPrice(product(sku)), { kind: 'proposed', amountUsd: price });
  }
});
test('unit exceptions and already-USD prices are preserved as agreed', () => {
  for (const [sku, price] of [['SAL_TAR_1OZ', 1], ['DONDY_1', 1.5], ['DONDY_6', 8],
    ['SAL_TAR_GALON', 35], ['COKE_1500MAYOR', 6.72]] as const) {
    assert.equal(proposedCatalogUsdPrice(product(sku)).amountUsd, price);
  }
});
test('zero prices remain zero and paid CRM benefits require their own recalculation', () => {
  assert.deepEqual(proposedCatalogUsdPrice({ ...product('DONDY_1'), amount: 0, productType: 'gambit' }), { kind: 'zero', amountUsd: 0 });
  assert.deepEqual(proposedCatalogUsdPrice({ ...product('SINGLE_8'), productType: 'gambit' }), { kind: 'recalculate_play', amountUsd: null });
});
test('inactive, unknown and drifted prices are never silently converted', () => {
  assert.equal(proposedCatalogUsdPrice({ ...product('SINGLE_8'), isActive: false }).kind, 'inactive');
  assert.equal(proposedCatalogUsdPrice({ ...product('SINGLE_8'), sku: 'UNKNOWN' }).kind, 'unmapped');
  assert.equal(proposedCatalogUsdPrice({ ...product('SINGLE_8'), amount: 4700 }).kind, 'changed_since_audit');
  assert.equal(proposedCatalogUsdPrice({ ...product('SINGLE_8'), currency: 'USD' }).kind, 'changed_since_audit');
  assert.throws(() => proposedCatalogUsdPrice({ ...product('SINGLE_8'), amount: Number.NaN }));
});
