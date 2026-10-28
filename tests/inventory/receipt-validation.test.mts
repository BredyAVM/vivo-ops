import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as validation from '../../src/lib/inventory/receipt-validation.ts';
import { parseDecimalInput } from '../../src/lib/number-input.ts';

const { normalizeReceiptCapture, receiptCaptureIssue, receiptActionFailure, RECEIPT_UNCONFIRMED_MESSAGE } = validation;
const row = (quantity: number, conversion: number | null = 100) => ({ presentationId: 1, quantity, baseUnitsPerPresentation: conversion });

test('missing received amount identifies units and does not offer unknown quantity', () => {
  const issue = receiptCaptureIssue({ looseUnits: 0 }, false)!;
  assert.equal(issue.field, 'looseUnits');
  assert.match(issue.message, /Falta la cantidad recibida/);
  assert.doesNotMatch(issue.message, /desconocida/);
});
test('missing quantity in the second presentation identifies its exact field, even with loose units', () => {
  for (const quantity of [0, -1, NaN, Infinity]) {
    const issue = receiptCaptureIssue({ looseUnits: 18, presentations: [row(2), { ...row(quantity), presentationId: 2 }] }, false)!;
    assert.equal(issue.field, 'presentations.1.quantity');
    assert.match(issue.message, /Presentación 2.*Quitar/);
  }
});
test('missing conversion has its own field and actionable explanation', () => {
  assert.equal(receiptCaptureIssue({ presentations: [row(2, 0)] }, false)?.field, 'presentations.0.factor');
  assert.equal(receiptCaptureIssue({ presentations: [row(2, NaN)] }, false)?.field, 'presentations.0.factor');
});
test('loose-only, fractional bags and combined quantities remain supported', () => {
  assert.equal(normalizeReceiptCapture({ looseUnits: 18 }, false).loose_units, 18);
  const result = normalizeReceiptCapture({ looseUnits: 153, presentations: [row(parseDecimalInput('3,5'))] }, false);
  assert.equal(result.presentations[0].quantity, 3.5);
  assert.equal(result.loose_units, 153);
  assert.equal(normalizeReceiptCapture({ presentations: [row(2, null)] }, false).presentations[0].base_units_per_presentation, null);
});
test('invalid loose quantities cannot silently become zero', () => {
  for (const looseUnits of [-1, NaN, Infinity, parseDecimalInput('abc')]) {
    assert.equal(receiptCaptureIssue({ looseUnits, presentations: [row(1)] }, false)?.field, 'looseUnits');
  }
});
test('only expectations accept unknown quantities, without mixed amounts', () => {
  assert.equal(normalizeReceiptCapture({ quantityUnknown: true }, true).quantity_unknown, true);
  assert.ok(receiptCaptureIssue({ quantityUnknown: true }, false));
  assert.ok(receiptCaptureIssue({ quantityUnknown: true, looseUnits: 5 }, true));
  assert.match(receiptCaptureIssue({}, true)!.message, /Cantidad todavía desconocida/);
});
test('malformed captures, duplicate presentations and limits remain rejected', () => {
  for (const input of [null, [], { presentations: [null] }, { presentations: [row(1), row(2)] },
    { presentations: Array.from({ length: 21 }, () => row(1)) }, { sourceName: 'x'.repeat(161) },
    { presentations: [{ ...row(1), presentationId: -1 }] }]) {
    assert.ok(receiptCaptureIssue(input, false));
  }
});
test('technical and transport messages are never sent as user-facing diagnostics', () => {
  for (const text of ['Minified React error #441', 'An error occurred in the Server Components render.',
    'relation private.secret does not exist', 'Failed to fetch']) {
    assert.equal(receiptActionFailure(new Error(text)).message, RECEIPT_UNCONFIRMED_MESSAGE);
  }
  assert.equal(receiptActionFailure(new Error('El vencimiento debe ser posterior a la recepción.')).message,
    'El vencimiento debe ser posterior a la recepción.');
});

// Execute the real Server Actions with boundary doubles. No production stock is touched.
const source = readFileSync(new URL('../../src/app/app/inventory/actions.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function harness(roles = ['kitchen'], rpcError: string | null = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const ctx = { roles, supabase: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: { inventory_lot_id: 99, received_quantity_units: 253, expected_flow_id: 12 }, error: rpcError ? { message: rpcError } : null };
  } } };
  const actions: Record<string, (input: unknown) => Promise<{
    ok: boolean; message?: string; issue?: validation.ReceiptCaptureIssue | null; inventoryLotId?: number;
  }>> = {};
  const mocks: Record<string, unknown> = {
    'next/cache': { revalidatePath() {} },
    '@/lib/auth': { requireAuthContext: async () => ctx, requireMasterOrAdminContext: async () => {
      if (!roles.some(r => ['admin', 'master'].includes(r))) throw new Error('Sin permiso');
      return ctx;
    } },
    '@/lib/inventory/receipt-validation': validation,
    '@/lib/push': { sendPushToRoleDevices: async () => {} },
    '@/app/app/master/dashboard/actions': {},
  };
  new Function('require', 'exports', 'console', compiled)((name: string) => {
    assert.ok(name in mocks, `Unexpected dependency: ${name}`); return mocks[name];
  }, actions, { error() {}, warn() {} });
  return { actions, calls };
}
const input = { operationId: 'f8795f80-1328-4ba5-a689-946406467d12', inventoryItemId: 1, capture: { looseUnits: 253 } };

