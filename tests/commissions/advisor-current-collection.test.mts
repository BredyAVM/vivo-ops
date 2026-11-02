import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAdvisorCurrentCollection } from '../../src/lib/commissions/advisor-current-collection.ts';
import type { CommissionLiveCollection, CommissionLiveOrder } from '../../src/lib/commissions/live-collections.ts';
import { calculateAdvisorGoalCollectionSummary } from '../../src/lib/commissions/goal-collection.ts';

const state = (overrides: Partial<CommissionLiveCollection> = {}): CommissionLiveCollection => ({
  closureId: 323, supported: true, checkedAt: '2026-11-02T14:00:00Z', agreedPayableUsd: 0,
  paidUsd: 0, customerDebtUsd: 0, carriedCommissionUsd: 0, priorAdvisorDebtUsd: 0,
  creditUsd: 18.88, payableUsd: 18.88, pendingUsd: 18.88, retainedUsd: 0,
  remainingCreditUsd: 18.88, advisorDebtUsd: 0, overpaidUsd: 0, orders: [],
  incomingTransferCount: 0, transferredToClosureId: null, transferredCreditUsd: null, transferredAt: null,
  ...overrides,
});
const liveOrder = (overrides: Partial<CommissionLiveOrder> = {}): CommissionLiveOrder => ({
  orderId: 2478, clientName: 'Cliente', deliveryDate: '2026-10-16', totalUsd: 116,
  billedUsd: 116, confirmedPaidUsd: 116, pendingUsd: 0, paymentStatus: 'paid', ...overrides,
});
const recorded = () => ({
  ...liveOrder({ confirmedPaidUsd: 106, pendingUsd: 10 }), orderNumber: '2478',
  billedUsd: 100, commissionUsd: 5, commissionMode: 'fixed_order',
  paymentTiming: 'pending' as 'pending' | 'punctual' | 'late' | null,
  paymentCompletedDate: null as string | null,
});
const view = (live = state()) => buildAdvisorCurrentCollection({ closureId: 323, live, recordedOrders: [recorded()] });

test('Martin: every current balance uses 18.88 while the original agreement remains zero', () => {
  const live = state();
  const before = structuredClone(live);
  const result = view(live);
  assert.equal(result.state?.pendingUsd, 18.88);
  assert.equal(result.state?.agreedPayableUsd, 0);
  assert.deepEqual(live, before);
});

test('validated collections release the current balance without revising the proposal or commission', () => {
  const before = view(state({ customerDebtUsd: 10, retainedUsd: 10, payableUsd: 8.88, pendingUsd: 8.88 }));
  const after = view(state());
  assert.equal(before.state?.pendingUsd, 8.88);
  assert.equal(after.state?.pendingUsd, 18.88);
  assert.equal(after.state?.agreedPayableUsd, before.state?.agreedPayableUsd);
  assert.equal(after.state?.creditUsd, before.state?.creditUsd);
});

test('advisor payments reduce pending: available total is not presented as still owed', () => {
  const result = view(state({ paidUsd: 10, pendingUsd: 8.88 }));
  assert.equal(result.state?.payableUsd, 18.88);
  assert.equal(result.state?.pendingUsd, 8.88);
});

test('transferred source stays at zero; the presentation cannot add carry a second time', () => {
  const source = state({ transferredToClosureId: 400, transferredCreditUsd: 18.88,
    pendingUsd: 0, payableUsd: 0, remainingCreditUsd: 0 });
  const destination = state({ closureId: 400, incomingTransferCount: 1, carriedCommissionUsd: 18.88 });
  assert.equal(view(source).state?.pendingUsd, 0);
  assert.equal(buildAdvisorCurrentCollection({ closureId: 400, live: destination, recordedOrders: [] }).state?.pendingUsd, 18.88);
});

test('overpayment remains explicit and never becomes a negative current payout', () => {
  const result = view(state({ payableUsd: 10, paidUsd: 18.88, pendingUsd: 0, overpaidUsd: 8.88 }));
  assert.equal(result.state?.pendingUsd, 0);
  assert.equal(result.state?.overpaidUsd, 8.88);
});

test('missing, unsupported, errored and foreign closure data never certify a current zero', () => {
  for (const params of [{}, { live: state({ supported: false }) }, { live: state(), error: 'Sin conexión' },
    { live: state({ closureId: 999 }) }]) {
    const result = buildAdvisorCurrentCollection({ closureId: 323, recordedOrders: [recorded()], ...params });
    assert.equal(result.state, undefined);
    assert.deepEqual(result.orders, [recorded()]);
  }
});

