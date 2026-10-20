import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseOrderPriceDraft } from '../../src/lib/ui/order-price-draft.ts';
import { calculateOrderLineSnapshot } from '../../src/lib/pricing/order-snapshots.ts';

test('price entry accepts completed fractions with comma or point, including zero and leading decimals', () => {
  for (const [raw, amount] of [['14,50', 14.5], ['14.50', 14.5], ['0,25', .25], ['0.01', .01],
    ['0', 0], ['0,00', 0], ['.5', .5], [',5', .5], [' 6,75 ', 6.75], ['1.123456', 1.123456]] as const) {
    assert.equal(parseOrderPriceDraft(raw), amount, raw);
  }
});

test('incomplete or malformed prices cannot silently save the last valid value', () => {
  for (const raw of ['', ' ', '.', ',', '14.', '14,', '-1', '-0.25', '1..25', '1,,25', '1,2.5', '12USD', 'NaN', 'Infinity', '1e2']) {
    assert.equal(parseOrderPriceDraft(raw), null, raw);
  }
});

test('typing character by character permits decimal separators and trailing zeros before recalculating', () => {
  for (const separator of [',', '.']) {
    let lastValid = 99;
    let raw = '';
    for (const [character, expectedAmount] of [['1', 1], ['4', 14], [separator, null], ['0', 14], ['5', 14.05], ['0', 14.05]] as const) {
      raw += character;
      const parsed = parseOrderPriceDraft(raw);
      assert.equal(parsed, expectedAmount);
      if (parsed !== null) lastValid = parsed;
      assert.equal(raw, `14${separator}050`.slice(0, raw.length));
    }
    assert.equal(lastValid, 14.05);
  }
});

test('fractional overrides keep existing line calculation in USD and Bs, including a zero price', () => {
  const quantity = 4, fxRate = 876.8;
  for (const sourceCurrency of ['USD', 'VES'] as const) {
    for (const raw of ['14.05', '14,05', '0']) {
      const sourceAmount = parseOrderPriceDraft(raw);
      assert.notEqual(sourceAmount, null);
      const snapshot = calculateOrderLineSnapshot({ sourceCurrency, sourceAmount: sourceAmount!, quantity, fxRate, fallbackUnitUsd: 99 });
      if (sourceCurrency === 'USD') {
        assert.equal(snapshot.unitUsd, sourceAmount);
        assert.equal(snapshot.lineUsd, raw === '0' ? 0 : 56.2);
        assert.equal(snapshot.lineBs, raw === '0' ? 0 : 49276.16);
      } else {
        assert.equal(snapshot.unitBs, sourceAmount);
        assert.equal(snapshot.lineBs, raw === '0' ? 0 : 56.2);
      }
    }
  }
});

test('shared editor retains raw text, validates before saving and clears drafts on load and catalog reset', () => {
  const source = readFileSync(new URL('../../src/app/app/master/ops/MasterOpsOrderEditor.tsx', import.meta.url), 'utf8');
  assert.match(source, /setItemPriceDrafts\(current => \(\{ \.\.\.current, \[item.localId\]: \{ currency, text: rawValue \} \}\)\)/);
  for (const currency of ['USD', 'VES']) {
    assert.ok(source.includes(`itemPriceDrafts[item.localId]?.currency === "${currency}" ? itemPriceDrafts[item.localId].text`));
  }
  assert.match(source, /priceDraft && parseOrderPriceDraft\(priceDraft.text\) === null[\s\S]*?validationIssues.push/);
  assert.match(source, /const canSave = Boolean\(form\) && validationIssues.length === 0/);
  assert.match(source, /if \(!canSave\) \{[\s\S]*?return;[\s\S]*?setSaving\(true\)/);
  assert.match(source, /useEffect\(\(\) => \{\s*setItemPriceDrafts\(\{\}\)/);
  assert.match(source, /if \(!productBase\) return;\s*clearItemPriceDraft\(item.localId\)/);
  assert.equal((source.match(/onBlur=\{\(\) => clearItemPriceDraft\(item.localId, true\)\}/g) ?? []).length, 2);
});
