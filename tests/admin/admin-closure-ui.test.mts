import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
type Row = Record<string, unknown>;
const state = { roles: ['admin'], tables: {} as Record<string, Row[]>, calls: [] as { name: string; params: unknown }[],
  reads: 0, data: null as unknown, error: null as null | { code: string; message: string }, offline: false, readError: false, cacheFails: false };
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [], sorts: { key: string; ascending: boolean }[] = [];
  let from = 0, to = 999, single = false;
  const q = {
    select() { return q; }, eq(k: string, v: unknown) { filters.push(r => r[k] === v); return q; },
    in(k: string, values: unknown[]) { filters.push(r => values.includes(r[k])); return q; },
    lt(k: string, v: string) { filters.push(r => String(r[k]) < v); return q; },
    lte(k: string, v: string) { filters.push(r => String(r[k]) <= v); return q; },
    gt(k: string, v: string) { filters.push(r => String(r[k]) > v); return q; },
    gte(k: string, v: string) { filters.push(r => String(r[k]) >= v); return q; },
    order(key: string, options: { ascending: boolean }) { sorts.push({ key, ...options }); return q; },
    range(a: number, b: number) { from = a; to = b; return q; }, limit(n: number) { to = n - 1; return q; },
    single() { single = true; return q; }, maybeSingle() { single = true; return q; },
    then(resolve: (v: unknown) => unknown) {
      state.reads++;
      let rows = (state.tables[table] ?? []).filter(r => filters.every(f => f(r)));
      rows.sort((a, b) => { for (const s of sorts) { const n = String(a[s.key]).localeCompare(String(b[s.key])); if (n) return s.ascending ? n : -n; } return 0; });
      rows = rows.slice(from, to + 1);
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: state.readError ? { message: 'offline' } : null }).then(resolve);
    },
  }; return q;
}
Reflect.set(globalThis, '__closureUiTest', {
  context() {
    if (!state.roles.includes('admin')) throw new Error('No autorizado');
    return { supabase: { from: query, async rpc(name: string, params: unknown) {
      state.calls.push({ name, params }); if (state.offline) throw new Error('offline'); return { data: state.data, error: state.error };
    } } };
  }, cache() { if (state.cacheFails) throw new Error('cache offline'); },
});
const registerHooks = Reflect.get(await import('node:module'), 'registerHooks') as (hooks: {
  resolve: (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => { url: string }) => { url: string; shortCircuit?: boolean };
}) => void;
registerHooks({ resolve(s, c, next) {
  const mocks: Record<string, string> = { 'server-only': 'export {};', '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__closureUiTest.context()}',
    'next/cache': 'export function revalidatePath(){globalThis.__closureUiTest.cache()}' };
  if (mocks[s]) return { url: `data:text/javascript,${encodeURIComponent(mocks[s])}`, shortCircuit: true };
  if (s.startsWith('@/')) return next(new URL(`../../src/${s.slice(2)}.ts`, import.meta.url).href, c);
  if (s === './account-closure-model') return next(`${s}.ts`, c);
  return next(s, c);
} });
const { validClosureInput, readClosureReceipt } = await import('../../src/lib/finance/account-closure-model.ts');
const { createAdminAccountClosure, previewAdminAccountClosure } = await import('../../src/app/app/admin/finanzas/cuentas/cierre/actions.ts');
const input = { requestId: '00000000-0000-4000-8000-000000000041', moneyAccountId: 1, closureDate: '2026-09-12', closureTime: '12:00', countedAmount: 8, exchangeRateVesPerUsd: null, reason: 'Cierre diario', notes: '' };
const receipt = { closureId: 21, reconciliationItemId: 31, expectedAmount: 10, expectedAmountUsd: 10, differenceAmount: -2, replayed: false };
function movement(id: number, amount: number, date = '2026-09-12', hour = '10:00'): Row {
  return { id, money_account_id: 1, status: 'confirmed', direction: 'inflow', amount, amount_usd_equivalent: amount, movement_type: 'other_income', movement_date: date, confirmed_at: `${date}T${hour}:00-04:00`, created_at: `${date}T${hour}:00-04:00`, reference_code: null };
}
function reset(kind = 'bank') {
  Object.assign(state, { roles: ['admin'], calls: [], reads: 0, data: receipt, error: null, offline: false, readError: false, cacheFails: false,
    tables: { money_accounts: [{ id: 1, currency_code: 'USD', account_kind: kind }], money_account_closure_profiles: [{ money_account_id: 1, closure_kind: kind }],
      money_account_closure_baselines: [], money_account_closures: [], money_movements: [movement(1, 10)] } });
}
test('invalid date, count, precision and identity are rejected', () => {
  assert.equal(validClosureInput(input), true);
  for (const patch of [{ countedAmount: NaN }, { countedAmount: -1 }, { countedAmount: 1.001 }, { requestId: '' }, { closureDate: '2026-02-30' }, { closureTime: '25:00' }]) assert.equal(validClosureInput({ ...input, ...patch }), false);
});
test('receipt verifies actual difference, IDs and replay flag', () => {
  assert.equal(readClosureReceipt(receipt, input).differenceAmount, -2);
  for (const patch of [{ closureId: null }, { expectedAmount: ' ' }, { differenceAmount: 0 }, { replayed: null }, { reconciliationItemId: undefined }]) assert.throws(() => readClosureReceipt({ ...receipt, ...patch }, input));
});
test('Admin boundaries protect both preview and recording', async () => {
  for (const roles of [[], ['advisor'], ['master'], ['counter']]) {
    reset(); state.roles = roles; await assert.rejects(createAdminAccountClosure(input)); await assert.rejects(previewAdminAccountClosure(input)); assert.equal(state.calls.length + state.reads, 0);
  }
});
test('canonical closure uses one call with stable request and exact submitted cut', async () => {
  reset(); assert.equal((await createAdminAccountClosure(input)).status, 'confirmed');
  const { requestId, ...command } = input;
  assert.deepEqual(state.calls, [{ name: 'create_account_closure_v1', params: { p_request_id: requestId, p_input: command } }]);
  state.data = { ...receipt, replayed: true }; const replay = await createAdminAccountClosure(input);
  assert.equal(replay.status, 'confirmed'); if (replay.status === 'confirmed') assert.equal(replay.receipt.replayed, true);
});
test('uncertain errors retain ambiguity and definitive rejections remain editable', async () => {
  reset(); state.offline = true; assert.equal((await createAdminAccountClosure(input)).status, 'uncertain');
  reset(); state.data = null; assert.equal((await createAdminAccountClosure(input)).status, 'uncertain');
  reset(); state.error = { code: '22023', message: 'Diferencia no permitida' }; assert.equal((await createAdminAccountClosure(input)).status, 'rejected');
  reset(); state.cacheFails = true; assert.equal((await createAdminAccountClosure(input)).status, 'confirmed');
});
test('bank preview uses entire day; cash respects intraday cut', async () => {
  reset(); state.tables.money_movements.push(movement(2, 7, '2026-09-12', '13:00'));
  let r = await previewAdminAccountClosure(input); assert.equal(r.status, 'ready'); if (r.status === 'ready') assert.equal(r.preview.expectedAmount, 17);
  reset('cash'); state.tables.money_movements.push(movement(2, 7, '2026-09-12', '13:00'));
  r = await previewAdminAccountClosure(input); if (r.status === 'ready') assert.equal(r.preview.expectedAmount, 10); else assert.fail(r.message);
});
test('preview preserves prior count, baseline and historical VES valuation', async () => {
  reset(); state.tables.money_account_closure_baselines = [{ money_account_id: 1, status: 'active', baseline_date: '2026-09-11', counted_amount: 100, counted_amount_usd: 1 }];
  state.tables.money_accounts[0].currency_code = 'VES'; state.tables.money_movements[0].amount_usd_equivalent = 0.1;
  state.tables.money_movements.push(movement(2, 99, '2026-09-11'));
  const r = await previewAdminAccountClosure(input); if (r.status !== 'ready') assert.fail(r.message);
  assert.equal(r.preview.expectedAmount, 110); assert.equal(r.preview.expectedAmountUsd, 1.1);
  state.tables.money_account_closures = [{ id: 11, money_account_id: 1, status: 'recorded', closure_date: '2026-09-11', closure_at: '2026-09-11T23:59:00-04:00', counted_amount: 105, counted_amount_usd: 1.05, created_at: '2026-09-11' }];
  const prior = await previewAdminAccountClosure(input); if (prior.status === 'ready') assert.equal(prior.preview.expectedAmount, 115); else assert.fail(prior.message);
});
test('POS starts at zero and excludes only linked prior settlement withdrawals', async () => {
  reset('pos'); state.tables.money_account_closures = [{ id: 11, money_account_id: 1, status: 'recorded', closure_date: '2026-09-11', closure_at: '2026-09-11T23:59:00-04:00', counted_amount: 100, counted_amount_usd: 100, created_at: '2026-09-11' }];
  state.tables.money_movements.push({ ...movement(2, 100), direction: 'outflow', movement_type: 'withdrawal', reference_code: 'closure-11' });
  const r = await previewAdminAccountClosure(input); if (r.status === 'ready') assert.equal(r.preview.expectedAmount, 10); else assert.fail(r.message);
});
test('preview loads beyond the API first page and never writes', async () => {
  reset(); state.tables.money_movements = Array.from({ length: 1001 }, (_, i) => movement(i + 1, 1));
  const r = await previewAdminAccountClosure(input); if (r.status === 'ready') assert.equal(r.preview.expectedAmount, 1001); else assert.fail(r.message);
  assert.equal(state.calls.length, 0);
});
test('failed preview is not a zero balance and invalid dates never read', async () => {
  reset(); state.readError = true; assert.equal((await previewAdminAccountClosure(input)).status, 'error');
  reset(); assert.equal((await previewAdminAccountClosure({ ...input, closureDate: '2026-02-30' })).status, 'error'); assert.equal(state.reads, 0);
});
test('legacy and Admin share preview while native form freezes uncertain attempts', () => {
  const src = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const legacy = src('src/app/app/master/dashboard/actions.ts');
  const preview = legacy.slice(legacy.indexOf('export async function previewMoneyAccountClosureAction'), legacy.indexOf('export async function rejectMoneyAccountClosureAction'));
  assert.match(preview, /loadAccountClosurePreview\(supabase, input\)/); assert.doesNotMatch(preview, /ServiceRole/);
  const form = src('src/app/app/admin/finanzas/cuentas/cierre/ClosureForm.tsx');
  assert.match(form, /busy.current = true/); assert.match(form, /fieldset disabled=\{pending \|\| uncertain\}/);
  assert.match(form, /if \(!attempt.current\)/); assert.match(form, /createAdminAccountClosure\(attempt.current\)/); assert.match(form, /if \(!cancelled\) setReview/);
});
