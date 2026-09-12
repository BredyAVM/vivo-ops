import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const state = { roles: ['admin'], calls: [] as { name: string; params: unknown }[], data: null as unknown,
  error: null as null | { code: string; message: string }, offline: false, pushFails: false, cacheFails: false, pushes: 0 };
Reflect.set(globalThis, '__orderReviewTest', {
  context() {
    if (!state.roles.includes('admin')) throw new Error('No autorizado');
    return { supabase: { async rpc(name: string, params: unknown) {
      state.calls.push({ name, params }); if (state.offline) throw new Error('offline');
      return { data: state.data, error: state.error };
    } } };
  }, push() { state.pushes++; if (state.pushFails) throw new Error('push offline'); },
  cache() { if (state.cacheFails) throw new Error('cache offline'); },
});
const registerHooks = Reflect.get(await import('node:module'), 'registerHooks') as (hooks: {
  resolve: (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => { url: string }) => { url: string; shortCircuit?: boolean };
}) => void;
registerHooks({ resolve(s, c, next) {
  const mocks: Record<string, string> = {
    'server-only': 'export {};',
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__orderReviewTest.context()}',
    '@/lib/push': 'export async function sendPushToAdvisorDevices(){globalThis.__orderReviewTest.push()} export async function sendPushToRoleDevices(){globalThis.__orderReviewTest.push()}',
    'next/cache': 'export function revalidatePath(){globalThis.__orderReviewTest.cache()}',
  };
  if (mocks[s]) return { url: `data:text/javascript,${encodeURIComponent(mocks[s])}`, shortCircuit: true };
  if (s.startsWith('@/')) return next(new URL(`../../src/${s.slice(2)}.ts`, import.meta.url).href, c);
  if (s === './order-review-model' || s === '../orders/order-change-detail') return next(`${s}.ts`, c);
  return next(s, c);
} });
const { parseOrderReview, parseOrderReviewReceipt } = await import('../../src/lib/admin-finance/order-review-model.ts');
const { loadAdminOrderReview } = await import('../../src/lib/admin-finance/order-review-data.ts');
const { approveAdminOrderAction } = await import('../../src/app/app/admin/autorizaciones/ordenes/[orderId]/actions.ts');
const { authorizationHref } = await import('../../src/lib/admin-finance/authorizations-model.ts');
const input = { orderId: 42, snapshot: 'a'.repeat(32), action: 'approve' as const, notes: '' };
const receipt = { status: 'approved', orderId: 42, eventId: 17, action: 'approve', advisorId: 'advisor-test', orderNumber: '42' };
const detail = { snapshot: input.snapshot, action: 'approve', order: { id: 42, status: 'created', extra_fields: {}, client_name: 'Cliente' },
  financial: { order_id: 42, total_usd: 10, confirmed_paid_usd: 3, client_fund_used_usd: 2, pending_usd: 5, overpaid_usd: 0, pending_reports_usd: 1 },
  items: [{ id: 9, product_name_snapshot: 'Pack', qty: 1, line_total_usd: 10, notes: '6 piezas\n@sel|5|6' }], changes: [] };
