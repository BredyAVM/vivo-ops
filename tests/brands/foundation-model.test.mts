import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncentiveUsd, parseBrandFoundationFilters, decodeCommercialFoundation } from '../../src/lib/brands/model.ts';

const response = () => ({
  version: 'commercial-foundation-v1',
  brands: [
    { code: 'vivo', name: 'VIVO Fritos', salesEnabled: true, incentivePolicy: null },
    { code: 'muerdeme', name: 'Muérdeme', salesEnabled: false, incentivePolicy: {
      revision: 1, firstOrderUsd: 0.3, recurrentOrderUsd: 0.2, requiresBurger: true,
      status: 'draft', createdAt: '2026-10-28T18:00:00Z',
    } },
  ], catalog: [{ id: 1, name: 'Producto VIVO', isActive: true, brandCode: 'vivo', amount: 11500, currency: 'VES' }],
  hasNext: false, page: 1,
});

test('USD inputs accept decimal comma, decimal point and zero without rounding away fractions', () => {
  assert.equal(parseIncentiveUsd('0,30'), 0.3);
  assert.equal(parseIncentiveUsd('0.20'), 0.2);
  assert.equal(parseIncentiveUsd(' 0 '), 0);
  assert.equal(parseIncentiveUsd('12,75'), 12.75);
  for (const value of ['', '0.295', '-1', '1,000.00', '1.000,00', '1e2', 'Infinity', null, 0.3]) {
    assert.throws(() => parseIncentiveUsd(value), /importe en USD/);
  }
});
test('catalogue is opt-in and filters reject unknown brands and unbounded pages', () => {
  assert.deepEqual(parseBrandFoundationFilters({}), { includeCatalog: false, brandCode: null, query: '', page: 1 });
  assert.deepEqual(parseBrandFoundationFilters({ catalogo: '1', marca: 'muerdeme', q: '  Burger ', page: '2' }),
    { includeCatalog: true, brandCode: 'muerdeme', query: 'Burger', page: 2 });
  for (const params of [{ page: '1.2' }, { page: 'Infinity' }, { page: '0' }, { page: '10001' }, { marca: 'fake' }, { q: 'x'.repeat(101) }]) {
    assert.throws(() => parseBrandFoundationFilters(params));
  }
});
test('reading preserves native currency and distinguishes percentage-free USD incentive settings', () => {
  const value = decodeCommercialFoundation(response());
  assert.equal(value.catalog[0].amount, 11500);
  assert.equal(value.catalog[0].currency, 'VES');
  assert.equal(value.brands[0].incentivePolicy, null);
  assert.equal(value.brands[1].incentivePolicy?.firstOrderUsd, 0.3);
});
test('incomplete or malformed financial responses fail closed rather than showing misleading zeroes', () => {
  for (const mutate of [
    (r: ReturnType<typeof response>) => { r.brands.pop(); },
    (r: ReturnType<typeof response>) => { r.brands[1].incentivePolicy = null; },
    (r: ReturnType<typeof response>) => { r.brands[1].incentivePolicy!.firstOrderUsd = NaN; },
    (r: ReturnType<typeof response>) => { r.brands[1].incentivePolicy!.firstOrderUsd = 0.295; },
    (r: ReturnType<typeof response>) => { r.catalog[0].currency = 'EUR'; },
    (r: ReturnType<typeof response>) => { r.catalog = Array.from({ length: 26 }, () => r.catalog[0]); },
  ]) {
    const value = response(); mutate(value);
    assert.throws(() => decodeCommercialFoundation(value));
  }
});
