import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdminFinancePeriod,
  getCaracasDateKey,
  listDateKeys,
  normalizeAdminFinancePeriod,
  parseAdminFinanceAsOf,
} from '../../src/lib/admin-finance/period.ts';

test('assigns the UTC midnight boundary to the correct Caracas business day', () => {
  const asOf = new Date('2026-09-09T03:30:00.000Z');

  assert.equal(getCaracasDateKey(asOf), '2026-09-08');
  assert.deepEqual(buildAdminFinancePeriod('today', asOf), {
    key: 'today',
    label: 'Hoy',
    startKey: '2026-09-08',
    endExclusiveKey: '2026-09-09',
    fullEndExclusiveKey: '2026-09-09',
    previousStartKey: '2026-09-07',
    previousEndExclusiveKey: '2026-09-08',
    asOf: '2026-09-09T03:30:00.000Z',
  });
});

test('builds week-to-date and its equivalent previous window from Monday', () => {
  const period = buildAdminFinancePeriod('week', new Date('2026-09-09T16:00:00.000Z'));

  assert.deepEqual(
    {
      startKey: period.startKey,
      endExclusiveKey: period.endExclusiveKey,
      fullEndExclusiveKey: period.fullEndExclusiveKey,
      previousStartKey: period.previousStartKey,
      previousEndExclusiveKey: period.previousEndExclusiveKey,
    },
    {
      startKey: '2026-09-07',
      endExclusiveKey: '2026-09-10',
      fullEndExclusiveKey: '2026-09-14',
      previousStartKey: '2026-08-31',
      previousEndExclusiveKey: '2026-09-03',
    }
  );
});

test('builds month-to-date without extending the prior comparison window', () => {
  const period = buildAdminFinancePeriod('month', new Date('2026-09-09T16:00:00.000Z'));

  assert.deepEqual(
    {
      startKey: period.startKey,
      endExclusiveKey: period.endExclusiveKey,
      fullEndExclusiveKey: period.fullEndExclusiveKey,
      previousStartKey: period.previousStartKey,
      previousEndExclusiveKey: period.previousEndExclusiveKey,
    },
    {
      startKey: '2026-09-01',
      endExclusiveKey: '2026-09-10',
      fullEndExclusiveKey: '2026-10-01',
      previousStartKey: '2026-08-01',
      previousEndExclusiveKey: '2026-08-10',
    }
  );

  assert.deepEqual(listDateKeys(period.startKey, period.endExclusiveKey), [
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
    '2026-09-05',
    '2026-09-06',
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
  ]);
});

test('falls back to today for an unknown period key', () => {
  assert.equal(normalizeAdminFinancePeriod('quarter'), 'today');
  assert.equal(normalizeAdminFinancePeriod('week'), 'week');
});

test('accepts only a valid timestamp when preserving a financial snapshot', () => {
  const reference = new Date('2026-09-08T16:05:00.000Z');
  assert.equal(
    parseAdminFinanceAsOf('2026-09-08T16:00:00.000Z', reference)?.toISOString(),
    '2026-09-08T16:00:00.000Z'
  );
  assert.equal(parseAdminFinanceAsOf('not-a-date', reference), undefined);
  assert.equal(parseAdminFinanceAsOf(undefined, reference), undefined);
  assert.equal(
    parseAdminFinanceAsOf('2026-09-08T15:49:59.999Z', reference),
    undefined
  );
  assert.equal(
    parseAdminFinanceAsOf('2026-09-08T16:06:00.001Z', reference),
    undefined
  );
});
