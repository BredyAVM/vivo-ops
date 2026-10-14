import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCommissionLiveCollections, mergeCommissionLiveOrders } from '../../src/lib/commissions/live-collections.ts';

test('collection reads reject incomplete or invalid responses instead of showing a payable zero', async () => {
  const client = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data,error }) }) as unknown as SupabaseClient;
  await assert.rejects(loadCommissionLiveCollections(client([]),[1]),/incompleta/);
  await assert.rejects(loadCommissionLiveCollections(client(null,{message:'Sin conexión'}),[1]),/Sin conexión/);
  await assert.rejects(loadCommissionLiveCollections(client([{closureId:1,supported:true,checkedAt:'2026-10-14T10:00:00Z',orders:[]}]),[1]),/importes/);
  const legacy = await loadCommissionLiveCollections(client([{closureId:1,supported:false,checkedAt:'2026-10-14T10:00:00Z'}]),[1]);
  assert.equal(legacy.get(1)?.supported,false);
});

test('live debt details preserve the net billing base and special commission metadata', () => {
  const merged = mergeCommissionLiveOrders([{orderId:1,billedUsd:100,commissionUsd:5,commissionMode:'fixed_item'}],[{
    orderId:1,clientName:'Cliente',deliveryDate:'2026-10-01',totalUsd:116,billedUsd:116,confirmedPaidUsd:116,pendingUsd:0,paymentStatus:'paid',
  }]);
  assert.equal(merged[0].billedUsd,100);
  assert.equal(merged[0].totalUsd,116);
  assert.equal(merged[0].commissionUsd,5);
  assert.equal(merged[0].pendingUsd,0);
});
