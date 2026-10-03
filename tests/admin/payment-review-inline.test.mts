import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { paymentReviewConfirmation, paymentReviewDate, paymentReviewSnapshot,
  type PaymentReviewDecision, type PaymentReviewReport,
} from '../../src/lib/admin-finance/payment-review-model.ts';

const original: PaymentReviewReport = { id: 31, order_id: 3057, status: 'pending',
  created_at: '2026-10-03T02:00:00Z', operation_date: null,
  reported_money_account_id: 5, reported_currency_code: 'VES', reported_amount: '5175.00',
  reported_exchange_rate_ves_per_usd: '860.200001', reference_code: '123456',
  payer_name: 'Cliente', notes: null, review_notes: null };
let report = { ...original }, allowed = true, queryError = false, accountActive = true, failedCommand = false;
let balance: unknown = '6.02';
const reads: string[] = [], confirmed: unknown[] = [], rejected: unknown[] = [], invalidated: unknown[] = [];
const state = {
  context() {
    if (!allowed) throw new Error('No autorizado');
    return { supabase: {
      from(table: string) {
        reads.push(table);
        const filters: Record<string, unknown> = {};
        const q = {
          select() { return q; },
          eq(field: string, value: unknown) { filters[field] = value; return q; },
          async maybeSingle() {
            return { error: queryError ? { message: 'offline' } : null,
              data: table === 'payment_reports'
                ? filters.id === report.id && filters.order_id === report.order_id ? report : null
                : { name: 'Banco de prueba', currency_code: 'VES', is_active: accountActive } };
          },
        };
        return q;
      },
      async rpc(name: string, input: unknown) {
        reads.push(name);
        assert.deepEqual(input, { p_order_id: 3057, p_operation_date: null, p_active_bs_rate: '860.200001' });
        return { data: [{ pending_usd: balance }], error: null };
      },
    } };
  },
  async confirm(input: unknown) { if (failedCommand) throw new Error('Transacción rechazada'); confirmed.push(input); },
  async reject(input: unknown) { if (failedCommand) throw new Error('Reporte ya revisado'); rejected.push(input); },
};
Reflect.set(globalThis, '__inlinePaymentReview', state);
registerHooks({ resolve(specifier, context, next) {
  const mocks: Record<string, string> = {
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__inlinePaymentReview.context()}',
    'next/cache': 'export function revalidatePath(...v){globalThis.__inlinePaymentInvalidations.push(v)}',
    '@/app/app/master/dashboard/actions': 'export async function confirmPaymentReportAction(v){return globalThis.__inlinePaymentReview.confirm(v)};export async function rejectPaymentReportAction(v){return globalThis.__inlinePaymentReview.reject(v)}',
  };
  if (mocks[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  if (specifier === '@/lib/admin-finance/payment-review-model')
    return { url: new URL('../../src/lib/admin-finance/payment-review-model.ts', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
Reflect.set(globalThis, '__inlinePaymentInvalidations', invalidated);
const { loadAdminPaymentReviewAction, reviewAdminPaymentAction } = await import('../../src/lib/admin-finance/payment-review-actions.ts');
function input(): Extract<PaymentReviewDecision, { decision: 'confirm' }> {
  return { reportId: 31, orderId: 3057, reportSnapshot: paymentReviewSnapshot(original), decision: 'confirm',
    date: '2026-10-02', rate: 860.200001, handling: null };
}
function reset() {
  report = { ...original }; allowed = true; queryError = false; accountActive = true; failedCommand = false;
  balance = '6.02';
  reads.length = 0; confirmed.length = 0; rejected.length = 0; invalidated.length = 0;
}
test('precise rate, native amount, reference and Caracas date survive confirmation without a new conversion', () => {
  assert.equal(paymentReviewDate(original), '2026-10-02');
  const command = paymentReviewConfirmation(original, input(), { name: 'Banco', currency_code: 'VES', is_active: true });
  assert.equal(command.confirmedAmount, 5175);
  assert.equal(command.confirmedExchangeRateVesPerUsd, 860.200001);
  assert.equal(command.referenceCode, '123456');
  assert.equal(command.requireExplicitHandling, true);
  assert.equal(command.overrideOperationDate, true);
  const usd = { ...original, reported_currency_code: 'USD', reported_amount: 20 };
  assert.equal(paymentReviewConfirmation(usd, input(), { name: 'Caja', currency_code: 'USD', is_active: true }).confirmedExchangeRateVesPerUsd, null);
  for (const change of [{ rate: 0 }, { rate: NaN }, { date: '2026-02-30' }])
    assert.throws(() => paymentReviewConfirmation(original, { ...input(), ...change }, { name: 'Banco', currency_code: 'VES', is_active: true }));
});
test('admin permission is rechecked for read, confirmation and rejection before any business read', async () => {
  reset(); allowed = false;
  for (const result of [await loadAdminPaymentReviewAction(31, 3057),
    await reviewAdminPaymentAction(input()),
    await reviewAdminPaymentAction({ ...input(), decision: 'reject', reason: 'No coincide' })]) {
    assert.equal(result.ok, false);
  }
  assert.equal(reads.length, 0); assert.equal(confirmed.length, 0); assert.equal(rejected.length, 0);
});
test('review scopes the report to its order and loads only one current balance on explicit opening', async () => {
  reset();
  const result = await loadAdminPaymentReviewAction(31, 3057);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.context.accountName, 'Banco de prueba'); assert.equal(result.context.pendingUsd, 6.02); }
  assert.deepEqual(reads, ['payment_reports', 'money_accounts', 'get_order_financial_state']);
  assert.equal((await loadAdminPaymentReviewAction(31, 3058)).ok, false);
  assert.equal((await loadAdminPaymentReviewAction(NaN, 3057)).ok, false);
});
test('missing or malformed balance is unknown, not an invented zero debt', async () => {
  for (const invalid of [null, '', '6.015...']) {
    reset(); balance = invalid;
    const result = await loadAdminPaymentReviewAction(31, 3057);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.context.pendingUsd, null);
  }
});
test('confirmation delegates to the atomic canonical command and invalidates the Admin shell', async () => {
  reset();
  assert.equal((await reviewAdminPaymentAction(input())).ok, true);
  assert.equal(confirmed.length, 1);
  assert.equal(rejected.length, 0);
  assert.ok(invalidated.some(v => JSON.stringify(v) === '["/app/admin","layout"]'));
  assert.deepEqual(confirmed[0], paymentReviewConfirmation(original, input(), { name: 'Banco de prueba', currency_code: 'VES', is_active: true }));
});
test('rejection requires a trimmed reason and uses the existing audited rejection', async () => {
  reset();
  assert.equal((await reviewAdminPaymentAction({ ...input(), decision: 'reject', reason: '   ' })).ok, false);
  assert.equal(rejected.length, 0);
  assert.equal((await reviewAdminPaymentAction({ ...input(), decision: 'reject', reason: '  No coincide el comprobante  ' })).ok, true);
  assert.deepEqual(rejected, [{ reportId: 31, reviewNotes: 'No coincide el comprobante' }]);
});
test('stale decisions, changed amounts, inactive accounts and database failures never confirm or refresh as success', async () => {
  for (const scenario of ['decided', 'changed', 'account', 'read', 'command']) {
    reset();
    if (scenario === 'decided') report.status = 'confirmed';
    if (scenario === 'changed') report.reported_amount = '51750';
    if (scenario === 'account') accountActive = false;
    if (scenario === 'read') queryError = true;
    if (scenario === 'command') failedCommand = true;
    assert.equal((await reviewAdminPaymentAction(input())).ok, false, scenario);
    assert.equal(confirmed.length, 0); assert.equal(invalidated.length, 0);
  }
});
test('confirmation is a separate accessible popup; expanding or opening it cannot save a payment', () => {
  const source = readFileSync('src/app/app/admin/finanzas/pagos/PaymentReportReview.tsx', 'utf8');
  const expand = source.slice(source.indexOf('function expand()'), source.indexOf('function submit('));
  assert.match(expand, /loadAdminPaymentReviewAction/);
  assert.doesNotMatch(expand, /reviewAdminPaymentAction/);
  assert.match(source, /setConfirmationOpen\(true\)/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /Banco \/ cuenta/); assert.match(source, /Referencia/);
  assert.match(source, /Sí, confirmar pago/); assert.match(source, /useDialogFocus/);
  assert.match(source, /busy\.current = true/);
  assert.doesNotMatch(source, /useEffect|setInterval|router\.push/);
});
