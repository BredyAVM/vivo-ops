import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { executeKitchenDispatch, projectKitchenReceipt, isKitchenDispatchConfirmed, type KitchenDispatchState } from '../../src/lib/orders/kitchen-dispatch.ts';

const state = (status: KitchenDispatchState['status'] = 'confirmed'): KitchenDispatchState => ({
  id: 1, status, queuedNeedsReapproval: false, sentToKitchenAtISO: '2026-10-02T18:00:00Z',
  kitchenStartedAtISO: null, readyAtISO: null,
});
test('success is based on persisted read-back, including actual timestamp', async () => {
  let notices = 0;
  const result = await executeKitchenDispatch({ send: async () => ({ error: null }), read: async () => state(), onCommitted: async () => { notices++; } });
  assert.equal(result.ok, true); assert.equal(notices, 1);
  assert.equal(result.order?.sentToKitchenAtISO, state().sentToKitchenAtISO);
});
test('a concurrent sender sees success without another notification', async () => {
  let notices = 0;
  const result = await executeKitchenDispatch({ send: async () => ({ error: 'Already in kitchen' }), read: async () => state('in_kitchen'), onCommitted: async () => { notices++; } });
  assert.equal(result.ok, true); assert.equal(result.order?.status, 'in_kitchen'); assert.equal(notices, 0);
});
test('two module requests share the atomic writer: only its winner notifies', async () => {
  let committed = false, notices = 0;
  const ports = {
    send: async () => { if (committed) return { error: 'Already sent' }; committed = true; return { error: null }; },
    read: async () => state(), onCommitted: async () => { notices++; },
  };
  const results = await Promise.all([executeKitchenDispatch(ports), executeKitchenDispatch(ports)]);
  assert.ok(results.every((r) => r.ok)); assert.equal(notices, 1);
});
test('committed send with unavailable read-back stays pending verification', async () => {
  const result = await executeKitchenDispatch({ send: async () => ({ error: null }), read: async () => { throw Error('offline'); } });
  assert.equal(result.ok, false); assert.equal(result.needsCheck, true); assert.match(result.message, /se guardó/); assert.equal(result.order, undefined);
});
test('transport interruption never claims a rollback or repeats the write', async () => {
  let calls = 0;
  const result = await executeKitchenDispatch({ send: async () => { calls++; throw Error('timeout'); }, read: async () => ({ ...state('queued'), sentToKitchenAtISO: null }) });
  assert.equal(calls, 1); assert.equal(result.needsCheck, true); assert.equal(result.ok, false);
});
test('an RPC error plus unavailable read-back also requires a read-only check', async () => {
  const result = await executeKitchenDispatch({ send: async () => ({ error: 'Fetch failed' }), read: async () => { throw Error('offline'); } });
  assert.equal(result.ok, false); assert.equal(result.needsCheck, true);
});
test('lost response can be recovered from a committed state', async () => {
  const result = await executeKitchenDispatch({ send: async () => { throw Error('timeout'); }, read: async () => state() });
  assert.equal(result.ok, true);
});
test('checking never sends or emits events', async () => {
  const result = await executeKitchenDispatch({ read: async () => state(), onCommitted: async () => { assert.fail('check cannot notify'); } });
  assert.equal(result.ok, true);
});
test('notification failure does not undo a successful operation', async () => {
  const result = await executeKitchenDispatch({ send: async () => ({ error: null }), read: async () => state(), onCommitted: async () => { throw Error('push'); } });
  assert.equal(result.ok, true);
});
test('a later return or cancellation is not falsely announced as in-kitchen', async () => {
  for (const status of ['created', 'queued', 'cancelled'] as const) {
    const result = await executeKitchenDispatch({ send: async () => ({ error: null }), read: async () => state(status) });
    assert.equal(result.ok, false); assert.equal(result.needsCheck, false); assert.equal(result.order?.status, status);
  }
});
test('reapproval rejection preserves the actual pending state', async () => {
  const result = await executeKitchenDispatch({ send: async () => ({ error: 'Requires reapproval' }), read: async () => ({ ...state('queued'), queuedNeedsReapproval: true, sentToKitchenAtISO: null }) });
  assert.equal(result.ok, false); assert.equal(result.message, 'Requires reapproval'); assert.equal(result.needsCheck, false);
});
test('confirmed status without dispatch evidence is not enough', () => {
  assert.equal(isKitchenDispatchConfirmed({ ...state(), sentToKitchenAtISO: null }), false);
});
test('an old snapshot cannot replace a confirmed receipt; a fresh return can', () => {
  const order = { ...state('queued'), sentToKitchenAtISO: null, totalUsd: 20 };
  const receipt = { ok: true, needsCheck: false, message: '', order: state(), observedAt: '2026-10-02T18:00:01Z' };
  assert.equal(projectKitchenReceipt(order, receipt, '2026-10-02T17:59:00Z').status, 'confirmed');
  assert.equal(projectKitchenReceipt(order, receipt, '2026-10-02T18:00:02Z').status, 'queued');
  assert.equal(projectKitchenReceipt(order, receipt, '2026-10-02T17:59:00Z').totalUsd, 20);
  assert.equal(projectKitchenReceipt({ ...order, id: 2 }, receipt, '2026-10-02T17:59:00Z').status, 'queued');
});
test('a receipt cannot regress a later kitchen step in the same cycle', () => {
  const receipt = { ok: true, needsCheck: false, message: '', order: state(), observedAt: '2026-10-02T18:00:01Z' };
  assert.equal(projectKitchenReceipt(state('ready'), receipt, '2026-10-02T17:59:00Z').status, 'ready');
});
test('all general send buttons use the common client confirmation contract', () => {
  for (const file of ['src/components/orders/OrdersWorkspaceClient.tsx', 'src/app/app/master/dashboard/MasterDashboardClient.tsx']) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.match(source, /useKitchenDispatch/); assert.match(source, /kitchenDispatch\.run\(/);
    assert.doesNotMatch(source, /await sendToKitchenAction\(/);
  }
  const counter = readFileSync(new URL('../../src/app/app/counter/CounterClient.tsx', import.meta.url), 'utf8');
  const scheduleHandler = counter.slice(counter.indexOf('async function handleUpdatePickupSchedule('), counter.indexOf('function handleHistoricalSearch('));
  assert.match(scheduleHandler, /await Promise\.all\([\s\S]*refreshCounter\(\)[\s\S]*refreshCounterOrder\(order.id\)/);
  const counterAction = readFileSync(new URL('../../src/app/app/counter/actions.ts', import.meta.url), 'utf8');
  assert.match(counterAction, /rpc\('counter_update_pickup_schedule',[\s\S]*p_idempotency_key: idempotencyKey/);
});
