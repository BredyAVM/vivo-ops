import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  filterAdminFinanceReceivables,
  normalizeAdminFinanceReceivablesFilters,
  type AdminFinanceReceivableOrder,
} from '../../src/lib/admin-finance/receivables-model.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(
  join(repositoryRoot, 'supabase/migrations/20260910142958_admin_finance_receivables_read_v1.sql'),
  'utf8'
);

function order(id: number, overrides: Partial<AdminFinanceReceivableOrder> = {}): AdminFinanceReceivableOrder {
  return {
    id,
    orderNumber: `V-${id}`,
    clientName: `Cliente ${id}`,
    advisorName: 'Asesor',
    deliveryDate: '2026-09-01',
    dueDate: '2026-09-06',
    ageDays: 9,
    totalUsd: 100,
    confirmedPaidUsd: 60,
    pendingUsd: 40,
    pendingReportsUsd: 0,
    pendingReportsCount: 0,
    paymentStatus: 'partial',
    collectionStatus: 'overdue_open',
    ...overrides,
  };
}

test('defaults cartera to the current month and overdue orders first', () => {
  const filters = normalizeAdminFinanceReceivablesFilters({});
  const result = filterAdminFinanceReceivables([
    order(1, { ageDays: 6 }),
    order(2, { collectionStatus: 'credit_open', ageDays: 3, pendingUsd: 90 }),
    order(3, { ageDays: 20, pendingUsd: 10 }),
  ], filters);

  assert.equal(filters.period, 'month');
  assert.deepEqual(result.orders.map((row) => row.id), [3, 1, 2]);
});

test('filters by collection status and searches order, client or advisor', () => {
  const filters = normalizeAdminFinanceReceivablesFilters({
    estado: 'credit_open',
    q: 'carla',
  });
  const result = filterAdminFinanceReceivables([
    order(1, { collectionStatus: 'credit_open', advisorName: 'Carla Díaz' }),
    order(2, { collectionStatus: 'overdue_open', clientName: 'Carla Foods' }),
    order(3, { collectionStatus: 'credit_open', clientName: 'Otra' }),
  ], filters);
  assert.deepEqual(result.orders.map((row) => row.id), [1]);
});

test('keeps the receivables RPC admin-only and current', () => {
  assert.match(migration, /create or replace function public\.admin_finance_receivables_overview_v1\(/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /role_row\.role = 'admin'/);
  assert.match(migration, /v_as_of timestamptz := pg_catalog\.statement_timestamp\(\)/);
  assert.match(migration, /'cutoffMode', 'current_statement'/);
  assert.match(migration, /revoke all on function public\.admin_finance_receivables_overview_v1\(date, date\)[\s\S]*?from public, anon, authenticated, service_role;/);
  assert.match(migration, /grant execute on function public\.admin_finance_receivables_overview_v1\(date, date\)[\s\S]*?to authenticated;/);
});

test('uses canonical balances, actual delivery events and the existing five-day rule', () => {
  assert.match(migration, /public\.get_order_financial_state\(/);
  assert.match(migration, /event_row\.event = 'delivered'/);
  assert.match(migration, /order_row\.delivery_date \+ 5 as due_date/);
  assert.match(migration, /v_local_date - order_row\.delivery_date <= 5/);
  assert.match(migration, /'paymentTimingBasis', 'payment_registration_date'/);
  assert.match(migration, /'missingRegistration'/);
});

test('screens conservatively before invoking the per-order canonical calculator', () => {
  assert.match(migration, /confirmed_inflow_usd/);
  assert.match(migration, /has_relevant_outflow/);
  assert.match(migration, /public\.client_fund_movements/);
  assert.match(migration, /report\.status = 'pending'/);
  assert.match(migration, /join portfolio_candidate candidate on candidate\.id = state\.order_id/);
});
