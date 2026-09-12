import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseAuthorizationQueue, parseExpenseReview, parseExpenseDecision, authorizationHref, type AuthorizationRow } from '../../src/lib/admin-finance/authorizations-model.ts';
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const row = { kind: 'expense', id: 11, order_id: null, created_at: '2026-09-12T12:00:00Z', title: 'Gasto', entity: 'Caja', actor_name: 'Operador', currency: 'USD', amount: 120, focus_date: null };
const queue = { rows: [row], total: 1, page: 1, counts: { expense: 1 } };
const movement = { id: 11, money_account_id: 1, account_name: 'Caja', currency_code: 'USD', amount: 120, amount_usd_equivalent: 120,
  exchange_rate_ves_per_usd: null, movement_type: 'expense_payment', status: 'pending', description: 'Gasto', movement_date: '2026-09-12',
  created_at: row.created_at, creator_name: 'Operador', reviewed_at: null };
const review = { movementId: 11, snapshot: 'a'.repeat(32), eligible: true, rows: [movement] };

test('queue retains native currency and distinguishes order total from adjustment', () => {
  const parsed = parseAuthorizationQueue(queue);
  assert.equal(parsed.rows[0].amount, 120); assert.equal(parsed.counts.order, 0);
  assert.throws(() => parseAuthorizationQueue({ ...queue, rows: [{ ...row, amount: 'NaN' }] }));
  assert.throws(() => parseAuthorizationQueue({ ...queue, rows: [{ ...row, currency: 'XXX' }] }));
  assert.throws(() => parseAuthorizationQueue({ ...queue, rows: null }));
});
test('review rejects incomplete snapshots, duplicate movements and missing identity', () => {
  assert.equal(parseExpenseReview(review).eligible, true);
  for (const patch of [{ snapshot: '' }, { eligible: null }, { rows: [] }, { rows: [movement, movement] }, { movementId: 99 }]) assert.throws(() => parseExpenseReview({ ...review, ...patch }));
});
test('payment route opens payment tab and only fixed Admin return destination', () => {
  const parsed = parseAuthorizationQueue(queue).rows[0];
  assert.equal(authorizationHref(parsed), '/app/admin/autorizaciones/egresos/11');
  const payment: AuthorizationRow = { ...parsed, kind: 'payment', orderId: 21, focusDate: '2026-09-12' };
  const u = new URL(authorizationHref(payment), 'https://example.test');
  assert.equal(u.searchParams.get('tab'), 'pagos'); assert.equal(u.searchParams.get('openOrder'), '21');
  assert.equal(u.searchParams.get('returnTo'), '/app/admin/autorizaciones');
});
test('receipt requires the chosen decision and the submitted movement', () => {
  const r = { status: 'decided', decision: 'approve', movementIds: [11, 12], reviewedAt: row.created_at };
  assert.equal(parseExpenseDecision(r, 11, 'approve').status, 'decided');
  assert.equal(parseExpenseDecision({ status: 'stale' }, 11, 'approve').status, 'stale');
  assert.throws(() => parseExpenseDecision(r, 13, 'approve'));
  assert.throws(() => parseExpenseDecision(r, 11, 'reject'));
  assert.throws(() => parseExpenseDecision({ ...r, movementIds: [11, 11] }, 11, 'approve'));
});

const state = { roles: ['admin'] as string[], calls: [] as Array<{ name: string; params: unknown }>,
  data: { status: 'decided', decision: 'approve', movementIds: [11], reviewedAt: row.created_at } as unknown,
  error: null as { code: string; message: string } | null, network: false, cacheFails: false };
