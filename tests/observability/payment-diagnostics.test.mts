import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { observeServerOperation } from '../../src/lib/observability/server-operation.ts';
import { buildPaymentConfirmationCommand, readPaymentConfirmationReceipt } from '../../src/lib/domain/payment-confirmation-command.ts';

const input = { reportId: 8, orderId: 2, confirmedMoneyAccountId: 3,
  confirmedCurrency: 'USD', confirmedAmount: 12, movementDate: '2026-11-25' };

// Execute the published handler body with only its network, notification and
// invalidation boundaries replaced. No real account or payment is contacted.
function fixture(options: { rpcError?: boolean; unauthorized?: boolean; replayed?: boolean } = {}) {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function confirmPaymentReportAction('),
    source.indexOf('export async function applyStaffPayrollPaymentAction('));
  const code = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: Array<{ name: string; params: unknown }> = [];
  let notifications = 0, invalidations = 0;
  const supabase = { async rpc(name: string, params: unknown) {
    calls.push({ name, params });
    return options.rpcError
      ? { data: null, error: { code: 'P0001', message: 'canonical rejection' } }
      : { data: { orderId: 2, eventId: 4, movementId: 5, payload: {}, replayed: options.replayed ?? false }, error: null };
  } };
  const module = { exports: {} as { confirmPaymentReportAction: (value: unknown) => Promise<void> } };
  new Function('module', 'exports', 'requirePaymentReportOperator', 'observeServerOperation',
    'buildPaymentConfirmationCommand', 'readPaymentConfirmationReceipt', 'loadOrderEventContext',
    'appendOrderEvent', 'revalidateMasterDashboardFinancialReferences', code)(
    module, module.exports,
    async () => {
      if (options.unauthorized) throw new Error('No autorizado.');
      return { supabase, user: { id: 'test-user' } };
    },
    observeServerOperation, buildPaymentConfirmationCommand, readPaymentConfirmationReceipt,
    async () => ({ advisorUserId: 'test-advisor' }),
    async (_client: unknown, event: { persistedEventId: number }) => {
      assert.equal(event.persistedEventId, 4); notifications++;
    },
    () => { invalidations++; },
  );
  return { run: () => module.exports.confirmPaymentReportAction(input), calls,
    notifications: () => notifications, invalidations: () => invalidations };
}

test('payment instrumentation preserves the canonical payload, receipt event, and single execution', async (t) => {
  t.mock.method(console, 'info', () => {});
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls, [{ name: 'confirm_payment_report_atomic_v1', params: { p_input: buildPaymentConfirmationCommand(input) } }]);
  assert.equal(f.notifications(), 1);
  assert.equal(f.invalidations(), 1);
});

test('canonical payment rejection is reported without retrying or emitting a confirmation', async (t) => {
  const records: string[] = [];
  t.mock.method(console, 'error', (record: string) => records.push(record));
  const f = fixture({ rpcError: true });
  await assert.rejects(f.run(), /canonical rejection/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.notifications(), 0);
  assert.equal(f.invalidations(), 0);
  assert.equal(JSON.parse(records[0]).errorCode, 'P0001');
});

test('replayed payments and failed logging do not repeat ledger commands or device notifications', async (t) => {
  t.mock.method(console, 'info', () => { throw new Error('logging unavailable'); });
  const f = fixture({ replayed: true });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.notifications(), 0);
  assert.equal(f.invalidations(), 1);
});

test('authorization still precedes the financial command and diagnostics', async (t) => {
  const log = t.mock.method(console, 'info', () => {});
  const f = fixture({ unauthorized: true });
  await assert.rejects(f.run(), /No autorizado/);
  assert.deepEqual(f.calls, []);
  assert.equal(log.mock.callCount(), 0);
});
