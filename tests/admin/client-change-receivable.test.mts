import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPaymentConfirmationCommand, type PaymentConfirmationInput } from '../../src/lib/domain/payment-confirmation-command.ts';

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const actions = read('src/app/app/master/dashboard/actions.ts');
const ops = read('src/app/app/master/ops/actions.ts');
const ui = read('src/app/app/master/dashboard/MasterDashboardClient.tsx');
const opsUi = read('src/app/app/master/ops/MasterOpsClient.tsx');

test('fund payouts use one session-authorized transaction with a stable request and explicit difference', () => {
  const body = actions.slice(actions.indexOf('export async function settleClientFundPayoutAction'), actions.indexOf('export async function rejectPaymentReportAction'));
  assert.match(body, /requireMasterOrAdmin\(/);
  assert.match(body, /settle_client_fund_payout_v1/);
  assert.match(body, /p_request_id: input.requestId/);
  assert.match(body, /expectedDifferenceUsd: input.expectedDifferenceUsd \?\? 0/);
  assert.doesNotMatch(body, /\.insert\(|\.update\(|randomUUID|createSupabaseServiceRole/);
});

test('Ops and legacy single-line action cannot bypass the payout command', () => {
  const body = ops.slice(ops.indexOf('export async function settleMasterOpsClientFundPayoutAction'), ops.indexOf('export async function closeMasterOpsRoundingBalanceAction'));
  assert.match(body, /settleClientFundPayoutAction\(input\)/);
  const legacy = actions.slice(actions.indexOf('export async function deliverClientFundChangeAction'), actions.indexOf('export async function settleClientFundPayoutAction'));
  assert.match(legacy, /settleClientFundPayoutAction\(/);
  assert.doesNotMatch(legacy, /\.insert\(|\.update\(/);
});

test('both payout forms guard double clicks and show the receivable before confirmation', () => {
  for (const source of [ui, opsUi]) {
    assert.match(source, /fundPayoutBusyRef\.current\) return/);
    assert.match(source, /fundPayoutRequestRef\.current \?\?= crypto\.randomUUID/);
    assert.match(source, /expectedDifferenceUsd:/);
    assert.match(source, /diferencia por cobrar/);
  }
  assert.doesNotMatch(opsUi, /disabled=\{busy \|\| fundPayoutTotalUsd <= 0\.005 \|\| fundPayoutExceedsAvailable\}/);
});

test('rounding uses the same canonical debt as collections instead of all raw outflows', () => {
  const body = actions.slice(actions.indexOf('export async function closeOrderRoundingBalanceAction'), actions.indexOf('export async function closeOrderRoundingBalanceAction') + 8500);
  assert.match(body, /rpc\('get_order_financial_state'/);
  assert.match(body, /roundMoney\(financial.pending_usd\)/);
});

test('explicit change debt is preserved exactly and absent legacy consent remains absent', () => {
  const input: PaymentConfirmationInput = { reportId: 1, confirmedMoneyAccountId: 2, confirmedCurrency: 'USD', confirmedAmount: 14.73,
    movementDate: '2026-09-11', confirmedExchangeRateVesPerUsd: null, reviewNotes: '', referenceCode: null, counterpartyName: null, description: null };
  assert.equal('expectedChangeDebtUsd' in buildPaymentConfirmationCommand(input), false);
  const command = buildPaymentConfirmationCommand({ ...input, expectedChangeDebtUsd: 0.27 });
  assert.equal(command.expectedChangeDebtUsd, 0.27);
  assert.deepEqual(command, buildPaymentConfirmationCommand({ ...input, expectedChangeDebtUsd: 0.27 }));
});