Reflect.set(globalThis, '__authorizationTest', {
  context() {
    if (!state.roles.includes('admin')) throw new Error('No autorizado');
    return { supabase: { async rpc(name: string, params: unknown) {
      state.calls.push({ name, params }); if (state.network) throw new Error('offline');
      return { data: state.data, error: state.error };
    } } };
  }, cache() { if (state.cacheFails) throw new Error('cache offline'); },
});
const registerHooks = Reflect.get(await import('node:module'), 'registerHooks') as (hooks: {
  resolve: (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => { url: string }) => { url: string; shortCircuit?: boolean };
}) => void;
registerHooks({ resolve(specifier, context, next) {
  const mocks: Record<string, string> = {
    'server-only': 'export {};',
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__authorizationTest.context()}',
    'next/cache': 'export function revalidatePath(){globalThis.__authorizationTest.cache()} export function updateTag(){globalThis.__authorizationTest.cache()}',
  };
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL(`../../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier === './authorizations-model') return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { decideAdminExpenseAction } = await import('../../src/app/app/admin/autorizaciones/egresos/[movementId]/actions.ts');
const { loadAuthorizations, loadExpenseReview } = await import('../../src/lib/admin-finance/authorizations-data.ts');
const input = { movementId: 11, snapshot: review.snapshot, decision: 'approve' as const, reason: '' };
function reset() {
  state.roles = ['admin']; state.calls = []; state.data = { status: 'decided', decision: 'approve', movementIds: [11], reviewedAt: row.created_at };
  state.error = null; state.network = false; state.cacheFails = false;
}
test('all read and mutation boundaries reject non-admin before database access', async () => {
  for (const roles of [[], ['advisor'], ['master'], ['counter']]) {
    reset(); state.roles = roles;
    await assert.rejects(decideAdminExpenseAction(input), /No autorizado/);
    await assert.rejects(loadAuthorizations('all', 1), /No autorizado/);
    await assert.rejects(loadExpenseReview(11), /No autorizado/);
    assert.equal(state.calls.length, 0);
  }
});
test('valid decision uses exact snapshot and one atomic command', async () => {
  reset(); const r = await decideAdminExpenseAction(input);
  assert.equal(r.status, 'decided'); assert.deepEqual(state.calls, [{ name: 'decide_admin_expense_v1', params: { p_movement_id: 11, p_snapshot: review.snapshot, p_decision: 'approve', p_reason: null } }]);
});
test('reject needs a reason and never falls back to approve', async () => {
  reset(); assert.equal((await decideAdminExpenseAction({ ...input, decision: 'reject' })).status, 'error'); assert.equal(state.calls.length, 0);
  state.data = { status: 'decided', decision: 'reject', movementIds: [11], reviewedAt: row.created_at };
  assert.equal((await decideAdminExpenseAction({ ...input, decision: 'reject', reason: 'No corresponde' })).status, 'decided');
});
test('uncertain response is not success; stale response requires new review', async () => {
  reset(); state.network = true; assert.equal((await decideAdminExpenseAction(input)).status, 'uncertain');
  reset(); state.data = null; assert.equal((await decideAdminExpenseAction(input)).status, 'uncertain');
  reset(); state.data = { status: 'stale' }; assert.equal((await decideAdminExpenseAction(input)).status, 'stale');
  reset(); state.error = { code: '22023', message: 'Revisión inválida' }; assert.equal((await decideAdminExpenseAction(input)).status, 'error');
});
test('cache refresh failure cannot hide a saved decision', async () => {
  reset(); state.cacheFails = true; assert.equal((await decideAdminExpenseAction(input)).status, 'decided');
});
test('queue errors are surfaced rather than converted to an empty list', async () => {
  reset(); state.error = { code: '500', message: 'offline' }; await assert.rejects(loadAuthorizations('all', 1));
  reset(); state.data = queue; assert.equal((await loadAuthorizations('all', 1)).total, 1);
});
test('UI blocks simultaneous submissions and discards stale snapshot only on fresh navigation', () => {
  const form = source('src/app/app/admin/autorizaciones/egresos/[movementId]/ExpenseDecisionForm.tsx');
  assert.match(form, /busy.current = true/); assert.match(form, /fieldset disabled=\{pending\}/);
  assert.match(form, /result.status !== 'error'/); assert.match(form, /Actualizar revisión y estado/);
  const ops = source('src/app/app/master/ops/MasterOpsClient.tsx');
  assert.match(ops, /searchParams.get\("returnTo"\) === "\/app\/admin\/autorizaciones" && roles.includes\("admin"\)/);
});
