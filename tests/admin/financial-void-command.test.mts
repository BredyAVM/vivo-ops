import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('both financial void buttons reach the same transactional command without service-role writes', () => {
  const src=readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts',import.meta.url),'utf8');
  const body=src.slice(src.indexOf('export async function voidMoneyMovementGroupAction('),src.indexOf('export async function createMoneyAccountClosureAction('));
  assert.match(body,/await voidFinancialMovementAction\(input\)/);
  assert.match(body,/void_financial_movement_v1/);
  assert.match(body,/requireAdminRole/);
  assert.doesNotMatch(body,/createSupabaseServiceRole|\.update\(|\.insert\(/);
});
