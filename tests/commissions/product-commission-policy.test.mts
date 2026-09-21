import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProductCommissionSchedule,
  resolveProductCommissionTerms,
} from '../../src/lib/commissions/product-commission-policy.ts';

const extraFields = {
  commission_schedule_v1: [
    { effective_from: '1900-01-01', mode: 'default', value: null },
    { effective_from: '2026-09-16', mode: 'fixed_item', value: 5 },
  ],
};

test('resolves the historical terms before the effective change', () => {
  assert.deepEqual(
    resolveProductCommissionTerms({
      currentMode: 'fixed_item',
      currentValue: 5,
      extraFields,
      referenceDate: '2026-09-15',
    }),
    { mode: 'default', value: null }
  );
});

test('resolves the new terms on and after the effective date', () => {
  assert.deepEqual(
    resolveProductCommissionTerms({
      currentMode: 'fixed_item',
      currentValue: 5,
      extraFields,
      referenceDate: '2026-09-16T14:00:00-04:00',
    }),
    { mode: 'fixed_item', value: 5 }
  );
});

test('keeps the current catalog terms when no dated schedule exists', () => {
  assert.deepEqual(
    resolveProductCommissionTerms({
      currentMode: 'fixed_item',
      currentValue: 7,
      extraFields: {},
      referenceDate: '2026-09-20',
    }),
    { mode: 'fixed_item', value: 7 }
  );
});

test('ignores malformed schedule entries and orders valid entries by date', () => {
  assert.deepEqual(
    getProductCommissionSchedule({
      commission_schedule_v1: [
        { effective_from: '2026-09-16', mode: 'fixed_item', value: 5 },
        { effective_from: 'invalid', mode: 'fixed_item', value: 99 },
        { effective_from: '1900-01-01', mode: 'default', value: null },
      ],
    }),
    [
      { effectiveFrom: '1900-01-01', mode: 'default', value: null },
      { effectiveFrom: '2026-09-16', mode: 'fixed_item', value: 5 },
    ]
  );
});
