import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdvisorGoalPaymentCompletionDates,
  calculateAdvisorGoalCollectionSummary,
} from '../../src/lib/commissions/goal-collection.ts';
import { loadAdvisorGoalCollectionForClosure } from '../../src/lib/commissions/goal-data.ts';

const orders = [
  { orderId: 1, orderNumber: '1', clientName: 'Cliente puntual', deliveryDate: '2026-08-10', totalUsd: 100, confirmedPaidUsd: 100, pendingUsd: 0 },
  { orderId: 2, orderNumber: '2', clientName: 'Cliente crédito', deliveryDate: '2026-08-10', totalUsd: 80, confirmedPaidUsd: 80, pendingUsd: 0 },
  { orderId: 3, orderNumber: '3', clientName: 'Cliente pendiente', deliveryDate: '2026-08-10', totalUsd: 50, confirmedPaidUsd: 0, pendingUsd: 50 },
];

test('usa la fecha de registro del pago completo y no la fecha bancaria', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders,
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 40 },
      { orderId: 1, registeredDate: '2026-08-12', amountUsd: 60 },
      { orderId: 2, registeredDate: '2026-08-16', amountUsd: 80 },
    ],
  });

  assert.equal(completed.get(1), '2026-08-12');
  assert.equal(completed.get(2), '2026-08-16');
  assert.equal(completed.has(3), false);
});

test('una devolución posterior invalida la fecha anterior de pago completo', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders: [orders[0]],
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 100 },
      { orderId: 1, registeredDate: '2026-08-11', amountUsd: -20 },
      { orderId: 1, registeredDate: '2026-08-13', amountUsd: 20 },
    ],
  });

  assert.equal(completed.get(1), '2026-08-13');
});

test('resume puntual, crédito de cinco días y atraso en una sola relación', () => {
  const summary = calculateAdvisorGoalCollectionSummary({
    orders,
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 100 },
      { orderId: 2, registeredDate: '2026-08-15', amountUsd: 80 },
    ],
    asOfDate: '2026-08-20',
  });

  assert.equal(summary.ratio, 0.6);
  assert.equal(summary.punctualCount, 1);
  assert.equal(summary.creditCount, 1);
  assert.equal(summary.overdueCount, 1);
  assert.deepEqual(summary.orders.map((order) => order.status), [
    'punctual_paid',
    'credit_paid',
    'overdue_open',
  ]);
  assert.equal(summary.orders[2].clientName, 'Cliente pendiente');
  assert.equal(summary.orders[2].creditDueDate, '2026-08-15');
});

test('separa una deuda vigente de un pago sin fecha verificable', () => {
  const summary = calculateAdvisorGoalCollectionSummary({
    orders: [
      { ...orders[0], orderId: 4, pendingUsd: 100, confirmedPaidUsd: 0 },
      { ...orders[0], orderId: 5, pendingUsd: 0, confirmedPaidUsd: 100 },
    ],
    entries: [],
    asOfDate: '2026-08-12',
  });

  assert.equal(summary.orders[0].status, 'credit_open');
  assert.equal(summary.orders[1].status, 'missing_registration');
  assert.equal(summary.orders[1].value, 0);
  assert.equal(summary.creditCount, 1);
  assert.equal(summary.overdueCount, 0);
});

test('un pago sin evidencia no se convierte en atraso después de cinco días', () => {
  const summary = calculateAdvisorGoalCollectionSummary({ orders: [orders[0]], entries: [], asOfDate: '2026-08-20' });
  assert.equal(summary.orders[0].status, 'missing_registration');
  assert.equal(summary.overdueCount, 0);
  assert.equal(summary.creditCount, 0);
  assert.equal(summary.ratio, 0);
});

test('no perdona un centavo de deuda ni inventa la fecha de un pago que no consta', () => {
  for (const pendingUsd of [0, 0.01]) {
    const completed = buildAdvisorGoalPaymentCompletionDates({
      orders: [{ ...orders[0], pendingUsd }],
      entries: [{ orderId: 1, registeredDate: '2026-08-10', amountUsd: 99.99 }],
    });
    assert.equal(completed.has(1), false);
  }
});

test('usa precisión sin redondear cada abono y no adelanta el pago al primer abono', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders: [{ ...orders[0], paymentTargetUsd: 99.994 }],
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 99.99 },
      { orderId: 1, registeredDate: '2026-08-12', amountUsd: 0.004 },
    ],
  });
  assert.equal(completed.get(1), '2026-08-12');
});

