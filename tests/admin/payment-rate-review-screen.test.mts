import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-ignore Node 24 provides registerHooks; this repository still uses Node 20 type declarations.
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { paymentActionFailure, PAYMENT_RATE_REVIEW_REQUIRED } from '../../src/lib/payments/action-result.ts';
import { paymentRateCoveragePreview, type PaymentRateReview } from '../../src/lib/payments/rate-review-model.ts';

let role = 'admin', rpcFailure: unknown = null, authFailure = false, confirmFailure: unknown = null;
let response: unknown = { available: false };
const calls: Array<{ name: string; args: unknown }> = [], confirmations: unknown[] = [];
const shared = {
  async context(admin = false) {
    if (authFailure || (admin ? role !== 'admin' : !['master', 'admin'].includes(role))) throw new Error('No autorizado.');
    return { supabase: { async rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { data: response, error: rpcFailure };
    } } };
  },
  async confirm(input: unknown) { if (confirmFailure) throw confirmFailure; confirmations.push(input); },
};
Reflect.set(globalThis, '__rateScreen', shared);
const root = new URL('../../', import.meta.url);
registerHooks({
  resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) {
    if (specifier === '@/lib/auth') return { url: 'data:text/javascript,' + encodeURIComponent(
      'export const requireAdminContext=()=>globalThis.__rateScreen.context(true);export const requireMasterOrAdminContext=()=>globalThis.__rateScreen.context();'), shortCircuit: true };
    const aliases: Record<string, string> = {
      '@/lib/payments/action-result': 'src/lib/payments/action-result.ts',
      '@/lib/payments/rate-review-model': 'src/lib/payments/rate-review-model.ts',
      '@/lib/payments/rate-review-actions': 'src/lib/payments/rate-review-actions.ts',
    };
    if (aliases[specifier]) return { url: new URL(aliases[specifier], root).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url: string, context: unknown, next: (url: string, context: unknown) => unknown) {
    if (url.endsWith('/PaymentRateReview.tsx')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    return next(url, context);
  },
});
const { readPaymentRateReviewAction, approvePaymentRateReviewAction } = await import('../../src/lib/payments/rate-review-actions.ts');
// Execute the exact action wrapper, isolating its many unrelated Ops imports.
const ops = readFileSync(new URL('src/app/app/master/ops/actions.ts', root), 'utf8');
const wrapper = ops.slice(ops.indexOf('export async function confirmMasterOpsPaymentReportAction('), ops.indexOf('export type MasterOpsMoneyLineInput'));
Reflect.set(globalThis, '__rateFailure', paymentActionFailure);
const { confirmMasterOpsPaymentReportAction } = await import('data:text/javascript,' + encodeURIComponent(ts.transpileModule(
  'const requireMasterOrAdminContext=()=>globalThis.__rateScreen.context(); const confirmPaymentReportAction=v=>globalThis.__rateScreen.confirm(v); const paymentActionFailure=globalThis.__rateFailure;\n' + wrapper,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
const { default: PaymentRateReview } = await import('../../src/components/orders/PaymentRateReview.tsx');

const review: PaymentRateReview = { available: true, canApprove: true, reportId: 3716, orderId: 3504,
  amountBs: 86493.16, recordedRate: 887.30, quoteRate: 884.75, quoteUsd: 97.76, quoteBs: 86493.16,
  decision: null, applied: false, quoteCandidates: [] };
const approval = { reportId: 3716, decision: 'quoted' as const, reason: 'Cliente con retención y pago a fecha acordada.' };
function reset() { role = 'admin'; authFailure = false; rpcFailure = null; confirmFailure = null;
  response = { ...review }; calls.length = 0; confirmations.length = 0; }

test('expected rate mismatch crosses production boundary as a clear, serializable instruction, not React #441', () => {
  const result = paymentActionFailure(new Error('Este pago puede corresponder a una tasa acordada anterior. Administración debe revisar la tasa antes de confirmarlo.'), 'fallback');
  assert.equal(result.code, 'rate_review_required');
  assert.equal(JSON.parse(JSON.stringify(result)).message, PAYMENT_RATE_REVIEW_REQUIRED);
  assert.match(result.message, /diferencia.*tasa.*presupuesto/);
  assert.match(result.message, /máster.*administrador/);
  assert.match(result.message, /No vuelvas a cargar/);
  assert.equal(paymentActionFailure(new Error('SQL constraint app_private.secret'), 'Seguro').message, 'Seguro');
  assert.equal(paymentActionFailure(new Error('Minified React error #441'), 'Seguro').message, 'Seguro');
  assert.match(paymentActionFailure(new Error('Ya existe un pago con esa cuenta, fecha, monto y referencia.'), 'fallback').message, /Ya existe un pago/);
});

test('real read and approval actions preserve IDs and evidence and never write payment or movement rows', async () => {
  reset(); assert.equal((await readPaymentRateReviewAction(3716)).ok, true);
  assert.deepEqual(calls, [{ name: 'read_payment_rate_review_v1', args: { p_report_id: 3716 } }]);
  response = { ...review, decision: 'quoted' };
  const result = await approvePaymentRateReviewAction(approval);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], { name: 'approve_payment_rate_review_v1', args: {
    p_report_id: 3716, p_decision: 'quoted', p_reason: approval.reason, p_quote_id: null } });
  assert.equal(confirmations.length, 0);
});

test('Master can consult but cannot approve; advisor/anonymous cannot consult; permissions rechecked server-side', async () => {
  reset(); role = 'master';
  assert.equal((await readPaymentRateReviewAction(3716)).ok, true);
  assert.equal((await approvePaymentRateReviewAction(approval)).ok, false);
  assert.equal(calls.length, 1);
  for (const denied of ['advisor', 'anonymous']) {
    role = denied;
    assert.equal((await readPaymentRateReviewAction(3716)).ok, false);
    assert.equal((await approvePaymentRateReviewAction(approval)).ok, false);
  }
  assert.equal(calls.length, 1);
});

test('invalid IDs, decisions, reasons and quote IDs cannot reach the RPC', async () => {
  reset();
  for (const id of [0, -1, NaN, 1.5]) assert.equal((await readPaymentRateReviewAction(id)).ok, false);
  for (const change of [{ reason: '' }, { reason: 'x'.repeat(1201) }, { quoteId: -1 }, { reportId: NaN }, { decision: 'other' as 'quoted' }])
    assert.equal((await approvePaymentRateReviewAction({ ...approval, ...change })).ok, false);
  assert.equal(calls.length, 0);
});

test('stale order, revoked approval and unexpected RPC failures are returned as data without false success', async () => {
  reset(); rpcFailure = { message: 'El saldo cambió por otro pago o ajuste. Revisa la orden.' };
  const failed = await approvePaymentRateReviewAction(approval);
  assert.equal(failed.ok, false); if (!failed.ok) assert.match(failed.message, /saldo cambió/);
  response = null; rpcFailure = null;
  assert.equal((await readPaymentRateReviewAction(3716)).ok, false);
  rpcFailure = { message: 'SQL internal failure' };
  const result = await readPaymentRateReviewAction(3716);
  assert.equal(result.ok, false); if (!result.ok) assert.doesNotMatch(result.message, /SQL/);
});

test('real Ops wrapper returns clear rejection and delegates unchanged native money, rate and atomic safeguards', async () => {
  reset();
  const input = { reportId: 3716, orderId: 3504, confirmedMoneyAccountId: 5, confirmedCurrency: 'VES',
    confirmedAmount: 86493.16, confirmedExchangeRateVesPerUsd: 887.30, movementDate: '2026-10-23',
    referenceCode: '909163', reviewNotes: 'Acuerdo comprobado' };
  confirmFailure = new Error('Este pago puede corresponder a una tasa acordada anterior. Administración debe revisar la tasa antes de confirmarlo.');
  const failed = await confirmMasterOpsPaymentReportAction(input);
  assert.equal(failed.ok, false); assert.equal(failed.code, 'rate_review_required');
  assert.equal(confirmations.length, 0);
  confirmFailure = null;
  assert.equal((await confirmMasterOpsPaymentReportAction(input)).ok, true);
  assert.deepEqual(confirmations[0], { ...input, clientId: null,
    overrideOperationDate: true, requireExplicitHandling: true, requireExactChange: true });
  authFailure = true; assert.equal((await confirmMasterOpsPaymentReportAction(input)).ok, false);
  assert.equal(confirmations.length, 1);
});

test('agreed-rate preview distinguishes cash from debt coverage with rises, falls and genuine partials', () => {
  const approved = { ...review, decision: 'quoted' as const };
  assert.equal(paymentRateCoveragePreview(approved, 86493.16, 887.30, 'VES', 97.48), 97.76);
  const falling = { ...approved, amountBs: 14000, recordedRate: 700, quoteRate: 1000, quoteBs: 14000, quoteUsd: 14 };
  assert.equal(paymentRateCoveragePreview(falling, 14000, 700, 'VES', 20), 14);
  assert.equal(paymentRateCoveragePreview({ ...approved, amountBs: 4000, quoteRate: 800, quoteBs: 11200, quoteUsd: 14 }, 4000, 887.30, 'VES', 4.51), 5);
  for (const changed of [review, { ...approved, decision: 'reported' as const }, { ...approved, applied: true }])
    assert.equal(paymentRateCoveragePreview(changed, 86493.16, 887.30, 'VES', 97.48), 97.48);
  assert.equal(paymentRateCoveragePreview(approved, 86493.15, 887.30, 'VES', 97.47), 97.47);
  assert.equal(paymentRateCoveragePreview(approved, 86493.16, 884.75, 'VES', 97.76), 97.76);
  assert.equal(paymentRateCoveragePreview(approved, 14, 0, 'USD', 14), 14);
});

test('actual compact component renders Admin approval vs Master escalation, and has zero automatic reads', () => {
  reset();
  const admin = renderToStaticMarkup(createElement(PaymentRateReview, { reportId: 3716, initialResult: { ok: true, value: review } }));
  assert.match(admin, /Aprobar revisión de tasa/); assert.match(admin, /884,75/); assert.match(admin, /887,30/);
  assert.match(admin, /retenciones o paga por fecha/);
  const master = renderToStaticMarkup(createElement(PaymentRateReview, { reportId: 3716,
    initialResult: { ok: true, value: { ...review, canApprove: false } } }));
  assert.doesNotMatch(master, /Aprobar revisión de tasa/);
  assert.match(master, /máster.*administrador/);
  const approved = renderToStaticMarkup(createElement(PaymentRateReview, { reportId: 3716,
    initialResult: { ok: true, value: { ...review, decision: 'quoted' } } }));
  assert.match(approved, /Puedes confirmar este mismo reporte/);
  assert.doesNotMatch(approved, /Aprobar revisión de tasa/);
  assert.equal(calls.length, 0);
});

test('component renders a recoverable read error and remains lazy in legacy surfaces', () => {
  reset();
  const failed = renderToStaticMarkup(createElement(PaymentRateReview, { reportId: 3716,
    initialResult: { ok: false, code: 'unavailable', message: 'Vuelve a consultar antes de confirmar.' } }));
  assert.match(failed, /role="alert"/); assert.match(failed, /Volver a consultar revisión/);
  const lazy = renderToStaticMarkup(createElement(PaymentRateReview, { reportId: 3716 }));
  assert.match(lazy, /aria-expanded="false"/); assert.doesNotMatch(lazy, /<form/);
  assert.equal(calls.length, 0);
});

test('Workspace loads only the selected pending payment on explicit review, gates confirmation and keeps forms separate', () => {
  const ui = readFileSync(new URL('src/components/orders/OrdersWorkspaceClient.tsx', root), 'utf8');
  const open = ui.slice(ui.indexOf('async function openPaymentConfirmation('), ui.indexOf('function handlePaymentConfirmationAccountChange('));
  assert.match(open, /readPaymentRateReviewAction\(report.id\)/);
  assert.match(open, /report.currencyCode === 'VES'/);
  assert.match(open, /request !== paymentConfirmationRequest.current/);
  assert.match(open, /if \(paymentConfirmationLoading.current\) return/);
  assert.match(ui, /!overpaymentDecisionValid \|\| !rateReviewReady/);
  assert.match(ui, /<PaymentRateReview key=\{report.id\}/);
  assert.match(ui, /showPaymentRateReview=\{false\}/);
  assert.match(ui, /readOnly=\{paymentRateFieldsLocked\}/);
  assert.match(ui, /paymentRateCoveragePreview\(payload.paymentRateReview/);
  const area = ui.slice(ui.indexOf('<PaymentRateReview key={report.id}'), ui.indexOf('Datos que se registraran al confirmar'));
  assert.match(area, /\/>\s*\) : null\}\s*\{confirmationDraft \? \(\s*<form/);
});
