import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('closure and reversal use session-authorized atomic commands', () => {
  const s=readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts',import.meta.url),'utf8');
  const create=s.slice(s.indexOf('export async function createMoneyAccountClosureAction('),s.indexOf('export async function previewMoneyAccountClosureAction('));
  const cancel=s.slice(s.indexOf('export async function rejectMoneyAccountClosureAction('),s.indexOf('export async function createMoneyAccountBaselineAction('));
  assert.match(create,/create_account_closure_v1/);
  assert.match(cancel,/void_account_closure_v1/);
  assert.doesNotMatch(create+cancel,/\.insert\(|\.update\(|createSupabaseServiceRole/);
});
test('closure submission retains retry identity on errors and blocks duplicate clicks', () => {
  const s=readFileSync(new URL('../../src/app/app/master/dashboard/MasterDashboardClient.tsx',import.meta.url),'utf8');
  const b=s.slice(s.indexOf('const handleCreateMoneyAccountClosure ='),s.indexOf('const handleRejectMoneyAccountClosure ='));
  assert.match(b,/closureBusyRef.current/);
  assert.match(b,/closureRequestIdRef.current \?\?= crypto.randomUUID/);
  assert.doesNotMatch(b.slice(b.indexOf('} catch')),/resetClosureForm|closureRequestIdRef.current = null/);
});
