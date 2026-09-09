import assert from 'node:assert/strict';
import test from 'node:test';

type ResolveContext = { parentURL?: string };
type ResolveResult = { url: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;
type RegisterHooks = (hooks: {
  resolve: (
    specifier: string,
    context: ResolveContext,
    nextResolve: NextResolve
  ) => ResolveResult;
}) => void;

const nodeModule = await import('node:module');
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as RegisterHooks | undefined;

if (typeof registerHooks !== 'function') {
  throw new Error('The Admin test runner requires Node registerHooks support.');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {};', shortCircuit: true };
    }

    if (
      (specifier === './model' || specifier === './period') &&
      context.parentURL?.includes('/admin-finance/')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }

    return nextResolve(specifier, context);
  },
});

const { loadAdminFinancialOverview } = await import('../../src/lib/admin-finance/data.ts');

test('keeps fulfilled financial domains visible when one RPC rejects', async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const internalFailure = 'internal treasury connection detail';
  const asOf = '2026-09-08T16:00:00.000Z';
  const supabase = {
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });

      if (name === 'admin_finance_treasury_overview_v1') {
        return { data: null, error: { message: internalFailure } };
      }

      if (name === 'admin_finance_commercial_overview_v1') {
        return {
          data: {
            definitionVersion: 'admin-finance-v1',
            asOf,
            periodStart: '2026-09-08',
            periodEndExclusive: '2026-09-09',
            deliveredOrders: 2,
            deliveredSalesUsd: 125,
            previousDeliveredOrders: 1,
            previousDeliveredSalesUsd: 100,
            scheduledOrders: 3,
            scheduledSalesUsd: 240,
            blockedScheduledOrders: 0,
            scheduledQuality: 'Q1_exact',
            scheduledExactPricingOrders: 3,
            quality: 'Q1_exact',
            exactPricingOrders: 2,
            totalPricingOrders: 2,
            series: [{ dateKey: '2026-09-08', salesUsd: 125 }],
          },
          error: null,
        };
      }

      return {
        data: {
          definitionVersion: 'admin-finance-v1',
          asOf,
          activeRateBsPerUsd: 150,
          activeRateEffectiveAt: '2026-09-08T12:00:00.000Z',
          previousRateBsPerUsd: 145,
          activeRateCount: 1,
          activeAccounts: 2,
          anchoredAccounts: 2,
          latestClosureDate: '2026-09-08',
          accountCoverageQuality: 'Q1_exact',
          clientFundsUsd: 10,
          clientFundLedgerUsd: 10,
          clientFundDifferenceUsd: 0,
          clientFundsQuality: 'Q1_exact',
          openReconciliations: 0,
          openReconciliationsUsd: 0,
          orphanedReconciliations: 0,
          treasuryPositionUsd: 200,
          treasuryAfterClientFundsUsd: 190,
          treasuryQuality: 'Q3_incomplete',
        },
        error: null,
      };
    },
  };

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    const overview = await loadAdminFinancialOverview({
      supabase,
      periodKey: 'today',
      asOf: new Date(asOf),
    });

    assert.equal(overview.commercial.status, 'ready');
    if (overview.commercial.status === 'ready') {
      assert.equal(overview.commercial.data.deliveredSalesUsd, 125);
    }

    assert.deepEqual(overview.treasury, {
      status: 'error',
      message: 'No pudimos cargar los movimientos de tesoreria de este periodo.',
    });
    assert.doesNotMatch(overview.treasury.message, new RegExp(internalFailure));

    assert.equal(overview.position.status, 'ready');
    if (overview.position.status === 'ready') {
      assert.equal(overview.position.data.activeRateBsPerUsd, 150);
      assert.equal(overview.position.data.treasuryAfterClientFundsUsd, 190);
    }

    assert.deepEqual(
      calls.map((call) => call.name).sort(),
      [
        'admin_finance_commercial_overview_v1',
        'admin_finance_position_overview_v1',
        'admin_finance_treasury_overview_v1',
      ]
    );
    assert.ok(
      calls.every((call) => call.params.p_as_of === asOf),
      'all domains must share one as_of timestamp'
    );
    assert.match(warnings.join('\n'), /admin financial treasury overview skipped/);
    assert.match(warnings.join('\n'), new RegExp(internalFailure));
  } finally {
    console.warn = originalWarn;
  }
});

test('turns a malformed required amount into an unavailable domain, never a zero', async () => {
  const asOf = '2026-09-08T16:00:00.000Z';
  const supabase = {
    async rpc(name: string) {
      if (name === 'admin_finance_commercial_overview_v1') {
        return {
          data: {
            definitionVersion: 'admin-finance-v1',
            asOf,
            periodStart: '2026-09-08',
            periodEndExclusive: '2026-09-09',
            deliveredOrders: 1,
            previousDeliveredOrders: 0,
            previousDeliveredSalesUsd: 0,
            scheduledOrders: 0,
            scheduledSalesUsd: 0,
            blockedScheduledOrders: 0,
            scheduledQuality: 'Q1_exact',
            scheduledExactPricingOrders: 0,
            quality: 'Q1_exact',
            exactPricingOrders: 1,
            totalPricingOrders: 1,
            series: [],
          },
          error: null,
        };
      }

      return { data: null, error: { message: 'fixture domain unavailable' } };
    },
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    const overview = await loadAdminFinancialOverview({
      supabase,
      periodKey: 'today',
      asOf: new Date(asOf),
    });

    assert.deepEqual(overview.commercial, {
      status: 'error',
      message: 'No pudimos cargar las ventas de este periodo.',
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('rejects an RPC response from a different financial definition version', async () => {
  const asOf = '2026-09-08T16:00:00.000Z';
  const supabase = {
    async rpc(name: string) {
      if (name === 'admin_finance_position_overview_v1') {
        return {
          data: {
            definitionVersion: 'admin-finance-v0',
            asOf,
            activeRateBsPerUsd: 150,
          },
          error: null,
        };
      }
      return { data: null, error: { message: 'fixture domain unavailable' } };
    },
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    const overview = await loadAdminFinancialOverview({
      supabase,
      periodKey: 'today',
      asOf: new Date(asOf),
    });

    assert.deepEqual(overview.position, {
      status: 'error',
      message: 'No pudimos cargar la posicion financiera actual.',
    });
  } finally {
    console.warn = originalWarn;
  }
});
