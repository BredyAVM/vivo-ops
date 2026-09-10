import assert from 'node:assert/strict';
import test from 'node:test';

type ResolveContext = { parentURL?: string };
type ResolveResult = { url: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;
type RegisterHooks = (hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => ResolveResult;
}) => void;

const nodeModule = await import('node:module');
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as RegisterHooks | undefined;
if (typeof registerHooks !== 'function') throw new Error('Node registerHooks is required.');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
    if (context.parentURL?.includes('/admin-finance/') && (specifier === './receivables-model' || specifier === './period')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { loadAdminFinanceReceivablesOverview } = await import(
  '../../src/lib/admin-finance/receivables-data.ts'
);

const asOf = '2026-09-10T16:00:00.000Z';

function payload() {
  return {
    definitionVersion: 'admin-finance-receivables-v1',
    asOf: '2026-09-10T16:00:02.000Z',
    asOfDate: '2026-09-10',
    cutoffMode: 'current_statement',
    balanceSource: 'canonical_order_financial_state',
    paymentTimingBasis: 'payment_registration_date',
    graceDays: 5,
    period: {
      from: '2026-09-01', to: '2026-09-10', orders: 10, billedUsd: 1000,
      coveredUsd: 800, pendingUsd: 200, punctualPaid: 4, creditPaid: 2,
      overduePaid: 1, creditOpen: 1, overdueOpen: 1, missingRegistration: 1,
    },
    portfolio: {
      openOrders: 2, receivableUsd: 200, graceOrders: 1, graceUsd: 80,
      overdueOrders: 1, overdueUsd: 120, pendingReports: 0,
      pendingReportsUsd: 0, oldestAgeDays: 12,
    },
    openOrders: [{
      id: 7, orderNumber: 'V-7', clientName: 'Cliente', advisorName: 'Asesor',
      deliveryDate: '2026-09-01', dueDate: '2026-09-06', ageDays: 9,
      totalUsd: 150, confirmedPaidUsd: 30, pendingUsd: 120,
      pendingReportsUsd: 0, pendingReportsCount: 0, paymentStatus: 'partial',
      collectionStatus: 'overdue_open',
    }],
  };
}

test('loads the protected month-to-date receivables snapshot', async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const supabase = {
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });
      return { data: payload(), error: null };
    },
  };
  const result = await loadAdminFinanceReceivablesOverview({
    supabase,
    periodKey: 'month',
    asOf: new Date(asOf),
  });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.data.portfolio.overdueUsd, 120);
    assert.equal(result.data.openOrders[0].collectionStatus, 'overdue_open');
  }
  assert.deepEqual(calls, [{
    name: 'admin_finance_receivables_overview_v1',
    params: { p_period_from: '2026-09-01', p_period_to: '2026-09-10' },
  }]);
});

test('fails closed on an incompatible or stale response', async () => {
  const incompatible = await loadAdminFinanceReceivablesOverview({
    supabase: { async rpc() { return { data: { ...payload(), definitionVersion: 'wrong' }, error: null }; } },
    periodKey: 'month',
    asOf: new Date(asOf),
  });
  assert.equal(incompatible.status, 'error');

  const stale = await loadAdminFinanceReceivablesOverview({
    supabase: { async rpc() { return { data: { ...payload(), asOf: '2026-09-10T15:00:00.000Z' }, error: null }; } },
    periodKey: 'month',
    asOf: new Date(asOf),
  });
  assert.equal(stale.status, 'error');
});
