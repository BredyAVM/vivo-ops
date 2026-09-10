import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
  if (context.parentURL?.includes('/admin-finance/') && (specifier === './active-orders-model' || specifier === './period')) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { parseActiveOrdersOverview, loadActiveOrdersOverview } = await import('../../src/lib/admin-finance/active-orders-data.ts');
const { ACTIVE_ORDER_STATUSES, activeOrderWindow, filterActiveOrders, summarizeActiveOrders, normalizeActiveOrdersFilters } = await import('../../src/lib/admin-finance/active-orders-model.ts');
import type { ActiveOrder } from '../../src/lib/admin-finance/active-orders-model.ts';

const now = new Date('2026-09-10T16:00:00Z');
function order(patch: Partial<ActiveOrder> = {}): ActiveOrder {
  return { id: 1, orderNumber: 'V-1', clientName: 'Cliente', advisorName: 'Asesor', status: 'queued',
    fulfillment: 'delivery', needsReview: false, scheduledDate: '2026-09-11', scheduledTime: '14:30',
    totalUsd: 116, coveredUsd: 60, pendingUsd: 56, pendingReportsUsd: 56, pendingReportsCount: 1,
    qualityCode: 'Q1_exact', ...patch };
}
function payload(orders = [order()]) {
  return { definitionVersion: 'admin-finance-active-orders-v1', asOf: now.toISOString(), asOfDate: '2026-09-10',
    cutoffMode: 'current_statement', balanceSource: 'canonical_order_financial_state', timeAxis: 'scheduled_date',
    currency: 'USD', orders, summary: summarizeActiveOrders(orders) };
}
const filters = normalizeActiveOrdersFilters({});

test('RF-01/02/04: advance payment reduces the obligation, a pending report does not; not delivered revenue', async () => {
  const calls: unknown[] = [];
  const result = await loadActiveOrdersOverview({ asOf: now, supabase: { async rpc(name, params) {
    calls.push({ name, params }); return { data: payload(), error: null };
  } } });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.data.summary.totalUsd, 116);
  assert.equal(result.data.summary.coveredUsd, 60);
  assert.equal(result.data.summary.pendingUsd, 56);
  assert.equal(result.data.summary.pendingReportsUsd, 56);
  assert.deepEqual(calls, [{ name: 'admin_finance_active_orders_v1', params: {} }]);
});

test('includes each approved execution status, fully covered orders and zero-value operational orders', () => {
  const orders = ACTIVE_ORDER_STATUSES.map((status, index) => order({ id: index + 1, status, coveredUsd: 116, pendingUsd: 0 }));
  orders.push(order({ id: 10, totalUsd: 0, coveredUsd: 0, pendingUsd: 0 }));
  const data = parseActiveOrdersOverview(payload(orders), now);
  assert.equal(filterActiveOrders(data, { ...filters, payment: 'covered' }).summary.orders, 6);
  for (const status of ['created', 'delivered', 'cancelled', 'unknown']) {
    assert.throws(() => parseActiveOrdersOverview(payload([order({ status: status as ActiveOrder['status'] })]), now));
  }
});

test('RF-10/11: canonical fund/rounding coverage is used, excess debt remains visible, never inferred from reports', () => {
  const data = parseActiveOrdersOverview(payload([
    order({ totalUsd: 45.17, coveredUsd: 45.17, pendingUsd: 0 }),
    order({ id: 2, totalUsd: 45.17, coveredUsd: 45, pendingUsd: 0.17 }),
    order({ id: 3, totalUsd: 10, coveredUsd: 0, pendingUsd: 12, qualityCode: 'Q3_incomplete' }),
  ]), now);
  assert.equal(data.summary.pendingUsd, 12.17);
  assert.equal(data.orders[0].coveredUsd, 45.17);
});

test('schedule buckets are exclusive across year boundaries, seven future dates exclude today', () => {
  assert.deepEqual([null, '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-06', '2027-01-07']
    .map(date => activeOrderWindow(date, '2026-12-30')), ['unscheduled', 'past', 'today', 'next7', 'next7', 'later']);
});

