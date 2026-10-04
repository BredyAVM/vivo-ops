import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { paymentReviewSnapshot, type PaymentReviewReport } from '../../src/lib/admin-finance/payment-review-model.ts';

const reportBase: PaymentReviewReport = { id: 90, order_id: 2934, status: 'confirmed',
  confirmed_movement_id: 40, created_at: '2026-10-01T12:00:00Z', operation_date: '2026-10-01',
  reported_money_account_id: 3, reported_currency_code: 'VES', reported_amount: '51750',
  reported_exchange_rate_ves_per_usd: '860.2', reference_code: '123', payer_name: 'Cliente', notes: null, review_notes: null };
const group = '11111111-1111-4111-8111-111111111111';
const payment = { id: 40, money_account_id: 1, movement_group_id: group, order_id: 2934,
  payment_report_id: 90, movement_date: '2026-10-01', status: 'confirmed', direction: 'inflow',
  movement_type: 'order_payment', currency_code: 'VES', amount: '5175.00',
  amount_usd_equivalent: '6.015', exchange_rate_ves_per_usd: '860.2', reference_code: 'Punto real 123',
  counterparty_name: 'Cliente', description: 'Pago', notes: null, void_reason: null };
const fee = { ...payment, id: 41, money_account_id: 2, amount: '1', currency_code: 'USD',
  direction: 'outflow', movement_type: 'fee_charge' };
