import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPaymentConfirmationCommand, readPaymentConfirmationReceipt, type PaymentConfirmationInput } from '../../src/lib/domain/payment-confirmation-command.ts';

const input: PaymentConfirmationInput = { reportId: 8, orderId: 2, confirmedMoneyAccountId: 3,
  confirmedCurrency: ' usd ', confirmedAmount: 12, movementDate: '2026-09-01',
  confirmedExchangeRateVesPerUsd: 99, reviewNotes: '', referenceCode: ' X ', counterpartyName: null, description: null };

test('confirmation payload is deterministic and does not obtain a new retry identity or current date', () => {
  assert.deepEqual(buildPaymentConfirmationCommand(input), buildPaymentConfirmationCommand(input));
  const command = buildPaymentConfirmationCommand(input);
  assert.equal(command.rate, null);
  assert.equal(command.reference, 'X');
  assert.equal(command.date, '2026-09-01');
  assert.equal(command.reportId, 8);
});
test('legacy single-change inputs still reach the atomic command', () => {
  const command = buildPaymentConfirmationCommand({ ...input, overpaymentHandling: 'change_given',
    changeMoneyAccountId: 9, changeCurrency: 'VES', changeExchangeRateVesPerUsd: 100 });
  assert.deepEqual(command.changeLines, [{ accountId: 9, currency: 'VES', amount: null, rate: 100, notes: null }]);
});
test('no invalid change line is silently dropped', () => {
  const command = buildPaymentConfirmationCommand({ ...input, overpaymentHandling: 'change_given',
    changeLines: [{ moneyAccountId: 0, currencyCode: 'USD', amount: -1 }] });
  assert.equal(command.changeLines.length, 1);
  assert.equal(command.changeLines[0].amount, -1);
});
test('receipt requires positive safe IDs and a structured event payload', () => {
  assert.equal(readPaymentConfirmationReceipt({ orderId: 1, eventId: 2, movementId: 3, payload: {}, replayed: true }).replayed, true);
  for (const value of [null, [], {}, { orderId: 1, eventId: 0, movementId: 2, payload: {} },
    { orderId: 1, eventId: 2, movementId: 3, payload: [] }]) assert.throws(() => readPaymentConfirmationReceipt(value));
});
test('Master confirmation delegates the entire financial write and reuses its committed event', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function confirmPaymentReportAction('), source.indexOf('export async function applyStaffPayrollPaymentAction('));
  assert.match(body, /confirm_payment_report_atomic_v1/);
  assert.match(body, /persistedEventId: receipt.eventId/);
  assert.doesNotMatch(body, /\.insert\(|\.update\(|createSupabaseServiceRole/);
});
test('Ops date changes and balance decisions are inside the same command', () => {
  const source = readFileSync(new URL('../../src/app/app/master/ops/actions.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function confirmMasterOpsPaymentReportAction('), source.indexOf('export type MasterOpsMoneyLineInput'));
  assert.match(body, /overrideOperationDate: true/);
  assert.match(body, /requireExactChange: true/);
  assert.doesNotMatch(body, /\.update\(/);
});