test('filtered totals cover all pages, final page is clamped, search includes id/client/advisor', () => {
  const data = parseActiveOrdersOverview(payload(Array.from({ length: 61 }, (_, index) => order({ id: index + 1 }))), now);
  const page = filterActiveOrders(data, { ...filters, page: 999, q: 'CLIENTE' });
  assert.equal(page.orders.length, 1);
  assert.equal(page.summary.orders, 61);
  assert.equal(page.summary.pendingUsd, 61 * 56);
  assert.equal(page.page, 3);
  assert.equal(filterActiveOrders(data, { ...filters, q: '61' }).summary.orders, 1);
  assert.equal(filterActiveOrders(data, { ...filters, q: 'asesor' }).summary.orders, 61);
  assert.equal(filterActiveOrders(data, { ...filters, window: 'today' }).summary.orders, 0);
  assert.equal(data.orders.length, 61);
});

test('unapproved edits and missing dates stay visible with explicit incomplete quality', () => {
  const data = parseActiveOrdersOverview(payload([order({ needsReview: true, scheduledDate: null, qualityCode: 'Q3_incomplete' })]), now);
  assert.equal(data.summary.reviewOrders, 1);
  assert.equal(data.summary.unscheduledOrders, 1);
  assert.equal(filterActiveOrders(data, { ...filters, window: 'unscheduled' }).summary.pendingUsd, 56);
  assert.throws(() => parseActiveOrdersOverview(payload([order({ scheduledDate: null })]), now));
});

test('empty valid response is zero, unavailable or malformed financial response is never zero', async () => {
  assert.equal(parseActiveOrdersOverview(payload([]), now).summary.orders, 0);
  for (const response of [{ data: null, error: null }, { data: payload([]), error: { message: 'denied' } }]) {
    assert.equal((await loadActiveOrdersOverview({ asOf: now, supabase: { async rpc() { return response; } } })).status, 'error');
  }
});

test('rejects stale cutoff, wrong timezone, bad version, duplicate or incomplete rows, and one-cent mismatches', () => {
  for (const patch of [
    { asOf: '2026-09-10T14:00:00Z' }, { asOfDate: '2026-09-09' }, { currency: 'VES' },
    { definitionVersion: 'v0' }, { orders: undefined }, { orders: [order(), order()] },
    { summary: { ...payload().summary, pendingUsd: 56.01 } },
  ]) assert.throws(() => parseActiveOrdersOverview({ ...payload(), ...patch }, now));
  for (const patch of [
    { totalUsd: null }, { totalUsd: ' ' }, { pendingUsd: -1 }, { pendingUsd: Number.NaN },
    { coveredUsd: 116 }, { id: 0 }, { id: 1.5 }, { pendingReportsCount: 0.1 },
    { scheduledDate: '2026-02-30' }, { scheduledTime: '25:00' }, { needsReview: 'false' },
  ]) assert.throws(() => parseActiveOrdersOverview({ ...payload(), orders: [{ ...order(), ...patch }] }, now));
});

test('cutoff at Caracas midnight uses server date, query filters are bounded and not trusted as dates', () => {
  const midnight = new Date('2026-09-11T03:59:59Z');
  assert.equal(parseActiveOrdersOverview({ ...payload(), asOf: midnight.toISOString() }, midnight).asOfDate, '2026-09-10');
  assert.deepEqual(normalizeActiveOrdersFilters({ agenda: '2026-09-10', page: 'Infinity', pago: 'unknown', q: ' x ' }), { ...filters, q: 'x' });
  assert.equal(normalizeActiveOrdersFilters({ q: 'x'.repeat(200) }).q.length, 80);
  assert.equal(normalizeActiveOrdersFilters({ page: '2.5' }).page, 1);
});

test('migration is guarded, read-only and delegates money to canonical calculator; UI uses existing protected operation', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260910160132_admin_finance_active_orders_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_uid is null or not exists/);
  assert.match(sql, /r\.role = 'admin'/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /from public, anon, authenticated, service_role/);
  assert.match(sql, /public\.get_order_financial_state\(a\.id, v_date, null\)/);
  assert.doesNotMatch(sql, /\b(?:insert into|update public|delete from)\b/i);
  assert.match(sql, /'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'/);
  const ui = readFileSync(new URL('../../src/app/app/admin/finanzas/pedidos/_components/ActiveOrdersOverview.tsx', import.meta.url), 'utf8');
  assert.match(ui, /openOrder=\$\{order.id\}&tab=pagos/);
  assert.match(ui, /lg:hidden/);
  assert.match(ui, /lg:block/);
});
