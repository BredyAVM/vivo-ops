import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperationStats, getOrderOperationalKpiAmounts, indexKpiFinancialStates, kpiAmount } from '../../src/lib/orders/operational-kpis.ts';
import { buildAdminExecutiveKpiOverview, buildOperationalOverview, type ExecutiveOrderRow, type ExecutiveFinancialStateRow } from '../../src/lib/admin-finance/executive-model.ts';

const asOf = new Date('2026-10-04T20:00:00Z');
function order(id: number, date: string, net = 10.004, status = 'delivered'): ExecutiveOrderRow {
  return { id, status, fulfillment: 'pickup', created_at: `${date}T14:00:00Z`,
    commercial_date: status === 'delivered' ? date : null, commercial_at: `${date}T14:00:00Z`, total_usd: net + 1,
    extra_fields: { schedule: { date }, pricing: { total_usd: net + 1, subtotal_after_discount_usd: net, invoice_tax_amount_usd: 1 } } };
}
function state(o: ExecutiveOrderRow, paid = 5.003, pending = 6.001): ExecutiveFinancialStateRow {
  return { order_id: o.id, total_usd: o.total_usd ?? 0, confirmed_paid_usd: paid, pending_usd: pending };
}

test('home and workspace sum precise source amounts once, with net and tax-inclusive totals separate', () => {
  const orders = [order(1, '2026-09-28'), order(2, '2026-09-29'), order(3, '2026-09-29')];
  const states = orders.map(o => state(o));
  const home = buildOperationalOverview({ orders, financialStates: states, asOf });
  const workspace = buildOperationStats(orders.map((o, i) => ({ status: o.status, totalUsd: 11, confirmedPaidUsd: 5, balanceUsd: 6,
    kpiAmounts: getOrderOperationalKpiAmounts(o, states[i]) })));
  assert.equal(workspace.factNeta, 30.01);
  assert.equal(workspace.fact, 33.01);
  assert.equal(workspace.abonadoConfirmado, 15.01);
  assert.equal(workspace.pendiente, 18);
  assert.equal(home.week.commercialNetUsd, workspace.factNeta);
  assert.equal(home.week.confirmedPaidUsd, workspace.abonadoConfirmado);
  assert.equal(home.week.pendingUsd, workspace.pendiente);
  assert.equal(home.trend.at(-1)?.currentBilledUsd, home.week.commercialNetUsd);
});

test('delivery financial graph and historical reference never accumulate rounded daily totals', () => {
  const current = [order(1, '2026-09-28'), order(2, '2026-09-29'), order(3, '2026-09-30')];
  const historical = [order(4, '2026-09-21'), order(5, '2026-09-22'), order(6, '2026-09-23')];
  const result = buildAdminExecutiveKpiOverview({ orders: [...current, ...historical], financialStates: current.map(o => state(o)), asOf });
  assert.equal(result.trend.at(-1)?.currentBilledUsd, result.week.billedUsd);
  assert.equal(result.trend.at(-1)?.historicalBilledUsd, result.historicalAverage.weekBilledUsd);
  assert.equal(result.trend.at(-1)?.historicalClosures, result.historicalAverage.weekClosures);
  assert.equal(result.week.billedUsd, 33.01);
  assert.equal(result.historicalAverage.weekClosures, 0.8);
});

test('unknown financial state is not fully covered and does not remove the commercial sale', () => {
  const o = order(1, '2026-10-04');
  for (const invalid of [null, '', 'NaN', 'Infinity', -1, false, undefined]) {
    const s = { ...state(o), total_usd: invalid } as ExecutiveFinancialStateRow;
    const result = buildAdminExecutiveKpiOverview({ orders: [o], financialStates: [s], asOf });
    assert.equal(result.today.billedOrders, 1);
    assert.equal(result.today.coveredUsd, null);
    assert.equal(result.today.pendingUsd, null);
    assert.equal(result.operational.today.pendingUsd, null);
  }
});

test('cash paid, client credit, debt and advisor liabilities are not interchangeable', () => {
  const o = order(1, '2026-10-04', 10);
  const credit = state(o, 20, 0);
  const result = buildAdminExecutiveKpiOverview({ orders: [o], financialStates: [credit], asOf });
  assert.equal(result.operational.today.confirmedPaidUsd, 20);
  assert.equal(result.today.coveredUsd, 11);
  assert.equal(result.today.pendingUsd, 0);
  const changeDebt = buildOperationalOverview({ orders: [o], financialStates: [state(o, 0, 12)], asOf });
  assert.equal(changeDebt.today.pendingUsd, 12); // no clamp to price: over-change can create real debt
  const financialDebt = buildAdminExecutiveKpiOverview({ orders: [o], financialStates: [state(o, 0, 12)], asOf });
  assert.equal(financialDebt.today.pendingUsd, 12);
  assert.equal(financialDebt.today.coveredUsd, 0);
});

test('cancelled, created and gift orders retain the same shared operational criteria', () => {
  const orders = [order(1, '2026-10-04', 10, 'created'), order(2, '2026-10-04', 10, 'cancelled'),
    order(3, '2026-10-04', 0, 'queued'), order(4, '2026-10-04', 10, 'queued')];
  orders[2].total_usd = 0;
  orders[2].extra_fields!.pricing!.total_usd = 0;
  const result = buildOperationalOverview({ orders, financialStates: [state(orders[3], 0, 11)], asOf });
  assert.equal(result.today.closures, 2);
  assert.equal(result.today.commercialNetUsd, 10);
  assert.equal(result.today.pendingUsd, 11);
});

test('financial reader rejects incomplete, foreign, duplicate and malformed states', () => {
  const good = state(order(1, '2026-10-04'));
  assert.equal(indexKpiFinancialStates([good], [1]).get(1), good);
  for (const rows of [[], [good, good], [{ ...good, order_id: 2 }], [{ ...good, pending_usd: null }], [{ ...good, confirmed_paid_usd: 'NaN' }]]) {
    assert.throws(() => indexKpiFinancialStates(rows, [1]), /saldos/);
  }
  for (const value of [null, undefined, false, '', ' ', {}, Infinity, -1]) assert.equal(kpiAmount(value), null);
  assert.equal(kpiAmount('0'), 0);
});

test('legacy readers retain explicit zero net and do not reconvert a stored USD snapshot', () => {
  const o = order(1, '2026-10-04');
  o.extra_fields!.pricing!.subtotal_after_discount_usd = 0;
  o.extra_fields!.pricing!.fx_rate = 900;
  assert.equal(getOrderOperationalKpiAmounts(o).commercialNetUsd, 0);
  delete o.extra_fields!.pricing!.subtotal_after_discount_usd;
  assert.equal(getOrderOperationalKpiAmounts(o).commercialNetUsd, 10.004);
});

test('a historical rounding closure cannot hide newly collectible debt or round it closed again', () => {
  const o = order(1, '2026-10-04');
  o.extra_fields!.payment = { rounding_close: { closed_balance_usd: 0.02 } };
  const changed = state(o, 5, 6.004);
  const totals = getOrderOperationalKpiAmounts(o, changed);
  assert.equal(totals.pendingUsd, 6.004);
  assert.equal(getOrderOperationalKpiAmounts(o, state(o, 11.004, 0)).pendingUsd, 0);
  const result = buildAdminExecutiveKpiOverview({ orders: [o], financialStates: [changed], asOf });
  assert.equal(result.operational.today.pendingUsd, 6);
  assert.equal(result.today.pendingUsd, 6);
});
