import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEventOrders, type EventFinancialOrder } from '../../src/lib/events/event-workspace.ts';
test('consolidation counts each live order once, never transfers overpayment or includes cancelled revenue', () => {
  const row = (id: number, total: number, paid: number, pending: number, overpaid = 0, status = 'delivered') => ({ order_id: id, total_usd: total, confirmed_paid_usd: paid, pending_usd: pending, overpaid_usd: overpaid, order_status: status, pending_reports_count: 0 }) as EventFinancialOrder;
  assert.deepEqual(summarizeEventOrders([row(1,100,110,0,10),row(2,50,0,50),row(3,40,0,40,0,'cancelled')],1), {
    initial:100, additions:50, total:150, paid:110, pending:50, overpaid:10, pendingReports:0,
  });
});
