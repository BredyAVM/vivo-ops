import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdminExecutiveKpiOverview,
  buildOperationalOverview,
  parseProjectionOptions,
  getExecutiveOrderDateKey,
  type ExecutiveFinancialStateRow,
  type ExecutiveOrderRow,
} from '../../src/lib/admin-finance/executive-model.ts';

const asOf = new Date('2026-09-09T16:00:00.000Z');

test('operational KPIs match Master scheduled criteria, rather than only deliveries', () => {
  const result = buildOperationalOverview({ orders: currentOrders, financialStates, asOf });
  assert.equal(result.today.closures, 3); // created + queued + delivered; not cancelled
  assert.equal(result.today.commercialNetUsd, 150); // no tax, created excluded
  assert.equal(result.today.confirmedPaidUsd, 70); // 12 + 58, not total minus pending
  assert.equal(result.today.pendingUsd, 56);
  assert.equal(result.week.closures, 5); // includes Friday scheduled order
  assert.equal(result.week.commercialNetUsd, 190);
  assert.equal(result.week.confirmedPaidUsd, 80);
  assert.equal(result.week.pendingUsd, 86);
});

test('operational projection averages complete prior weeks and applies selected growth once', () => {
  const result = buildOperationalOverview({ orders: [...currentOrders, ...historicalOrders], financialStates, asOf, historyWeeks: 2, growthPct: 20 });
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].startKey, '2026-08-24');
  assert.equal(result.weeklyReferenceUsd, 420); // mean(300,400)*1.2
  assert.equal(result.weeklyReferenceClosures, 1.2);
  assert.equal(result.trend[2].historicalBilledUsd, 420);
  assert.equal(result.trend[2].currentBilledUsd, 160);
  assert.equal(result.trend[4].currentBilledUsd, null); // future is not observed
});

test('projection keeps empty weeks, deduplicates orders, and cannot read current-week sales as history', () => {
  const rows = [currentOrders[0], currentOrders[0], historicalOrders[3]];
  const result = buildOperationalOverview({ orders: rows, financialStates, asOf });
  assert.equal(result.today.closures, 1);
  assert.equal(result.weeklyReferenceUsd, 100); // 400/4, not 400/1
  assert.equal(result.history.filter((week) => week.commercialNetUsd === 0).length, 3);
});

test('operational missing state is unknown; rounding closes only through the canonical balance', () => {
  const row = order({ id: 99, date: '2026-09-09', status: 'queued', totalUsd: 10 });
  assert.equal(buildOperationalOverview({ orders: [row], financialStates: [], asOf }).today.pendingUsd, null);
  row.extra_fields = { ...row.extra_fields, payment: { rounding_close: { closed_balance_usd: 0.02 } } };
  const result = buildOperationalOverview({ orders: [row], financialStates: [state(99, 10, 9.98, 0)], asOf });
  assert.equal(result.today.pendingUsd, 0);
  assert.equal(result.today.confirmedPaidUsd, 9.98);
  assert.equal(buildOperationalOverview({ orders: [row], financialStates: [state(99, 10, 9.98, 0.02)], asOf }).today.pendingUsd, 0.02);
  assert.equal(buildOperationalOverview({ orders: [], financialStates: [], asOf }).today.pendingUsd, 0);
});

test('projection normalizes invalid or unbounded parameters', () => {
  assert.deepEqual(parseProjectionOptions('2', '15.5'), { historyWeeks: 2, growthPct: 15.5 });
  for (const weeks of ['0', '-1', '5', '2.5', 'NaN']) assert.equal(parseProjectionOptions(weeks, '0').historyWeeks, 4);
  for (const growth of ['-1', '101', 'Infinity', 'NaN']) assert.equal(parseProjectionOptions('4', growth).growthPct, 0);
});

function order(input: {
  id: number;
  date: string;
  status: string;
  fulfillment?: string;
  totalUsd: number;
  netUsd?: number;
}): ExecutiveOrderRow {
  return {
    id: input.id,
    status: input.status,
    fulfillment: input.fulfillment ?? 'pickup',
    total_usd: input.totalUsd,
    created_at: `${input.date}T14:00:00.000Z`,
    commercial_date: input.status === 'delivered' ? input.date : null,
    commercial_at: input.status === 'delivered' ? `${input.date}T14:00:00.000Z` : null,
    extra_fields: {
      schedule: { date: input.date },
      pricing: {
        total_usd: input.totalUsd,
        subtotal_after_discount_usd: input.netUsd ?? input.totalUsd,
      },
    },
  };
}

function state(
  orderId: number,
  totalUsd: number,
  confirmedPaidUsd: number,
  pendingUsd: number
): ExecutiveFinancialStateRow {
  return {
    order_id: orderId,
    total_usd: totalUsd,
    confirmed_paid_usd: confirmedPaidUsd,
    pending_usd: pendingUsd,
  };
}

