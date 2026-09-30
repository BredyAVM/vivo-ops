import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCounterAmount, formatCounterAmount } from '../../src/app/app/counter/amount-review.ts';

test('acepta importes sin agrupación con coma o punto decimal', () => {
  for (const [text, expected] of [['2300', 2300], ['2300,50', 2300.5], ['2300.50', 2300.5], ['0,01', 0.01], [' 10.00 ', 10], ['0003,5', 3.5]] as const) {
    assert.equal(parseCounterAmount(text), expected);
  }
});

test('rechaza miles ambiguos, decimales sobrantes y montos inválidos', () => {
  for (const text of ['', ' ', '0', '-10', 'NaN', 'Infinity', '2e3', '2.300', '2,300', '2.300,50', '2,300.50', '1 000', '0.001', '12.', '.50', '9007199254740992']) {
    assert.equal(parseCounterAmount(text), null, text);
  }
});

test('la revisión muestra el importe nativo exacto con miles y dos decimales', () => {
  assert.equal(formatCounterAmount(2300, 'VES'), 'Bs 2.300,00');
  assert.equal(formatCounterAmount(23000.5, 'VES'), 'Bs 23.000,50');
  assert.equal(formatCounterAmount(23.5, 'VES'), 'Bs 23,50');
  assert.equal(formatCounterAmount(10, 'USD'), 'USD 10,00');
  assert.equal(formatCounterAmount(0.17, 'USD'), 'USD 0,17');
});
