import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildOrderCancellationCommand, readOrderCancellationPreview, readOrderCancellationReceipt, type OrderCancellationInput } from '../../src/lib/domain/order-cancellation-command.ts';

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const input: OrderCancellationInput = { requestId: '00000000-0000-4000-8000-000000000001', orderId: 1,
  fingerprint: 'a'.repeat(32), reason: 'Cancelación solicitada', paidHandling: 'refund',
  refundLines: [{ moneyAccountId: 1, currencyCode: 'USD', amount: 40 }, { moneyAccountId: 2, currencyCode: 'VES', amount: 1000, exchangeRateVesPerUsd: 100 }] };

test('cancellation preserves a stable request, preview and separate native refund lines', () => {
  const command = buildOrderCancellationCommand(input);
  assert.deepEqual(command, buildOrderCancellationCommand(input));
  assert.equal(command.p_request_id, input.requestId);
  assert.equal(command.p_input.fingerprint, input.fingerprint);
  assert.equal(command.p_input.refundLines.length, 2);
  assert.equal(command.p_input.refundLines[0].exchangeRateVesPerUsd, null);
  assert.equal(command.p_input.refundLines[1].amount, 1000);
  assert.equal(command.p_input.requireExactRefund, false);
  assert.equal(buildOrderCancellationCommand({ ...input, requireExactRefund: true }).p_input.requireExactRefund, true);
});

test('missing identity or stale preview cannot silently generate a new cancellation', () => {
  for (const bad of [{ requestId: '' }, { orderId: NaN }, { orderId: 1.2 }, { fingerprint: '' }, { reason: ' ' }, { reason: 'x'.repeat(1001) }]) {
    assert.throws(() => buildOrderCancellationCommand({ ...input, ...bad }));
  }
});

test('invalid refund lines are rejected instead of silently discarded', () => {
  for (const amount of [NaN, Infinity, -1, 0, 0.001, 1_000_000_001]) {
    assert.throws(() => buildOrderCancellationCommand({ ...input, refundLines: [{ moneyAccountId: 1, currencyCode: 'USD', amount }] }));
  }
  assert.throws(() => buildOrderCancellationCommand({ ...input, refundLines: [{ moneyAccountId: 1, currencyCode: 'VES', amount: 1 }] }));
  assert.throws(() => buildOrderCancellationCommand({ ...input, paidHandling: 'store_fund' }));
  assert.throws(() => buildOrderCancellationCommand({ ...input, refundLines: Array(13).fill(input.refundLines![0]) }));
});

test('preview exposes actual refundable cash, used fund and already stored excess independently', () => {
  const result = readOrderCancellationPreview({ orderId: 1, cashAvailableUsd: 100, fundUsedUsd: 5, alreadyStoredUsd: 20, fingerprint: input.fingerprint });
  assert.equal(result.cashAvailableUsd, 100);
  assert.equal(result.fundUsedUsd, 5);
  assert.equal(result.alreadyStoredUsd, 20);
  for (const bad of [null, {}, { ...result, cashAvailableUsd: null }, { ...result, fundUsedUsd: -1 }, { ...result, alreadyStoredUsd: Infinity }]) {
    assert.throws(() => readOrderCancellationPreview(bad));
  }
});

test('receipt validation preserves replay without inventing a success', () => {
  assert.equal(readOrderCancellationReceipt({ orderId: 1, eventId: 2, replayed: true, payload: {} }).replayed, true);
  for (const bad of [null, {}, { orderId: 1, eventId: 2, payload: {} }]) assert.throws(() => readOrderCancellationReceipt(bad));
});

test('Dashboard and Ops use one authorized cancellation command without multistep writes', () => {
  const actions = read('src/app/app/master/dashboard/actions.ts');
  const body = actions.slice(actions.indexOf('export async function cancelOrderAction'), actions.indexOf('export async function assignInternalDriverAction'));
  assert.match(body, /requireMasterOrAdmin\(/);
  assert.match(body, /rpc\('cancel_order_atomic_v1', command\)/);
  assert.match(body, /persistedEventId: receipt.eventId/);
  assert.doesNotMatch(body, /\.insert\(|\.update\(|restoreClientFundToOrder|randomUUID|createClient\(/);
  const ops = read('src/app/app/master/ops/actions.ts');
  const wrapper = ops.slice(ops.indexOf('export async function cancelMasterOpsOrderAction'), ops.indexOf('export async function updateMasterOpsExchangeRateAction'));
  assert.match(wrapper, /cancelOrderAction\(\{ \.\.\.input, requireExactRefund: true \}\)/);
  assert.doesNotMatch(wrapper, /\.from\(/);
});

test('both forms load a fresh cancellation preview and guard synchronous double clicks', () => {
  for (const path of ['dashboard', 'ops']) {
    const source = read(`src/app/app/master/${path}/${path === 'ops' ? 'MasterOpsClient' : 'MasterDashboardClient'}.tsx`);
    assert.match(source, /useOrderCancellationPreview\(/);
    assert.match(source, /cancellationBusyRef.current \|\| !cancellation.data/);
    assert.match(source, /cancellation.getRequestId\(\)/);
    assert.match(source, /cancellation.data.fingerprint/);
    assert.match(source, /Actualizar saldo/);
  }
  const hook = read('src/lib/orders/use-order-cancellation-preview.ts');
  assert.match(hook, /if \(orderId == null\) return/);
  assert.match(hook, /result\?\.orderId === orderId && result\?\.version === version/);
  assert.match(hook, /if \(!cancelled\)/);
});

test('database command has protected receipts, locked balances and atomic cancellation guards', () => {
  const migrations = readdirSync(new URL('../../supabase/migrations/', import.meta.url));
  const migration = read('supabase/migrations/' + migrations.find((name) => name.endsWith('_order_cancellation_atomic_v1.sql')));
  assert.match(migration, /enable row level security/);
  assert.match(migration, /from public,anon,authenticated,service_role/);
  assert.match(migration, /language plpgsql volatile security definer set search_path=''/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /p_input->>'fingerprint' is distinct from v_snapshot->>'fingerprint'/);
  assert.match(migration, /order_cancelled_payment_stored/);
  assert.match(migration, /guard_settled_cancelled_order/);
  assert.match(migration, /guard_cancelled_order_money/);
  assert.doesNotMatch(migration, /set total_usd=0|delete from public.money_movements/i);
});
