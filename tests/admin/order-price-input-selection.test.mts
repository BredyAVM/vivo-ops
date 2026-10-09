import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { selectInputValue } from '../../src/lib/ui/select-input-value.ts';
import { parseDecimalInput } from '../../src/lib/number-input.ts';
import { calculateOrderLineSnapshot } from '../../src/lib/pricing/order-snapshots.ts';

test('focusing an amount selects the whole value without changing it or saving anything', () => {
  for (const value of ['12.5', '3300', '0', '']) {
    let selected = false;
    const input = { value, select() { selected = true; } };
    selectInputValue({ currentTarget: input });
    assert.equal(selected, true);
    assert.equal(input.value, value);
  }
});

test('replacement zero is retained in USD and Bs without restoring a nonzero catalog price', () => {
  for (const sourceCurrency of ['USD', 'VES'] as const) {
    const sourceAmount = parseDecimalInput('0', NaN);
    assert.equal(sourceAmount, 0);
    const snapshot = calculateOrderLineSnapshot({ sourceCurrency, sourceAmount, quantity: 6, fxRate: 871.37, fallbackUnitUsd: 12.5 });
    assert.equal(snapshot.unitUsd, 0);
    assert.equal(snapshot.unitBs, 0);
    assert.equal(snapshot.lineUsd, 0);
    assert.equal(snapshot.lineBs, 0);
  }
});

test('active and delivered order price/commission inputs select on focus, not on every click or keystroke', () => {
  for (const [path, count] of [
    // Three price/commission fields plus the commit-on-blur quantity field.
    ['src/app/app/master/ops/MasterOpsOrderEditor.tsx', 4],
    ['src/components/orders/DeliveredOrderPriceEditor.tsx', 1],
    ['src/app/app/commissions/_components/DeliveredOrderCommissionEditor.tsx', 1],
  ] as const) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.equal(source.match(/onFocus=\{selectInputValue\}/g)?.length, count);
    assert.doesNotMatch(source, /on(?:Click|Change|KeyDown)=\{selectInputValue\}/);
  }
});
