import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('transfer creation is one authenticated command with a required retry identity', () => {
  const source=readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('export async function createMoneyTransferAction('),source.indexOf('export async function approveMoneyMovementGroupAction('));
  assert.match(body,/requestId: string/);
  assert.match(body,/executeMoneyTransfer\(input\)/);
  const command=readFileSync(new URL('../../src/lib/finance/money-transfer-command.ts',import.meta.url),'utf8');
  assert.match(command,/requireAdminContext\(\)/);
  assert.match(command,/create_money_transfer_v1/);
  assert.match(command,/parseMoneyTransferReceipt/);
  assert.doesNotMatch(command,/service.role|\.insert\(/i);
  assert.doesNotMatch(body,/\.insert\(|crypto.randomUUID/);
});
test('the form keeps its transfer identity on errors and prevents concurrent submissions', () => {
  const source=readFileSync(new URL('../../src/app/app/master/dashboard/MasterDashboardClient.tsx',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('const handleCreateMoneyTransfer ='),source.indexOf('const handleApproveSelectedMovementGroup ='));
  assert.match(body,/if \(transferBusyRef.current\) return/);
  assert.match(body,/transferRequestIdRef.current \?\?= crypto.randomUUID\(\)/);
  const failure=body.slice(body.indexOf('} catch'));
  assert.doesNotMatch(failure,/resetMoneyTransferForm|transferRequestIdRef.current = null/);
});
