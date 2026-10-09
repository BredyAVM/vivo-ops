import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildOrderPaymentQuote, readOrderPaymentQuote, quoteOperationDate,
  type PaymentQuoteState, type PaymentQuoteReader } from '../../src/lib/orders/payment-quote.ts';

const now = new Date('2026-10-09T15:00:00Z');
const state: PaymentQuoteState = {
  order_id: 2934, pending_usd: '6.33', pending_bs: '5175.00', snapshot_rate_bs_per_usd: '817.70',
  collection_mode: 'snapshot_quote', pending_reports_count: 0, effective_operation_date: '2026-10-09',
};

function setup(patch: Partial<PaymentQuoteState> = {}) {
  const calls: string[] = [];
  const reader: PaymentQuoteReader = {
    async readOrder(id) { calls.push(`order:${id}`); return { id, status: 'delivered', attributed_advisor_id: 'owner' }; },
    async readActiveRate() { calls.push('rate'); return 860.2; },
    async readState(id, date, rate) { calls.push(`state:${id}:${date}:${rate}`); return { ...state, ...patch }; },
  };
  return { reader, calls };
}

test('snapshot quote keeps native Bs and stored FX, not the ratio of displayed balances', () => {
  const quote = buildOrderPaymentQuote({ orderId: 2934, state, activeRate: 860.2, now });
  assert.equal(quote.pendingBs, 5175);
  assert.equal(quote.exchangeRate, 817.7);
  assert.notEqual(quote.exchangeRate, quote.pendingBs / quote.pendingUsd);
  assert.notEqual(quote.pendingBs, Math.round(quote.pendingUsd * 817.7 * 100) / 100);
  assert.match(quote.text, /Tasa del presupuesto/);
  assert.match(quote.text, /Se conserva el monto/);
});

test('collection uses current FX but preserves the canonical precise Bs quote', () => {
  const quote = buildOrderPaymentQuote({ orderId: 2934, activeRate: 860.2, now,
    state: { ...state, collection_mode: 'post_delivery_usd', pending_bs: '5445.11' } });
  assert.equal(quote.exchangeRate, 860.2);
  assert.equal(quote.pendingBs, 5445.11);
  assert.match(quote.text, /Tasa vigente/);
  assert.doesNotMatch(quote.text, /VO-\d|5175|monto.*acordado/);
});

test('only current debt is quoted, with pending report warning and short order number', () => {
  const quote = buildOrderPaymentQuote({ orderId: 2934, state: { ...state, pending_reports_count: 1 }, activeRate: 860.2, now });
  assert.match(quote.text, /\*Orden:\* 2934/);
  assert.match(quote.text, /\$6\.33/);
  assert.match(quote.text, /pagos por revisar/);
  assert.doesNotMatch(quote.text, /TOTAL.*pedido/);
});

test('Caracas date is used across UTC midnight', () => {
  assert.equal(quoteOperationDate(new Date('2026-10-10T02:00:00Z')), '2026-10-09');
  assert.equal(quoteOperationDate(new Date('2026-10-10T04:00:00Z')), '2026-10-10');
});

test('zero balance remains zero; querying does not forgive a subcent debt', () => {
  const quote = buildOrderPaymentQuote({ orderId: 2934, activeRate: 860.2, now,
    state: { ...state, pending_usd: 0, pending_bs: 0 } });
  assert.match(quote.text, /Sin deuda pendiente/);
  const small = buildOrderPaymentQuote({ orderId: 2934, activeRate: 860.2, now,
    state: { ...state, pending_usd: .009, pending_bs: 7.36 } });
  assert.equal(small.pendingUsd, .009);
  assert.equal(small.pendingBs, 7.36);
  assert.doesNotMatch(small.text, /Sin deuda pendiente/);
});

test('missing money, wrong order, unknown mode and stale date fail closed', () => {
  for (const patch of [
    { pending_bs: null }, { pending_usd: null }, { pending_usd: -1 }, { pending_bs: 'oops' },
    { order_id: 42 }, { collection_mode: 'future_mode' }, { snapshot_rate_bs_per_usd: null },
    { effective_operation_date: '2026-10-08' }, { pending_reports_count: .5 },
  ]) assert.throws(() => buildOrderPaymentQuote({ orderId: 2934, state: { ...state, ...patch }, activeRate: 860.2, now }));
  for (const activeRate of [0, -1, Number.NaN]) {
    assert.throws(() => buildOrderPaymentQuote({ orderId: 2934, state, activeRate, now }));
  }
});

