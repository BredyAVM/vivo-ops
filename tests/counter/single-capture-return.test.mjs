import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/app/app/counter/delivery-return.ts', import.meta.url), 'utf8');
const module = { exports: {} };
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(module.exports);
const build = module.exports.buildSingleCaptureReturn;
const row = (expectedCollection = 40, customerCollection = 0, cashReturned = 0, currencyCode = 'USD') => ({ currencyCode, expectedCollection, customerCollection, cashReturned });
const detail = (...currencyBreakdown) => ({ currencyBreakdown, collectionFinalizedAt: null, orderPendingUsd: 0.5 });
const cash = (amount, currencyCode = 'USD', lineKey = 'return-1') => ({ amount, currencyCode, lineKey, moneyAccountId: 7 });
test('40 returned against 40 expected closes custody without using customer debt', () => {
  const d = detail(row());
  const result = build(d, [cash(40)]);
  assert.equal(result.collectionFinal, true);
  assert.equal(result.customerCollectionLines[0].amount, 40);
  assert.notEqual(result.customerCollectionLines[0].lineKey, result.cashReturnLines[0].lineKey);
  assert.equal(d.orderPendingUsd, 0.5);
});
test('partial return records only actual cash; next return completes it', () => {
  assert.equal(build(detail(row()), [cash(15)]).collectionFinal, false);
  const result = build(detail(row(40, 15, 15)), [cash(25)]);
  assert.equal(result.collectionFinal, true);
  assert.equal(result.customerCollectionLines[0].amount, 25);
});
test('legacy customer declaration is not counted twice', () => {
  assert.deepEqual(build(detail(row(40, 40, 0)), [cash(40)]).customerCollectionLines, []);
  const result = build(detail(row(40, 20, 10)), [cash(30)]);
  assert.equal(result.customerCollectionLines[0].amount, 20);
  assert.equal(result.collectionFinal, true);
});
test('multiple boxes share existing declaration and currencies remain independent', () => {
  const result = build(detail(row(40, 20, 0)), [cash(10), cash(30, 'USD', 'return-2')]);
  assert.equal(result.customerCollectionLines.reduce((sum, line) => sum + line.amount, 0), 20);
  assert.equal(result.collectionFinal, true);
  assert.equal(build(detail(row(), row(1000, 0, 0, 'VES')), [cash(40)]).collectionFinal, false);
  assert.equal(build(detail(row(), row(1000, 0, 0, 'VES')), [cash(40), cash(1000, 'VES', 'return-2')]).collectionFinal, true);
});
test('finalized declaration accepts only outstanding cash, not new collection', () => {
  const d = { ...detail(row(40, 40, 20)), collectionFinalizedAt: '2026-10-30' };
  assert.equal(build(d, [cash(20)]).collectionFinal, false);
  assert.deepEqual(build(d, [cash(20)]).customerCollectionLines, []);
  assert.throws(() => build(d, [cash(21)]), /supera/);
});
test('form has one receipt, review, and no technical close checkbox', () => {
  const ui = readFileSync(new URL('../../src/app/app/counter/CounterDeliveryWorkspace.tsx', import.meta.url), 'utf8').split('export function CounterDeliverySettlementBox')[1];
  assert.ok(ui.includes('¿Cuánto dinero entrega el motorizado?'));
  assert.ok(ui.includes('Confirma el dinero que recibes'));
  assert.ok(!ui.includes('Cerrar la cobranza declarada'));
  assert.ok(!ui.includes('setCollectionLines'));
  assert.ok(ui.includes('buildSingleCaptureReturn(detail,'));
});