const currentOrders = [
  order({ id: 1, date: '2026-09-09', status: 'delivered', fulfillment: 'delivery', totalUsd: 116, netUsd: 100 }),
  order({ id: 2, date: '2026-09-09', status: 'queued', totalUsd: 58, netUsd: 50 }),
  order({ id: 3, date: '2026-09-09', status: 'created', fulfillment: 'delivery', totalUsd: 20 }),
  order({ id: 4, date: '2026-09-09', status: 'cancelled', fulfillment: 'delivery', totalUsd: 100 }),
  order({ id: 5, date: '2026-09-07', status: 'delivered', totalUsd: 10 }),
  order({ id: 6, date: '2026-09-11', status: 'confirmed', fulfillment: 'delivery', totalUsd: 30 }),
];

const historicalOrders = [
  order({ id: 11, date: '2026-08-12', status: 'delivered', totalUsd: 100 }),
  order({ id: 12, date: '2026-08-19', status: 'delivered', totalUsd: 200 }),
  order({ id: 13, date: '2026-08-26', status: 'delivered', totalUsd: 300 }),
  order({ id: 14, date: '2026-09-02', status: 'delivered', totalUsd: 400 }),
];

const financialStates = [
  state(1, 116, 12, 56),
  state(2, 58, 58, 0),
  state(5, 10, 10, 0),
  state(6, 30, 0, 30),
];

test('puts the requested today and week business KPIs in one reconciled overview', () => {
  const overview = buildAdminExecutiveKpiOverview({
    orders: [...currentOrders, ...historicalOrders],
    financialStates,
    asOf,
  });

  assert.equal(overview.definitionVersion, 'admin-executive-v1');
  assert.equal(overview.today.closures, 1);
  assert.equal(overview.today.billedOrders, 1);
  assert.equal(overview.today.billedUsd, 116);
  assert.equal(overview.today.commercialNetUsd, 100);
  assert.equal(overview.today.coveredUsd, 60);
  assert.equal(overview.today.pendingUsd, 56);
  assert.equal(overview.today.deliveries, 2);
  assert.equal(overview.today.deliveriesCompleted, 1);
  assert.equal(overview.today.deliveriesPending, 1);

  assert.equal(overview.week.closures, 2);
  assert.equal(overview.week.billedUsd, 126);
  assert.equal(overview.week.coveredUsd, 70);
  assert.equal(overview.week.pendingUsd, 56);
  assert.equal(
    overview.week.billedUsd,
    Number(((overview.week.coveredUsd ?? 0) + (overview.week.pendingUsd ?? 0)).toFixed(2))
  );
  assert.equal(overview.quality.financialStatesComplete, true);
});

test('uses four complete prior weeks as the benchmark and aligns weekdays', () => {
  const overview = buildAdminExecutiveKpiOverview({
    orders: [...currentOrders, ...historicalOrders],
    financialStates,
    asOf,
  });

  assert.equal(overview.historicalAverage.todayBilledUsd, 250);
  assert.equal(overview.historicalAverage.todayClosures, 1);
  assert.equal(overview.historicalAverage.weekBilledUsd, 250);
  assert.equal(overview.trend.length, 7);
  assert.equal(overview.trend[2].dateKey, '2026-09-09');
  assert.equal(overview.trend[2].historicalBilledUsd, 250);
  assert.equal(overview.trend[2].currentBilledUsd, 126);
  assert.equal(overview.trend.at(-1)?.currentBilledUsd, null);
});

test('compares the current weekday at the same Caracas time instead of a completed day', () => {
  const lateHistoricalOrder = order({
    id: 30,
    date: '2026-09-02',
    status: 'delivered',
    totalUsd: 1_000,
  });
  lateHistoricalOrder.commercial_at = '2026-09-03T02:00:00.000Z';

  const overview = buildAdminExecutiveKpiOverview({
    orders: [...currentOrders, ...historicalOrders, lateHistoricalOrder],
    financialStates,
    asOf,
  });

  assert.equal(overview.historicalAverage.todayBilledUsd, 250);
  assert.equal(overview.trend[2].historicalBilledUsd, 250);
});

test('never converts missing financial coverage into a false zero', () => {
  const overview = buildAdminExecutiveKpiOverview({
    orders: currentOrders,
    financialStates: financialStates.filter((row) => Number(row.order_id) !== 1),
    asOf,
  });

  assert.equal(overview.today.coveredUsd, null);
  assert.equal(overview.today.pendingUsd, null);
  assert.equal(overview.quality.financialStatesComplete, false);
});

test('falls back to Caracas creation date only when a scheduled date is missing', () => {
  const legacyOrder = order({ id: 20, date: '2026-09-09', status: 'delivered', totalUsd: 10 });
  legacyOrder.extra_fields = { pricing: legacyOrder.extra_fields?.pricing };
  legacyOrder.commercial_date = null;
  legacyOrder.created_at = '2026-09-10T02:30:00.000Z';

  assert.equal(getExecutiveOrderDateKey(legacyOrder), '2026-09-09');
});