test('anonymous and unauthorized roles cannot read an order', async () => {
  for (const actor of [{ userId: '', roles: ['admin'] }, { userId: 'owner', roles: [] }, { userId: 'owner', roles: ['driver'] }]) {
    const { reader, calls } = setup();
    await assert.rejects(readOrderPaymentQuote({ orderId: 2934, actor, reader, now }));
    assert.deepEqual(calls, []);
  }
});

test('advisor cannot query another advisor’s financial state or rate', async () => {
  const { reader, calls } = setup();
  await assert.rejects(readOrderPaymentQuote({ orderId: 2934, actor: { userId: 'other', roles: ['advisor'] }, reader, now }), /No autorizado/);
  assert.deepEqual(calls, ['order:2934']);
});

test('own advisor, master and admin use the same scoped canonical query', async () => {
  for (const actor of [{ userId: 'owner', roles: ['advisor'] }, { userId: 'other', roles: ['master'] }, { userId: 'other', roles: ['admin'] }]) {
    const { reader, calls } = setup();
    const quote = await readOrderPaymentQuote({ orderId: 2934, actor, reader, now });
    assert.equal(quote.pendingUsd, 6.33);
    assert.deepEqual(calls, ['order:2934', 'rate', 'state:2934:2026-10-09:860.2']);
  }
});

test('cancelled orders and invalid identifiers do not request financial data', async () => {
  const { reader, calls } = setup();
  reader.readOrder = async id => ({ id, status: 'cancelled', attributed_advisor_id: 'owner' });
  await assert.rejects(readOrderPaymentQuote({ orderId: 2934, actor: { userId: 'owner', roles: ['advisor'] }, reader, now }), /cancelada/);
  assert.deepEqual(calls, []);
  for (const orderId of [0, -1, 1.5, Number.NaN]) await assert.rejects(readOrderPaymentQuote({ orderId, actor: { userId: 'owner', roles: ['admin'] }, reader, now }));
});

test('every click reads fresh rate and debt, without a cache or a financial write', async () => {
  const { reader } = setup();
  const input = { orderId: 2934, actor: { userId: 'owner', roles: ['advisor'] }, reader, now };
  const first = await readOrderPaymentQuote(input);
  reader.readActiveRate = async () => 900;
  reader.readState = async () => ({ ...state, pending_usd: 2, pending_bs: 1800, collection_mode: 'post_delivery_usd' });
  const second = await readOrderPaymentQuote(input);
  assert.equal(first.pendingUsd, 6.33);
  assert.equal(second.pendingUsd, 2);
  assert.equal(second.exchangeRate, 900);
  const action = readFileSync(new URL('../../src/lib/orders/payment-quote-action.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(action, /\.insert\(|\.update\(|\.delete\(|service_role|revalidatePath|sendPush/);
  assert.match(action, /requireAuthContext\(\)/);
  const component = readFileSync(new URL('../../src/components/orders/OrderPaymentQuoteButton.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /useEffect|setInterval|fetch\(/);
  assert.match(component, /loadOrderPaymentQuoteAction\(\{ orderId \}\)/);
});

test('quote actions are compact, mobile touch targets and Escape preserves the parent drawer', () => {
  const component = readFileSync(new URL('../../src/components/orders/OrderPaymentQuoteButton.tsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../../src/components/orders/OrdersWorkspaceClient.tsx', import.meta.url), 'utf8');
  assert.match(component, /min-h-11/);
  assert.match(component, /sm:min-h-9/);
  assert.match(component, /event.key === 'Escape'/);
  assert.match(component, /event.stopPropagation\(\)/);
  assert.match(component, /triggerRef.current\?\.focus\(\)/);
  assert.match(workspace, /flex max-w-full flex-wrap items-center justify-end gap-2 self-end/);
});