test('all order cash details refresh, preserving net of VAT, short number and special commission', () => {
  const original = recorded();
  const before = structuredClone(original);
  const result = buildAdvisorCurrentCollection({ closureId: 323, live: state({ orders: [liveOrder()] }), recordedOrders: [original] });
  assert.equal(result.orders[0].pendingUsd, 0);
  assert.equal(result.orders[0].confirmedPaidUsd, 116);
  assert.equal(result.orders[0].billedUsd, 100);
  assert.equal(result.orders[0].commissionUsd, 5);
  assert.equal(result.orders[0].orderNumber, '2478');
  assert.equal(result.orders[0].commissionMode, 'fixed_order');
  assert.deepEqual(original, before);
  assert.equal(result.pendingOrders.length, 0);
});

test('newly paid is not automatically punctual when its registration date cannot be verified', () => {
  const result = view(state({ orders: [liveOrder()] }));
  assert.equal(result.punctualOrders.length, 0);
  assert.equal(result.lateOrders.length, 0);
  assert.equal(result.unverifiedPaidOrders.length, 1);
  assert.equal(result.orders[0].paymentCompletedDate, null);
});

test('current dated evidence classifies a newly paid order, without altering the goal score', () => {
  for (const [date, expected] of [['2026-10-16', 'punctual'], ['2026-10-20', 'late']]) {
    const timing = calculateAdvisorGoalCollectionSummary({
      orders: [{ ...liveOrder(), orderNumber: '2478', deliveryDate: '2026-10-16' }],
      entries: [{ orderId: 2478, registeredDate: date, amountUsd: 116 }], asOfDate: '2026-11-02',
    });
    const before = structuredClone(timing);
    const result = buildAdvisorCurrentCollection({ closureId: 323, recordedOrders: [recorded()],
      live: state({ orders: [liveOrder()] }), timingOrders: timing.orders });
    assert.equal(result.orders[0].paymentTiming, expected);
    assert.equal(result.orders[0].paymentCompletedDate, date);
    assert.deepEqual(timing, before);
  }
});

test('missing current evidence overrides stale punctual labels; changed cash cannot reuse old dates', () => {
  const original = { ...recorded(), pendingUsd: 0, confirmedPaidUsd: 116, paymentTiming: 'punctual' as const };
  const timing = calculateAdvisorGoalCollectionSummary({
    orders: [{ ...liveOrder(), orderNumber: '2478', deliveryDate: '2026-10-16' }],
    entries: [], asOfDate: '2026-11-02',
  });
  const result = buildAdvisorCurrentCollection({ closureId: 323, recordedOrders: [original],
    live: state({ orders: [liveOrder()] }), timingOrders: timing.orders });
  assert.equal(result.unverifiedPaidOrders.length, 1);
  const changed = buildAdvisorCurrentCollection({ closureId: 323, recordedOrders: [original],
    live: state({ orders: [liveOrder({ confirmedPaidUsd: 120 })] }) });
  assert.equal(changed.unverifiedPaidOrders.length, 1);
});

test('a reopened debt clears stale payment date and reappears among pending orders', () => {
  const result = buildAdvisorCurrentCollection({ closureId: 323,
    recordedOrders: [{ ...recorded(), pendingUsd: 0, paymentTiming: 'punctual' as const, paymentCompletedDate: '2026-10-16' }],
    live: state({ orders: [liveOrder({ pendingUsd: 10, confirmedPaidUsd: 106 })] }) });
  assert.equal(result.pendingOrders.length, 1);
  assert.equal(result.punctualOrders.length, 0);
  assert.equal(result.orders[0].paymentCompletedDate, null);
});

test('incoming carry explains debt without increasing period sales or inventing a commission', () => {
  const carried = liveOrder({ orderId: 100, pendingUsd: 15, confirmedPaidUsd: 101 });
  const result = view(state({ orders: [liveOrder(), carried], incomingTransferCount: 1 }));
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].orderId, 2478);
  assert.equal(result.pendingOrders.length, 1);
  assert.equal(result.pendingOrders[0].orderId, 100);
  assert.equal(result.pendingOrders[0].commissionUsd, undefined);
});

test('advisor page uses one current state for tile and details and keeps agreement explicitly historical', () => {
  const source = readFileSync(new URL('../../src/app/app/advisor/commissions/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /label="Pendiente por pagar"\s+value=\{currentCollection \? money\(currentCollection.pendingUsd\) : 'Sin verificar'\}/);
  assert.equal((source.match(/<CollectionSummary state=\{currentCollection\}/g) ?? []).length, 2);
  assert.match(source, /Ver acuerdo original/);
  assert.match(source, /No representan el pendiente actual/);
  assert.doesNotMatch(source, /value=\{money\(closure.payable_usd\)\}/);
  assert.doesNotMatch(source, /\.update\(|\.insert\(|\.delete\(|calculateAdvisorCommissions/);
  const refresh = readFileSync(new URL('../../src/components/commissions/CollectionRefresh.tsx', import.meta.url), 'utf8');
  assert.match(refresh, /router.refresh\(\)/);
  assert.match(refresh, /30000/);
  assert.doesNotMatch(refresh, /supabase|\.rpc\(|calculateAdvisorCommissions/);
});