test('real receipt action returns serializable field errors before calling the database', async () => {
  const { actions, calls } = harness();
  const result = await actions.receiveInventoryStockAction({ ...input, capture: { presentations: [row(0)] } });
  assert.equal(result.ok, false);
  assert.equal(result.issue?.field, 'presentations.0.quantity');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(calls.length, 0);
});
test('real receipt action preserves successful RPC payload and result', async () => {
  const { actions, calls } = harness();
  const result = await actions.receiveInventoryStockAction(input);
  assert.equal(result.ok, true);
  assert.equal(result.inventoryLotId, 99);
  assert.equal(calls[0].name, 'inventory_reconcile_receipt_v1');
  assert.equal((calls[0].args.p_capture as { loose_units: number }).loose_units, 253);
  assert.equal(calls[0].args.p_operation_id, input.operationId);
});
test('receipt permission and SQL failures remain closed, with safe messages', async () => {
  const denied = harness(['advisor']);
  assert.equal((await denied.actions.receiveInventoryStockAction(input)).ok, false);
  assert.equal(denied.calls.length, 0);
  const broken = harness(['admin'], 'internal database structure');
  assert.equal((await broken.actions.receiveInventoryStockAction(input)).message, RECEIPT_UNCONFIRMED_MESSAGE);
});
test('expectations share field errors and preserve unknown amount and role checks', async () => {
  const { actions, calls } = harness(['master']);
  const expected = { ...input, effectiveAt: '2026-10-29T16:00:00Z', capture: {} };
  assert.equal((await actions.saveInventoryExpectedReceiptAction(expected)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await actions.saveInventoryExpectedReceiptAction({ ...expected, capture: { quantityUnknown: true } })).ok, true);
  const denied = harness(['kitchen']);
  assert.equal((await denied.actions.saveInventoryExpectedReceiptAction(expected)).ok, false);
  assert.equal(denied.calls.length, 0);
});
test('cancellation returns a safe result without exposing database errors', async () => {
  const { actions } = harness(['master'], 'La expectativa ya fue conciliada y no puede cancelarse.');
  const result = await actions.cancelInventoryExpectedReceiptAction({ expectedFlowId: 12 });
  assert.equal(result.ok, false);
  assert.match(result.message!, /ya fue conciliada/);
});

const uiSource = readFileSync(new URL('../../src/app/app/inventory/operations/InventoryReceiptWorkspaceClient.tsx', import.meta.url), 'utf8');
const uiCompiled = ts.transpileModule(uiSource + '\nexport { CaptureEditor as TestCaptureEditor };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const uiExports: { TestCaptureEditor?: ComponentType<Record<string, unknown>> } = {};
const require = createRequire(import.meta.url);
new Function('require', 'exports', uiCompiled)((name: string) => {
  if (name === '@/lib/inventory/receipt-validation') return validation;
  if (name === '@/lib/number-input') return { parseDecimalInput };
  if (name === '../actions') return {};
  if (name === '@/components/navigation/useWorkspaceRouter') return {};
  if (name === 'react' || name === 'react/jsx-runtime') return require(name);
  throw new Error(`Unexpected UI dependency: ${name}`);
}, uiExports);
const editorProps = {
  itemId: 1, item: { name: 'Tequeños Regulares Crudos', unit_name: 'UND' },
  presentations: [{ id: 1, inventory_item_id: 1, name: 'Bolsa de 100 UND', base_units_per_presentation: 100 }],
  capture: { quantityUnknown: false, sourceName: '', looseUnits: '', lines: [{ key: 'test', presentationId: '1', quantity: '', factor: '100' }] },
  onChange() {}, allowUnknown: false, disabled: false,
};
test('rendered warning names the bag and product and marks the quantity input', () => {
  const issue = receiptCaptureIssue({ presentations: [row(0)] }, false);
  const html = renderToStaticMarkup(createElement(uiExports.TestCaptureEditor!, { ...editorProps, issue }));
  assert.match(html, /Bolsa de 100 UND.*Tequeños Regulares Crudos/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-invalid="true" aria-describedby="[^"]+"[^>]*value=""/);
  assert.doesNotMatch(html, /Minified React|Server Components/);
});
test('rendered total remains correct for fractional bags plus loose units', () => {
  const capture = { ...editorProps.capture, looseUnits: '153', lines: [{ ...editorProps.capture.lines[0], quantity: '3,5' }] };
  const html = renderToStaticMarkup(createElement(uiExports.TestCaptureEditor!, { ...editorProps, capture, issue: null }));
  assert.match(html, /Total: 503 UND/);
  assert.doesNotMatch(html, /aria-invalid="true"|role="alert"/);
});
