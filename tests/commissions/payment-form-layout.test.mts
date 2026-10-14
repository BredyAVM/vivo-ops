import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const text = readFileSync(new URL('../../src/app/app/commissions/CommissionPaymentForm.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('CommissionPaymentForm.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
const sections = new Map<string, ts.JsxElement>();
function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === name);
  return attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : '';
}
function visit(node: ts.Node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
  if (ts.isJsxElement(node)) {
    const id = attribute(node.openingElement, 'data-testid');
    if (id) sections.set(id, node);
  }
  ts.forEachChild(node, visit);
}
visit(source);

test('payment fields form two compact three-column desktop rows', () => {
  for (const [id, expected] of [
    ['commission-payment-primary', ['moneyAccountId', 'amountUsd', 'exchangeRateVesPerUsd']],
    ['commission-payment-secondary', ['movementDate', 'bankFeeNativeAmount', 'referenceCode']],
  ] as const) {
    const row = sections.get(id);
    assert.ok(row);
    assert.match(attribute(row.openingElement, 'className'), /grid-cols-2.*md:grid-cols-3/);
    const fields = elements.filter(el => el.pos >= row.pos && el.end <= row.end).map(el => attribute(el, 'name')).filter(Boolean);
    assert.deepEqual(fields, expected);
  }
});

test('summary and submit share a responsive compact footer without hiding fee information', () => {
  const footer = sections.get('commission-payment-footer');
  assert.ok(footer);
  assert.match(attribute(footer.openingElement, 'className'), /md:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  const footerText = footer.getText(source);
  for (const content of ['<dl', 'Abono al asesor:', 'Equivalente en Bs:', 'Comisión bancaria:', 'Salida total de la cuenta:', 'gasto bancario separado', '<SubmitButton']) assert.ok(footerText.includes(content));
  assert.ok(text.includes('aria-live="polite"'));
});

test('compact form retains the payment command, request identity and decimal inputs', () => {
  const form = elements.find(el => el.tagName.getText(source) === 'WorkspaceForm');
  assert.ok(form?.getText(source).includes('action={registerCommissionPaymentAction}'));
  for (const name of ['requestId', 'closureId', 'periodId']) {
    const input = elements.find(el => attribute(el, 'name') === name);
    assert.ok(input);
    assert.equal(attribute(input, 'type'), 'hidden');
  }
  for (const name of ['amountUsd', 'exchangeRateVesPerUsd', 'bankFeeNativeAmount']) {
    assert.equal(attribute(elements.find(el => attribute(el, 'name') === name)!, 'inputMode'), 'decimal');
  }
  assert.ok(text.includes("required={selectedAccount?.currencyCode === 'VES'}"));
  assert.ok(text.includes('disabled={pending}'));
  assert.ok(text.includes('roundMoney(paymentNativeAmount + bankFeeValue)'));
});