function reset() { Object.assign(state, { roles: ['admin'], calls: [], data: receipt, error: null, offline: false, pushFails: false, cacheFails: false, pushes: 0 }); }
test('review separates confirmed, reported and fund values; hides machine detail', () => {
  const r = parseOrderReview(detail); assert.equal(r.pendingUsd, 5); assert.equal(r.reportedUsd, 1);
  assert.equal(r.fundUsedUsd, 2); assert.equal(r.items[0].notes, '6 piezas');
});
test('review fails closed on missing financial data, wrong identity, duplicate lines and invalid numbers', () => {
  for (const patch of [{ financial: null }, { financial: { ...detail.financial, order_id: 9 } },
    { financial: { ...detail.financial, total_usd: ' ' } }, { items: [...detail.items, ...detail.items] },
    { snapshot: '' }, { action: 'cancel' }]) assert.throws(() => parseOrderReview({ ...detail, ...patch }));
});
test('receipt must match order and requested action', () => {
  assert.equal(parseOrderReviewReceipt(receipt, 42, 'approve').status, 'approved');
  assert.throws(() => parseOrderReviewReceipt(receipt, 43, 'approve'));
  assert.throws(() => parseOrderReviewReceipt(receipt, 42, 'reapprove'));
  assert.throws(() => parseOrderReviewReceipt({ ...receipt, eventId: null }, 42, 'approve'));
});
test('both order authorization kinds open native review, not the expense/payment command', () => {
  for (const kind of ['order', 'reapproval'] as const) assert.equal(authorizationHref({ kind, id: 42, orderId: 42,
    createdAt: '', title: '', entity: '', actorName: '', currency: 'USD', amount: 10, focusDate: null }), '/app/admin/autorizaciones/ordenes/42');
});
test('non-admin roles cannot read or approve, even through the server action', async () => {
  for (const roles of [[], ['advisor'], ['master'], ['counter'], ['kitchen']]) {
    reset(); state.roles = roles; await assert.rejects(loadAdminOrderReview(42), /No autorizado/);
    await assert.rejects(approveAdminOrderAction(input), /No autorizado/); assert.equal(state.calls.length, 0);
  }
});
test('approval uses one exact-version command and sends notifications only after receipt', async () => {
  reset(); assert.equal((await approveAdminOrderAction(input)).status, 'approved');
  assert.deepEqual(state.calls, [{ name: 'approve_admin_order_review_v1', params: { p_order_id: 42, p_snapshot: input.snapshot, p_action: 'approve', p_notes: null } }]);
  assert.equal(state.pushes, 2);
});
test('ratification preserves action and optional note; invalid input never writes', async () => {
  reset(); state.data = { ...receipt, action: 'reapprove' };
  assert.equal((await approveAdminOrderAction({ ...input, action: 'reapprove', notes: ' Revisado ' })).status, 'approved');
  assert.deepEqual(state.calls[0].params, { p_order_id: 42, p_snapshot: input.snapshot, p_action: 'reapprove', p_notes: 'Revisado' });
  for (const patch of [{ orderId: 0 }, { snapshot: '' }, { notes: 'x'.repeat(801) }]) {
    reset(); assert.equal((await approveAdminOrderAction({ ...input, ...patch })).status, 'error'); assert.equal(state.calls.length, 0);
  }
});
test('stale/uncertain outcomes do not send notifications or claim success', async () => {
  reset(); state.data = { status: 'stale' }; assert.equal((await approveAdminOrderAction(input)).status, 'stale'); assert.equal(state.pushes, 0);
  reset(); state.data = null; assert.equal((await approveAdminOrderAction(input)).status, 'uncertain'); assert.equal(state.pushes, 0);
  reset(); state.offline = true; assert.equal((await approveAdminOrderAction(input)).status, 'uncertain'); assert.equal(state.pushes, 0);
});
test('canonical inventory rejection is retained as an error', async () => {
  reset(); state.error = { code: 'P0001', message: 'Saldo protegido insuficiente' };
  assert.deepEqual(await approveAdminOrderAction(input), { status: 'error', message: 'Saldo protegido insuficiente' }); assert.equal(state.pushes, 0);
});
test('push and cache failures never disguise a committed approval', async () => {
  reset(); state.pushFails = true; state.cacheFails = true;
  assert.equal((await approveAdminOrderAction(input)).status, 'approved');
});
test('read errors are visible; review is not replaced by zeros', async () => {
  reset(); state.error = { code: '500', message: 'offline' }; await assert.rejects(loadAdminOrderReview(42));
  reset(); state.data = detail; assert.equal((await loadAdminOrderReview(42)).totalUsd, 10);
});
test('form locks double submission and requires fresh review for uncertain/stale outcomes', () => {
  const form = readFileSync(new URL('../../src/app/app/admin/autorizaciones/ordenes/[orderId]/OrderReviewForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /busy.current = true/); assert.match(form, /fieldset disabled=\{pending\}/);
  assert.match(form, /result.status !== 'error'/); assert.match(form, /Actualizar revisión/);
});