test('la cobertura nativa conserva la fecha de registro y se invalida con devolución', () => {
  const completed = buildAdvisorGoalPaymentCompletionDates({
    orders: [{ ...orders[0], paymentTargetBs: 1000 }],
    entries: [
      { orderId: 1, registeredDate: '2026-08-10', amountUsd: 99.99, eligibleSnapshotBs: 1000 },
      { orderId: 1, registeredDate: '2026-08-11', amountUsd: -20, eligibleSnapshotBs: -200 },
      { orderId: 1, registeredDate: '2026-08-12', amountUsd: 20, eligibleSnapshotBs: 200 },
    ],
  });
  assert.equal(completed.get(1), '2026-08-12');
});

test('concilia los cuatro casos auditados de Jacqueline con evidencia financiera, sin cambiar fechas', async () => {
  const fixtures = [
    { id: 2645, total: 34.10, cash: 30.40, applied: 30.40482463290451, fund: 3.69, precise: 34.09482463290451, bs: 28861.61, paidBs: 28857.52, date: '2026-09-16', registered: '2026-09-16T16:23:38Z' },
    { id: 2721, total: 31.18, cash: 31.17, applied: 31.170820811973368, fund: 0, precise: 31.170820811973368, bs: 26450, paidBs: 26450, date: '2026-09-18', registered: '2026-09-18T22:45:13Z' },
    { id: 2736, total: 48.74, cash: 48.73, applied: null, fund: 0, precise: null, bs: 41400, paidBs: 41400, date: '2026-09-19', registered: '2026-09-19T13:08:55Z' },
    { id: 2750, total: 58.56, cash: 58.55, applied: 58.54833090070154, fund: 0, precise: 58.54833090070154, bs: 49740.32, paidBs: 49740, date: '2026-09-19', registered: '2026-09-20T14:21:06Z' },
  ];
  const rows = {
    money_movements: fixtures.map(f => ({ id: f.id, order_id: f.id, created_at: '2026-09-22T12:00:00Z', direction: 'inflow', movement_type: 'order_payment', amount_usd_equivalent: f.cash, amount: f.paidBs, currency_code: 'VES', payment_report_id: f.id })),
    payment_reports: fixtures.map(f => ({ id: f.id, confirmed_movement_id: f.id, created_at: f.registered, operation_date: f.date, reported_currency_code: 'VES', reported_amount: f.paidBs, reported_amount_usd_equivalent: f.cash })),
    client_fund_movements: [{ order_id: 2645, movement_type: 'debit', reason_code: 'order_fund_applied', amount_usd: 3.69, created_at: '2026-09-16T16:08:18Z' }],
    counter_command_receipts: [],
    order_payment_precision_allocations: fixtures.filter(f => f.applied != null).map(f => ({ movement_id: f.id, applied_usd: f.applied })),
  };
  const supabase = {
    from(table: keyof typeof rows) {
      const query = {
        select() { return query; }, in() { return query; }, eq() { return query; }, not() { return query; },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows[table], error: null }).then(resolve); },
      };
      return query;
    },
    async rpc(name: string, args: { p_order_id?: number }) {
      if (name === 'get_orders_financial_state') return { data: fixtures.map(f => ({ order_id: f.id, total_usd: f.total, confirmed_paid_usd: f.total, pending_usd: 0, total_bs: f.bs, confirmed_paid_bs_snapshot: f.paidBs, snapshot_rate_bs_per_usd: 849.56, delivery_reference_date: f.date })), error: null };
      assert.equal(name, 'order_collection_precision_basis_v1');
      const f = fixtures.find(f => f.id === args.p_order_id)!;
      return { data: f.precise == null ? [] : [{ total_precise_usd: f.precise }], error: null };
    },
  };
  const summary = await loadAdvisorGoalCollectionForClosure({
    supabase: supabase as unknown as Parameters<typeof loadAdvisorGoalCollectionForClosure>[0]['supabase'],
    advisorUserId: 'jacqueline', periodTo: '2026-09-30',
    snapshot: { orders: fixtures.map(f => ({ orderId: f.id, deliveryDate: f.date, totalUsd: f.total, confirmedPaidUsd: f.total, pendingUsd: 0 })) },
  });
  assert.deepEqual(summary?.orders.map(o => [o.orderId, o.status, o.completedPaymentRegistrationDate]), [
    [2645, 'punctual_paid', '2026-09-16'], [2721, 'punctual_paid', '2026-09-18'],
    [2736, 'punctual_paid', '2026-09-19'], [2750, 'credit_paid', '2026-09-20'],
  ]);
  assert.equal(summary?.ratio, 0.95);
});
