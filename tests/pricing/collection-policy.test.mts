import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePaymentCollectionMode, paymentCollectionValueRate, paymentCollectionGuidance }
  from '../../src/lib/orders/collection-policy.ts';

test('new USD sales use current FX before and after delivery', () => {
  for (const afterDelivery of [false, true]) {
    assert.equal(paymentCollectionGuidance(true, afterDelivery).key, 'native_usd');
  }
});
test('old quotations retain their delivery-date rules', () => {
  assert.equal(paymentCollectionGuidance(false, false).key, 'snapshot_quote');
  assert.equal(paymentCollectionGuidance(false, true).key, 'post_delivery_usd');
});
test('counter accepts the canonical new mode instead of treating an unpaid sale as closed', () => {
  for (const mode of ['native_usd', 'snapshot_quote', 'post_delivery_usd'] as const) {
    assert.equal(normalizePaymentCollectionMode(mode), mode);
  }
  assert.equal(normalizePaymentCollectionMode('unknown'), 'closed');
});
test('counter native USD payment coverage uses current FX even if a snapshot exists', () => {
  assert.equal(paymentCollectionValueRate({collectionMode:'native_usd',exchangeRate:900,snapshotRate:800}),900);
  assert.equal(paymentCollectionValueRate({collectionMode:'native_usd',exchangeRate:0,snapshotRate:800}),0);
});
test('counter preserves old quotation FX and post-delivery FX', () => {
  assert.equal(paymentCollectionValueRate({collectionMode:'snapshot_quote',exchangeRate:900,snapshotRate:800}),800);
  assert.equal(paymentCollectionValueRate({collectionMode:'post_delivery_usd',exchangeRate:900,snapshotRate:800}),900);
});
test('all three payment surfaces consume the server commercial version without extra reads', () => {
  const read=(path:string)=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
  assert.match(read('src/app/app/counter/read-model.ts'),/collectionMode: normalizePaymentCollectionMode\(collectionMode\)/);
  assert.match(read('src/app/app/counter/CounterPaymentEngine.tsx'),/return paymentCollectionValueRate\(quote\)/);
  assert.match(read('src/app/app/advisor/orders/[id]/page.tsx'),/nativeUsdCollection=\{financialState\?\.collection_mode === 'native_usd'\}/);
  assert.match(read('src/app/app/advisor/orders/[id]/OrderDetailActions.tsx'),/paymentCollectionGuidance\(nativeUsd,/);
});
