import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { movementReturnHref, movementSnapshot, movementVoidBlock, parseAccountMovement, positiveMovementId } from '../../src/lib/admin-finance/movement-detail-model.ts';

const groupId = '11111111-1111-4111-8111-111111111111';
const baseRow = { id: 40, money_account_id: 1, movement_group_id: groupId, order_id: 2934,
  payment_report_id: 90, movement_date: '2026-10-01', status: 'confirmed', direction: 'inflow', movement_type: 'order_payment',
  currency_code: 'VES', amount: '5175.00', amount_usd_equivalent: '6.015', exchange_rate_ves_per_usd: '860.2',
  reference_code: 'Punto 123', counterparty_name: 'Cliente', description: 'Pago', notes: null, void_reason: null };
const feeRow = { ...baseRow, id: 41, money_account_id: 2, amount: '1', currency_code: 'USD', direction: 'outflow', movement_type: 'fee_charge' };
const state = { roles: ['admin'], rows: [baseRow, feeRow], queries: [] as string[], voids: [] as unknown[], invalidations: [] as string[],
  missingAccount: false, wrongCount: false, readError: false, voidError: false };
const client = { from(table: string) {
  state.queries.push(table);
  const filters: Record<string, unknown> = {};
  let max = 1000;
  const builder = {
    select() { return builder; }, eq(key: string, value: unknown) { filters[key] = value; return builder; },
    in(key: string, value: unknown) { filters[key] = value; return builder; }, order() { return builder; }, limit(n: number) { max = n; return builder; },
    async maybeSingle() { return { data: state.rows.find(row => Object.entries(filters).every(([key, value]) => Reflect.get(row, key) === value)) ?? null, error: state.readError ? { message: 'Lectura fallida' } : null }; },
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      const data = table === 'money_accounts' ? (state.missingAccount ? [{ id: 1, name: 'Punto' }] : [{ id: 1, name: 'Punto' }, { id: 2, name: 'Banco' }])
        : state.rows.filter(row => Object.entries(filters).every(([key, value]) => Reflect.get(row, key) === value));
      return Promise.resolve({ data: data.slice(0, max), error: null, count: state.wrongCount ? data.length + 1 : data.length }).then(resolve, reject);
    },
  };
  return builder;
} };
Reflect.set(globalThis, '__movementDetailTest', {
  context() { if (!state.roles.includes('admin')) throw new Error('No autorizado'); return { supabase: client }; },
  revalidate(path: string) { state.invalidations.push(path); },
  void(input: unknown) { state.voids.push(input); return state.voidError ? { ok: false, message: 'Anula desde liquidación de comisiones.' } : { ok: true, movementIds: [40, 41], paymentReportIds: [90] }; },
});
const { registerHooks } = await import('node:module');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
  const mocks: Record<string, string> = {
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__movementDetailTest.context();}',
    'next/cache': 'export function revalidatePath(p){globalThis.__movementDetailTest.revalidate(p);}',
    '@/app/app/master/dashboard/actions': 'export async function voidFinancialMovementAction(p){return globalThis.__movementDetailTest.void(p);}',
  };
  if (mocks[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL('../../src/' + specifier.slice(2) + '.ts', import.meta.url).href, context);
  if (specifier.startsWith('./movement-detail-')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { readAccountMovementDetail } = await import('../../src/lib/admin-finance/movement-detail-data.ts');
const { voidAccountMovementAction } = await import('../../src/lib/admin-finance/movement-detail-actions.ts');
function reset() { state.roles = ['admin']; state.rows = [{ ...baseRow }, { ...feeRow }]; state.queries = []; state.voids = []; state.invalidations = []; state.missingAccount = false; state.wrongCount = false; state.readError = false; state.voidError = false; }
async function input() { const detail = await readAccountMovementDetail(client as never, 1, 40); return { accountId: 1, movementId: 40, fingerprint: detail!.fingerprint, reason: 'Monto mal registrado' }; }

test('preserves the native amount and saved conversion, without rounding or using today’s rate', () => {
  const parsed = parseAccountMovement(baseRow);
  assert.equal(parsed.amount, 5175); assert.equal(parsed.usd, 6.015); assert.equal(parsed.rate, 860.2);
  assert.equal(parsed.paymentReportId, 90);
  for (const value of [null, undefined, '', 0, -1, 1.5, NaN, Infinity, true, '1e3']) assert.equal(positiveMovementId(value), null);
  for (const invalid of [{ amount: null }, { amount: '' }, { currency_code: 'EUR' }, { status: 'unknown' }, { order_id: true }]) assert.throws(() => parseAccountMovement({ ...baseRow, ...invalid }));
});
test('details read only the requested movement and its group, including fees and other accounts', async () => {
  reset(); const result = await readAccountMovementDetail(client as never, 1, 40);
  assert.equal(result!.movements.length, 2); assert.equal(result!.accountNames[2], 'Banco');
  assert.deepEqual(state.queries, ['money_movements', 'money_movements', 'money_accounts']);
  assert.equal(state.voids.length, 0);
});
test('wrong-account ids do not reveal or void the movement', async () => {
  reset(); assert.equal(await readAccountMovementDetail(client as never, 3, 40), null);
  assert.equal((await voidAccountMovementAction({ ...await input(), accountId: 3 })).ok, false);
  assert.equal(state.voids.length, 0);
});
test('anonymous, advisor and Master cannot submit the Admin cancellation action', async () => {
  for (const roles of [[], ['advisor'], ['master']]) {
    reset(); state.roles = roles;
    await assert.rejects(voidAccountMovementAction({ accountId: 1, movementId: 40, fingerprint: '', reason: 'Error de carga' }), /No autorizado/);
    assert.equal(state.queries.length, 0); assert.equal(state.voids.length, 0);
  }
});
test('complete preview is required; truncated groups and missing accounts fail closed', async () => {
  reset(); state.wrongCount = true; await assert.rejects(readAccountMovementDetail(client as never, 1, 40), /operación completa/);
  reset(); state.missingAccount = true; await assert.rejects(readAccountMovementDetail(client as never, 1, 40), /cuentas vinculadas/);
  reset(); state.readError = true; await assert.rejects(readAccountMovementDetail(client as never, 1, 40), /Lectura fallida/);
});
test('stale previews, added fees, changed amounts or statuses cannot submit a cancellation', async () => {
  for (const field of ['amount', 'status', 'money_account_id']) {
    reset(); const command = await input(); Reflect.set(state.rows[1], field, field === 'amount' ? '2' : field === 'status' ? 'pending' : 1);
    const result = await voidAccountMovementAction(command); assert.equal(result.ok, false); assert.equal(state.voids.length, 0);
  }
  reset(); const command = await input(); state.rows.push({ ...feeRow, id: 42 });
  assert.equal((await voidAccountMovementAction(command)).ok, false); assert.equal(state.voids.length, 0);
});
test('closures, voided, rejected or mixed-status groups remain protected', async () => {
  reset(); state.rows[0].reference_code = 'closure-200';
  assert.equal((await voidAccountMovementAction(await input())).ok, false); assert.equal(state.voids.length, 0);
  for (const status of ['rejected', 'voided']) { reset(); state.rows[1].status = status;
    assert.equal((await voidAccountMovementAction(await input())).ok, false); assert.equal(state.voids.length, 0); }
  assert.match(movementVoidBlock([parseAccountMovement({ ...baseRow, status: 'voided' })])!, /ya está anulada/);
});
test('valid operation delegates once to the canonical transactional command, not direct table updates', async () => {
  reset(); const result = await voidAccountMovementAction(await input()); assert.equal(result.ok, true);
  assert.deepEqual(state.voids, [{ movementId: 40, movementGroupId: groupId, reason: 'Monto mal registrado' }]);
  assert.ok(state.invalidations.includes('/app/admin/finanzas/cuentas'));
  reset(); state.voidError = true; const rejected = await voidAccountMovementAction(await input());
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.match(rejected.message, /liquidación/);
  assert.equal(state.invalidations.length, 0);
});
test('reason and ids are validated before querying or writing', async () => {
  for (const changed of [{ reason: 'error' }, { reason: ' '.repeat(6) }, { reason: 'a'.repeat(501) }, { accountId: 0 }, { movementId: -1 }]) {
    reset(); const result = await voidAccountMovementAction({ accountId: 1, movementId: 40, fingerprint: '', reason: 'Error de monto', ...changed });
    assert.equal(result.ok, false); assert.equal(state.queries.length, 0); assert.equal(state.voids.length, 0);
  }
});
test('return navigation preserves period/page but rejects redirects and other accounts', () => {
  const base = '/app/admin/finanzas/cuentas/1';
  assert.equal(movementReturnHref(1, `${base}?desde=2026-09-07&hasta=2026-09-13&estado=confirmed&page=2`), `${base}?desde=2026-09-07&hasta=2026-09-13&estado=confirmed&page=2`);
  for (const invalid of ['https://evil.test', '//evil.test', '/app/admin/finanzas/cuentas/2?x=1', `${base}?x=1#evil`]) assert.equal(movementReturnHref(1, invalid), base);
});
test('snapshot is stable regardless of group order', () => {
  assert.equal(movementSnapshot([parseAccountMovement(baseRow), parseAccountMovement(feeRow)]), movementSnapshot([parseAccountMovement(feeRow), parseAccountMovement(baseRow)]));
});
test('compact surfaces fit columns, wrap tabs and load movement details only on request', () => {
  const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  const orders = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(orders, /isAdminSurface \? "w-full table-fixed/); assert.match(orders, /compact=\{isAdminSurface\}/);
  assert.match(orders, /isAdminSurface \? "min-w-0" : "overflow-x-auto"/);
  const account = read('src/app/app/admin/finanzas/cuentas/_components/AccountDetail.tsx');
  assert.match(account, /Detalle de cuenta" className="flex flex-wrap/); assert.doesNotMatch(account, /text-\[clamp/);
  assert.match(account, /formatOrderDisplayNumber\(row.orderId\)/); assert.match(account, /href=\{movementHref\(row.id\)\} prefetch=\{false\}/);
  const form = read('src/app/app/admin/finanzas/cuentas/[accountId]/movimientos/[movementId]/VoidMovementForm.tsx');
  assert.match(form, /inFlight.current/); assert.match(form, /no devuelve dinero del banco/); assert.match(form, /Revisé la operación completa/);
});
