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
    if (
      context.parentURL?.includes('/admin-finance/') &&
      (specifier === './accounts-model' || specifier === './model' || specifier === '../domain/finance-domain')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { loadAdminFinanceAccountDetail, loadAdminFinanceAccountsOverview } = await import(
  '../../src/lib/admin-finance/accounts-data.ts'
);

const asOf = '2026-09-09T18:45:00.000Z';

function snapshot() {
  return {
    id: 7,
    name: 'Cuenta de prueba',
    currencyCode: 'VES',
    accountKind: 'bank',
    institutionName: null,
    ownerName: null,
    isActive: true,
    closureKind: 'bank',
    baselineRequired: true,
    balanceNative: 400,
    ledgerValueUsd: 4,
    currentValueUsd: 4,
    anchorKind: 'closure',
    anchorDate: '2026-09-09',
    anchorAt: '2026-09-09T14:00:00.000Z',
    anchorAmount: 300,
    latestClosureId: 22,
    latestClosureDate: '2026-09-09',
    latestClosureAt: '2026-09-09T14:00:00.000Z',
    latestClosureStatus: 'recorded',
    latestClosureDifference: 0,
    latestClosureDifferenceUsd: 0,
    openReconciliations: 1,
    openReconciliationNative: 10,
    openReconciliationUsd: 0.1,
    orphanedReconciliations: 0,
    pendingMovementOperations: 2,
    pendingMovementNative: 25,
    pendingMovementUsd: 0.25,
    quality: 'Q1_exact',
  };
}

test('loads the protected account overview and derives its workstream', async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const serverAsOf = '2026-09-09T18:45:02.000Z';
  const supabase = {
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });
      return {
        error: null,
        data: {
          definitionVersion: 'admin-finance-accounts-v2',
          asOf: serverAsOf,
          cutoffMode: 'current_statement',
          rateBasis: 'single_active_at_current_statement',
          activeRateCount: 1,
          rateQuality: 'Q1_exact',
          activeRateBsPerUsd: 100,
          activeRateEffectiveAt: '2026-09-09T12:00:00.000Z',
          summary: {
            activeAccounts: 1,
            inactiveAccounts: 0,
            anchoredAccounts: 1,
            attentionAccounts: 1,
            nativeUsdTotal: 0,
            nativeVesTotal: 400,
            nativeUsdCoveredTotal: 0,
            nativeUsdUncoveredTotal: 0,
            nativeUsdCoveredAccounts: 0,
            nativeUsdTotalAccounts: 0,
            nativeUsdCoveragePct: null,
            nativeUsdQuality: 'Q1_exact',
            nativeVesCoveredTotal: 400,
            nativeVesUncoveredTotal: 0,
            nativeVesCoveredAccounts: 1,
            nativeVesTotalAccounts: 1,
            nativeVesCoveragePct: 100,
            nativeVesQuality: 'Q1_exact',
            nativeTotalsQuality: 'Q1_exact',
            openReconciliations: 1,
            pendingMovementOperations: 2,
          },
          accounts: [snapshot()],
        },
      };
    },
  };

  const result = await loadAdminFinanceAccountsOverview({ supabase, asOf: new Date(asOf) });

  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.data.accounts[0].workstream, 'bank');
    assert.equal(result.data.accounts[0].balanceNative, 400);
    assert.equal(result.data.asOf, serverAsOf);
  }
  assert.equal(calls[0].name, 'admin_finance_accounts_overview_v2');
  assert.equal(calls[0].params.p_include_inactive, true);
  assert.equal('p_as_of' in calls[0].params, false);
});

test('loads a paginated detail without treating a pending amount as balance', async () => {
  const supabase = {
    async rpc() {
      return {
        error: null,
        data: {
          definitionVersion: 'admin-finance-accounts-v2',
          asOf,
          cutoffMode: 'current_statement',
          rateBasis: 'single_active_at_current_statement',
          activeRateCount: 1,
          rateQuality: 'Q1_exact',
          found: true,
          account: snapshot(),
          section: 'movements',
          fromDate: '2026-09-01',
          toDate: '2026-09-09',
          status: 'all',
          page: 1,
          pageSize: 40,
          totalRows: 1,
          period: { inflowNative: 100, outflowNative: 0, netNative: 100, pendingNative: 25 },
          rows: [
            {
              kind: 'movement',
              id: 99,
              movementDate: '2026-09-09',
              createdAt: '2026-09-09T15:00:00.000Z',
              direction: 'inflow',
              movementType: 'order_payment',
              currencyCode: 'VES',
              amount: 100,
              amountUsdEquivalent: 1,
              exchangeRateVesPerUsd: 100,
              referenceCode: null,
              counterpartyName: null,
              description: null,
              orderId: 5,
              status: 'confirmed',
              approvalRequired: false,
            },
          ],
        },
      };
    },
  };

  const result = await loadAdminFinanceAccountDetail({
    supabase,
    accountId: 7,
    section: 'movements',
    fromDate: '2026-09-01',
    toDate: '2026-09-09',
    status: 'all',
    page: 1,
    asOf: new Date(asOf),
  });

  assert.equal(result.status, 'ready');
  if (result.status === 'ready' && result.data) {
    assert.equal(result.data.account.balanceNative, 400);
    assert.equal(result.data.period.pendingNative, 25);
    assert.equal(result.data.rows[0].kind, 'movement');
  }
});

test('fails closed when the RPC returns an incompatible financial definition', async () => {
  const supabase = {
    async rpc() {
      return { error: null, data: { definitionVersion: 'unknown', asOf } };
    },
  };

  const result = await loadAdminFinanceAccountsOverview({ supabase, asOf: new Date(asOf) });
  assert.equal(result.status, 'error');
});

test('fails closed when the server cut is too far from the request time', async () => {
  const supabase = {
    async rpc() {
      return {
        error: null,
        data: {
          definitionVersion: 'admin-finance-accounts-v2',
          asOf: '2026-09-09T19:00:01.000Z',
        },
      };
    },
  };

  const result = await loadAdminFinanceAccountsOverview({ supabase, asOf: new Date(asOf) });
  assert.equal(result.status, 'error');
});
