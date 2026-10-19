import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCommissionLiveCollections, loadCommissionLiveCollectionResults, mergeCommissionLiveOrders } from '../../src/lib/commissions/live-collections.ts';

test('collection reads reject incomplete or invalid responses instead of showing a payable zero', async () => {
  const client = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data,error }) }) as unknown as SupabaseClient;
  await assert.rejects(loadCommissionLiveCollections(client([]),[1]),/incompleta/);
  await assert.rejects(loadCommissionLiveCollections(client(null,{message:'Sin conexión'}),[1]),/Sin conexión/);
  await assert.rejects(loadCommissionLiveCollections(client([{closureId:1,supported:true,checkedAt:'2026-10-14T10:00:00Z',orders:[]}]),[1]),/importes/);
  const legacy = await loadCommissionLiveCollections(client([{closureId:1,supported:false,checkedAt:'2026-10-14T10:00:00Z'}]),[1]);
  assert.equal(legacy.get(1)?.supported,false);
});

function state(closureId = 323) {
  return { closureId, supported: true, checkedAt: '2026-10-19T23:24:49Z', agreedPayableUsd: 0,
    paidUsd: 0, customerDebtUsd: 0, carriedCommissionUsd: 0, priorAdvisorDebtUsd: 0,
    creditUsd: 18.88, payableUsd: 18.88, pendingUsd: 18.88, retainedUsd: 0, remainingCreditUsd: 18.88,
    advisorDebtUsd: 0, overpaidUsd: 0, orders: [], incomingTransferCount: 0, transferredToClosureId: null };
}
const clientFor = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as unknown as SupabaseClient;

test('October regression: Martin releases 18.88 beside a signed preliminary without changing his zero agreement', async () => {
  const martin = state();
  const ramon = { ...state(324), agreedPayableUsd: -4.03, carriedCommissionUsd: 85.18,
    customerDebtUsd: 19.63, creditUsd: 81.15, payableUsd: 61.52, pendingUsd: 61.52, retainedUsd: 19.63, remainingCreditUsd: 81.15 };
  const before = JSON.stringify([martin, ramon]);
  const client = clientFor([martin, ramon]);
  const result = await loadCommissionLiveCollectionResults(client, [323,324], { preliminaryClosureIds: [324] });
  assert.equal(result.errors.size, 0);
  assert.equal(result.collections.get(323)?.pendingUsd, 18.88);
  assert.equal(result.collections.get(323)?.agreedPayableUsd, 0);
  assert.equal(result.collections.get(324)?.agreedPayableUsd, -4.03);
  assert.equal((await loadCommissionLiveCollections(client, [323,324], { preliminaryClosureIds: [324] })).size, 2);
  assert.equal(JSON.stringify([martin,ramon]), before);
});

test('a bad peer is isolated, never presented as zero, and strict write reads still fail closed', async () => {
  const client = clientFor([state(), { ...state(324), pendingUsd: -1 }]);
  const result = await loadCommissionLiveCollectionResults(client, [323,324], { preliminaryClosureIds: [324] });
  assert.equal(result.collections.get(323)?.pendingUsd, 18.88);
  assert.equal(result.collections.has(324), false);
  assert.match(result.errors.get(324)!, /importes/);
  await assert.rejects(loadCommissionLiveCollections(client, [323,324], { preliminaryClosureIds: [324] }), /importes/);
});

test('a negative agreement is accepted only with server-known preliminary scope, never for actual payable or paid amounts', async () => {
  await assert.rejects(loadCommissionLiveCollections(clientFor([{ ...state(), agreedPayableUsd: -4.03 }]), [323]), /importes/);
  for (const key of ['payableUsd','paidUsd','customerDebtUsd','pendingUsd','retainedUsd','creditUsd']) {
    await assert.rejects(loadCommissionLiveCollections(clientFor([{ ...state(), [key]: -1 }]), [323], { preliminaryClosureIds: [323] }), /importes/);
  }
});

test('missing or duplicate peers cannot discard a verified advisor or certify the missing one', async () => {
  for (const rows of [[state()], [state(),state(324),state(324)]]) {
    const result = await loadCommissionLiveCollectionResults(clientFor(rows), [323,324]);
    assert.equal(result.collections.get(323)?.pendingUsd,18.88);
    assert.equal(result.collections.has(324),false);
    assert.equal(result.errors.has(324),true);
    await assert.rejects(loadCommissionLiveCollections(clientFor(rows), [323,324]));
  }
});

test('an RPC exception is retried per advisor with at most four reads in flight, keeping authorization failures isolated', async () => {
  let active = 0, maximum = 0;
  const client = { async rpc(_name: string, args: { p_closure_ids: number[] }) {
    const ids = args.p_closure_ids;
    if (ids.length > 1) return { data: null, error: { message: 'Falla de un asesor' } };
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return ids[0] === 324 ? { data: null, error: { message: 'No puedes consultar esta liquidación.' } }
      : { data: [state(ids[0])], error: null };
  } } as unknown as SupabaseClient;
  const ids = [323,324,325,326,327,328,329];
  const result = await loadCommissionLiveCollectionResults(client, ids);
  assert.equal(result.collections.size,6);
  assert.equal(result.collections.get(323)?.pendingUsd,18.88);
  assert.equal(result.collections.has(324),false);
  assert.match(result.errors.get(324)!, /No puedes/);
  assert.ok(maximum <= 4);
});

test('foreign, non-finite and malformed responses never become payable balances', async () => {
  for (const rows of [[state(999)], [{ ...state(), pendingUsd: NaN }], [{ ...state(), checkedAt: 'bad' }], [{ ...state(), orders: [null] }]]) {
    const result = await loadCommissionLiveCollectionResults(clientFor(rows), [323]);
    assert.equal(result.collections.size,0);
    assert.equal(result.errors.has(323),true);
  }
});

test('admin rendering gates payment per advisor and never totals unverified balances', () => {
  const page = readFileSync(new URL('../../src/app/app/commissions/page.tsx', import.meta.url),'utf8');
  assert.ok(page.includes('loadCommissionLiveCollectionResults('));
  assert.ok(page.includes('!row.collectionError ? ('));
  assert.ok(page.includes('disabled={Boolean(row.collectionError || transferDestinations.error)}'));
  assert.ok(page.includes("value={unverifiedCollectionCount ? 'Sin verificar' : money(totals.paymentBalanceUsd)}"));
  assert.ok(page.includes('Cobranza de este asesor sin verificar. No se habilitan pagos ni traslados.'));
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