let report = { ...reportBase }, rows = [{ ...payment }, { ...fee }];
let allowed = true, wrongCount = false, missingAccount = false, canonicalError = false, cacheError = false;
const reads: string[] = [], voids: unknown[] = [], invalidations: string[] = [];
const accounts = [{ id: 1, name: 'Punto real' }, { id: 2, name: 'Banco comisión' }, { id: 3, name: 'Cuenta reportada' }];
const client = { from(table: string) {
  reads.push(table);
  const filters: Record<string, unknown> = {};
  let limit = 1000;
  function selected() {
    const data = table === 'payment_reports' ? [report] : table === 'money_accounts'
      ? accounts.filter(a => !missingAccount || a.id !== 2) : rows;
    return data.filter(row => Object.entries(filters).every(([key, value]) => Array.isArray(value)
      ? value.includes(Reflect.get(row, key)) : Reflect.get(row, key) === value));
  }
  const q = { select() { return q; }, eq(key: string, value: unknown) { filters[key] = value; return q; },
    in(key: string, value: unknown) { filters[key] = value; return q; }, order() { return q; },
    limit(n: number) { limit = n; return q; },
    async maybeSingle() { return { data: selected()[0] ?? null, error: null }; },
    then(resolve: (v: unknown) => unknown, reject: (v: unknown) => unknown) {
      const data = selected();
      return Promise.resolve({ data: data.slice(0, limit), count: data.length + (wrongCount ? 1 : 0), error: null }).then(resolve, reject);
    },
  };
  return q;
} };
Reflect.set(globalThis, '__paymentVoidInline', {
  context() { if (!allowed) throw new Error('No autorizado'); return { supabase: client }; },
  void(input: unknown) { voids.push(input); return canonicalError ? { ok: false, message: 'El fondo ya fue utilizado.' }
    : { ok: true, movementIds: [40, 41], paymentReportIds: [90] }; },
  invalidate(path: string) { if (cacheError) throw new Error('Cache offline'); invalidations.push(path); },
});
registerHooks({ resolve(specifier, context, next) {
  const mocks: Record<string, string> = {
    'server-only': 'export {};',
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__paymentVoidInline.context()}',
    'next/cache': 'export function revalidatePath(p){globalThis.__paymentVoidInline.invalidate(p)}',
    '@/app/app/master/dashboard/actions': 'export async function voidFinancialMovementAction(v){return globalThis.__paymentVoidInline.void(v)};export async function confirmPaymentReportAction(){throw new Error("Unexpected confirm")};export async function rejectPaymentReportAction(){throw new Error("Unexpected reject")}',
  };
  if (mocks[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL('../../src/' + specifier.slice(2) + '.ts', import.meta.url).href, context);
  if (/^\.\/(movement-detail-|payment-(void-data|review-model))/.test(specifier) && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { readPaymentVoidPreview } = await import('../../src/lib/admin-finance/payment-void-data.ts');
const { loadAdminPaymentReviewAction, voidAdminCustomerPaymentAction } = await import('../../src/lib/admin-finance/payment-review-actions.ts');
function reset() {
  report = { ...reportBase }; rows = [{ ...payment }, { ...fee }];
  allowed = true; wrongCount = false; missingAccount = false; canonicalError = false; cacheError = false;
  reads.length = 0; voids.length = 0; invalidations.length = 0;
}
async function command() {
  const preview = await readPaymentVoidPreview(client as never, report);
  return { reportId: report.id, orderId: report.order_id, reportSnapshot: paymentReviewSnapshot(report),
    fingerprint: preview.fingerprint, reason: '  Monto   mal registrado  ' };
}
test('preview derives actual confirmed amount/account, not the original reported values', async () => {
  reset(); const result = await loadAdminPaymentReviewAction(90, 2934);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const preview = result.context.voidPreview!;
  assert.equal(result.context.accountName, 'Cuenta reportada');
  assert.equal(preview.accountName, 'Punto real'); assert.equal(preview.amount, 5175);
  assert.equal(preview.currency, 'VES'); assert.equal(preview.reference, 'Punto real 123');
  assert.equal(preview.movements.length, 2); assert.equal(preview.movements[1].currency, 'USD');
  assert.equal(result.context.pendingUsd, null); assert.equal(voids.length, 0);
});
test('unauthorized users cannot read or void, before any business query', async () => {
  reset(); const input = await command(); reads.length = 0; allowed = false;
  assert.equal((await loadAdminPaymentReviewAction(90, 2934)).ok, false);
  assert.equal((await voidAdminCustomerPaymentAction(input)).ok, false);
  assert.equal(reads.length, 0); assert.equal(voids.length, 0);
});
test('a report must link to the same persisted payment and order', async () => {
  for (const field of ['order_id', 'payment_report_id']) {
    reset(); Reflect.set(rows[0], field, 999);
    await assert.rejects(readPaymentVoidPreview(client as never, report), /vínculo/);
    assert.equal(voids.length, 0);
  }
  for (const change of [{ status: 'rejected' }, { confirmed_movement_id: null }]) {
    reset(); Object.assign(report, change);
    await assert.rejects(readPaymentVoidPreview(client as never, report), /confirmado vinculado/);
  }
});
test('truncated group or missing fee account cannot offer an incomplete cancellation', async () => {
  for (const scenario of ['count', 'account']) {
    reset(); wrongCount = scenario === 'count'; missingAccount = scenario === 'account';
    const result = await loadAdminPaymentReviewAction(90, 2934);
    assert.equal(result.ok, true);
    if (result.ok) { assert.equal(result.context.voidPreview, null); assert.ok(result.context.voidUnavailable); }
    assert.equal(voids.length, 0);
  }
});
test('changed report, root, fees, status or new linked movements fail closed', async () => {
  for (const scenario of ['report', 'amount', 'fee', 'new', 'status']) {
    reset(); const input = await command();
    if (scenario === 'report') report.reported_amount = '1';
    if (scenario === 'amount') rows[0].amount = '51750';
    if (scenario === 'fee') rows[1].amount = '2';
    if (scenario === 'new') rows.push({ ...fee, id: 42 });
    if (scenario === 'status') rows[1].status = 'voided';
    assert.equal((await voidAdminCustomerPaymentAction(input)).ok, false, scenario);
    assert.equal(voids.length, 0);
  }
});
test('closure routes and canonical dependencies stay protected; invalid reason never delegates', async () => {
  reset(); rows[0].reference_code = 'closure-200';
  assert.equal((await voidAdminCustomerPaymentAction(await command())).ok, false); assert.equal(voids.length, 0);
  reset(); canonicalError = true;
  const result = await voidAdminCustomerPaymentAction(await command());
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.message, /fondo ya fue utilizado/);
  assert.equal(invalidations.length, 0);
  for (const reason of ['', 'error', 'a'.repeat(501)]) {
    reset(); assert.equal((await voidAdminCustomerPaymentAction({ ...await command(), reason })).ok, false);
    assert.equal(voids.length, 0);
  }
});
test('valid submission reuses the canonical group command exactly once, no direct writes', async () => {
  reset(); const result = await voidAdminCustomerPaymentAction(await command());
  assert.equal(result.ok, true);
  assert.deepEqual(voids, [{ movementId: 40, movementGroupId: group, reason: 'Monto mal registrado' }]);
  assert.ok(invalidations.includes('/app/admin'));
  reset(); cacheError = true;
  assert.equal((await voidAdminCustomerPaymentAction(await command())).ok, true);
  assert.equal(voids.length, 1);
});
test('opening the accessible popup does not void; reason and explicit final confirmation are required', () => {
  const source = readFileSync('src/app/app/admin/finanzas/pagos/PaymentReportVoid.tsx', 'utf8');
  assert.match(source, /role="dialog" aria-modal="true"/); assert.match(source, /useDialogFocus/);
  assert.match(source, /Sí, anular pago/); assert.match(source, /Motivo de anulación/);
  assert.match(source, /no devuelve dinero del banco ni cancela la orden/);
  assert.match(source, /formatOrderDisplayNumber\(report.order_id\)/);
  assert.match(source, /busy.current = true/); assert.match(source, /max-h-\[calc\(100dvh/);
  assert.doesNotMatch(source, /useEffect|setInterval/);
  assert.match(source, /onClick=\{\(\) => \{ setError\(''\); setOpen\(true\); \}\}/);
});
