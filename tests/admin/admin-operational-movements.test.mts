import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adminMovementHref, adminMovementHistoryHref, resolveAdminMovementContext } from '../../src/lib/admin-finance/movement-navigation.ts';

const accounts = [{ id: 1, isActive: true }, { id: 2, isActive: false }];
test('income and expense links preserve the selected account and do not submit operations', () => {
  assert.equal(adminMovementHref('outflow', 1), '/app/admin/finanzas/cuentas/movimiento?tipo=outflow&cuenta=1');
  assert.equal(adminMovementHref('inflow'), '/app/admin/finanzas/cuentas/movimiento?tipo=inflow');
  assert.equal(resolveAdminMovementContext({ cuenta: '1', tipo: 'outflow' }, accounts).accountId, 1);
  assert.equal(resolveAdminMovementContext({}, accounts).invalidAccount, false);
});
test('unavailable accounts never silently select a different account', () => {
  for (const cuenta of ['2', '999', '0', '-1', '1.5', 'NaN', 'Infinity', '']) {
    assert.equal(resolveAdminMovementContext({ cuenta }, accounts).invalidAccount, true, cuenta);
    assert.equal(resolveAdminMovementContext({ cuenta }, accounts).accountId, null, cuenta);
  }
});
test('history opens the submitted account and date, not a currently selected filter', () => {
  assert.equal(adminMovementHistoryHref(1, '2026-09-12'), '/app/admin/finanzas/cuentas/1?vista=movements&desde=2026-09-12&hasta=2026-09-12');
});

const state = {
  roles: ['admin'] as string[],
  account: { id: 1, name: 'Caja prueba', currency_code: 'USD', is_active: true },
  inserts: [] as Array<Array<Record<string, unknown>>>,
  invalidations: [] as string[],
  failInsert: false,
};
const supabase = {
  from(table: string) {
    const query = {
      select() { return query; }, eq() { return query; }, limit() { return query; },
      async maybeSingle() { return { data: table === 'money_accounts' ? state.account : { id: 1 }, error: null }; },
      async insert(rows: Array<Record<string, unknown>>) {
        if (state.failInsert) return { error: { message: 'No se pudo guardar' } };
        state.inserts.push(rows);
        return { error: null };
      },
    };
    return query;
  },
};
Reflect.set(globalThis, '__movementTest', {
  context(admin: boolean) {
    if (!state.roles.includes('admin') && (admin || !state.roles.includes('master'))) throw new Error('No autorizado');
    return { supabase, user: { id: 'test-admin' }, roles: state.roles };
  },
  revalidate(path: string) { state.invalidations.push(path); },
});
const nodeModule = await import('node:module');
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: {
  resolve: (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => { url: string }) => { url: string; shortCircuit?: boolean };
}) => void;
registerHooks({ resolve(specifier, context, next) {
  const modules: Record<string, string> = {
    '@/lib/auth': 'export async function requireAdminContext(){ return globalThis.__movementTest.context(true); } export async function requireMasterOrAdminContext(){ return globalThis.__movementTest.context(false); }',
    'next/cache': 'export function revalidatePath(path){ globalThis.__movementTest.revalidate(path); }',
    '@/lib/push': 'export async function sendPushToRoleDevices(){}',
  };
  if (modules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    return next(new URL(`../../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
  }
  return next(specifier, context);
} });
const { createAdminMoneyMovementAction } = await import('../../src/app/app/admin/finanzas/cuentas/movimiento/actions.ts');
const input = { direction: 'outflow' as const, moneyAccountId: 1, amount: 5, movementDate: '2026-09-12', description: 'Compra caja chica' };
function reset() {
  state.roles = ['admin']; state.account.currency_code = 'USD'; state.account.is_active = true;
  state.inserts = []; state.invalidations = []; state.failInsert = false;
}
test('Admin records a petty cash expense through the existing command and refreshes Admin', async () => {
  reset();
  const result = await createAdminMoneyMovementAction(input);
  assert.equal(result.status, 'confirmed');
  assert.equal(state.inserts.length, 1);
  const row = state.inserts[0][0];
  assert.equal(row.amount, 5); assert.equal(row.money_account_id, 1);
  assert.equal(row.created_by_user_id, 'test-admin'); assert.equal(row.direction, 'outflow');
  assert.equal(row.approval_required, false);
  assert.ok(state.invalidations.includes('/app/admin'));
});
test('the Admin action rejects anonymous, advisor and Master before any write', async () => {
  for (const roles of [[], ['advisor'], ['master']]) {
    reset(); state.roles = roles;
    await assert.rejects(createAdminMoneyMovementAction(input), /No autorizado/);
    assert.equal(state.inserts.length, 0);
  }
});
test('VES preserves native amount, rate, fee group and equivalent valuation', async () => {
  reset(); state.account.currency_code = 'VES';
  const result = await createAdminMoneyMovementAction({ ...input, amount: 1000, feeAmount: 20, exchangeRateVesPerUsd: 100 });
  assert.equal(result.totalUsd, 10.2);
  assert.equal(state.inserts[0].length, 2);
  const [expense, fee] = state.inserts[0];
  assert.equal(expense.amount, 1000); assert.equal(expense.exchange_rate_ves_per_usd, 100);
  assert.equal(expense.amount_usd_equivalent, 10); assert.equal(fee.amount_usd_equivalent, 0.2);
  assert.equal(expense.movement_group_id, fee.movement_group_id);
});
test('income does not create an expense fee or pretend to be an order payment', async () => {
  reset();
  await createAdminMoneyMovementAction({ ...input, direction: 'inflow', feeAmount: 50 });
  assert.equal(state.inserts[0].length, 1);
  assert.equal(state.inserts[0][0].movement_type, 'other_income');
  assert.equal(state.inserts[0][0].order_id, null);
});
test('inactive accounts, invalid amounts and missing rates remain blocked server-side', async () => {
  reset(); state.account.is_active = false;
  await assert.rejects(createAdminMoneyMovementAction(input), /inactiva/);
  reset(); await assert.rejects(createAdminMoneyMovementAction({ ...input, amount: -1 }), /mayor a 0/);
  state.account.currency_code = 'VES';
  await assert.rejects(createAdminMoneyMovementAction(input), /tasa válida/);
  assert.equal(state.inserts.length, 0);
});
test('save failures are not presented as confirmed transactions', async () => {
  reset(); state.failInsert = true;
  await assert.rejects(createAdminMoneyMovementAction(input), /No se pudo guardar/);
  assert.equal(state.invalidations.length, 0);
});
test('form blocks concurrent submit and freezes fields, without claiming database idempotency', () => {
  const form = readFileSync(new URL('../../src/app/app/master/ops/finance/MasterOpsMoneyMovementForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /if \(busyRef.current\) return/);
  assert.match(form, /<fieldset disabled=\{isPending\}/);
  assert.match(form, /submitAction = createMasterOpsMoneyMovementAction/);
  assert.match(form, /showAdminHistory = false/);
  assert.match(form, /adminMovementHistoryHref\(Number\(accountId\), movementDate\)/);
});
