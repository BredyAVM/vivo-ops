import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readOrderSearchPayments, orderSearchPaymentPresentation, searchPaymentOrderIds } from '../../src/lib/search/order-search-payments.ts';

const row = (id: number, pending = 10, reports = 0, overpaid = 0) => ({
  order_id: id, total_usd: '20', confirmed_paid_usd: '10', pending_usd: pending,
  overpaid_usd: overpaid, pending_reports_count: reports,
});
test('one canonical batch covers deduplicated local and historical matches, preserving the supplied balance', async () => {
  let calls = 0;
  const payments = await readOrderSearchPayments([3, 4, 3], async ids => {
    calls++; assert.deepEqual(ids, [3,4]); return { data: [row(4,0,1),row(3,12.37)], error: null };
  });
  assert.equal(calls,1); assert.equal(payments[0].pendingUsd,12.37);
  assert.equal(payments[1].pendingUsd,0); assert.equal(payments[1].pendingReports,1);
});
test('empty selection makes no financial request; invalid or oversized selections fail before reading', async () => {
  assert.deepEqual(await readOrderSearchPayments([], async () => {throw new Error('must not read');}),[]);
  for(const ids of [[0],[-1],[NaN],[1.5],Array.from({length:21},(_,i)=>i+1)]) assert.throws(()=>searchPaymentOrderIds(ids));
  assert.throws(()=>searchPaymentOrderIds([1,2],1));
  for(const values of [[true],['1'],[null],{}]) assert.throws(()=>searchPaymentOrderIds(values));
});
test('missing, duplicate, foreign or invalid financial responses never become zero/paid', async () => {
  const invalid: unknown[] = [null, [], [row(2)], [row(1),row(1)], [row(1,-1)],
    [{...row(1),pending_usd:null}], [{...row(1),overpaid_usd:'NaN'}], [{...row(1),pending_reports_count:null}],
    [{...row(1),pending_reports_count:0.5}]];
  for(const data of invalid) await assert.rejects(()=>readOrderSearchPayments([1],async()=>({data,error:null})));
  await assert.rejects(()=>readOrderSearchPayments([1],async()=>({data:[row(1)],error:new Error('denied')})));
});
test('unpaid, partial, paid, review and credit labels stay independent of physical delivery status', () => {
  const payment = {orderId:1,pendingUsd:12.37,overpaidUsd:0,pendingReports:0};
  assert.equal(orderSearchPaymentPresentation(payment,false,false).label,'Pendiente por pagar');
  assert.equal(orderSearchPaymentPresentation({...payment,pendingReports:1},false,false).review,true);
  assert.equal(orderSearchPaymentPresentation({...payment,pendingUsd:0},false,false).label,'Pagado');
  assert.equal(orderSearchPaymentPresentation({...payment,pendingUsd:0,pendingReports:1},false,false).label,'Sin saldo pendiente');
  assert.equal(orderSearchPaymentPresentation({...payment,pendingUsd:0,overpaidUsd:5},false,false).label,'Saldo a favor');
  assert.match(orderSearchPaymentPresentation(payment,true,false).label,/Cancelada/);
  assert.match(orderSearchPaymentPresentation(undefined,false,true).label,/Consultando/);
  assert.match(orderSearchPaymentPresentation(undefined,false,false).label,/no disponible/);
});
test('only operational Master/Admin workspace opts in; action authenticates and has no mutations', () => {
  const read=(path:string)=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
  const action=read('src/lib/search/order-search-payment-actions.ts');
  assert.match(action,/requireMasterOrAdminContext\(\)/);
  assert.match(action,/searchPaymentOrderIds\(input.localOrderIds, 10\)/);
  assert.match(action,/searchMasterDirectoryAction\(\{ query, limit: 10 \}\)/);
  assert.match(action,/get_orders_financial_state/);
  assert.doesNotMatch(action,/service_role|\.insert\(|\.update\(|\.delete\(|revalidatePath/);
  const ui=read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(ui,/OrderSearchPaymentStatus payment=\{searchPaymentById.get\(result.id\)\}/);
  assert.match(ui,/setSearchPayments\(results.payments\)/);
  assert.match(ui,/cancelled = true/);
  assert.doesNotMatch(read('src/app/app/master/dashboard/MasterDashboardClient.tsx'),/OrderSearchPaymentStatus|searchOrderDirectoryWithPaymentsAction/);
  for(const path of ['src/app/app/master/ops/page.tsx','src/app/app/admin/ordenes/page.tsx']) assert.match(read(path),/OrdersWorkspace/);
});
