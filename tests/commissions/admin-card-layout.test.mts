import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/app/commissions/page.tsx', import.meta.url), 'utf8');
const classFor = (testId: string) => source.match(new RegExp(`data-testid="${testId}" className="([^"]+)"`))?.[1] ?? '';

test('advisor closures always form one full-width vertical list', () => {
  assert.match(classFor('commission-advisor-list'), /flex flex-col/);
  assert.doesNotMatch(classFor('commission-advisor-list'), /grid-cols|overflow-y|h-screen|max-h-/);
  assert.match(classFor('commission-advisor-card'), /min-w-0/);
  assert.doesNotMatch(classFor('commission-advisor-card'), /overflow-y|h-screen|max-h-/);
});

test('header can wrap naturally and amounts compact only on wide screens', () => {
  assert.match(classFor('commission-advisor-header'), /space-y-2/);
  assert.match(classFor('commission-advisor-amounts'), /grid-cols-2/);
  assert.match(classFor('commission-advisor-amounts'), /sm:grid-cols-3/);
  assert.match(classFor('commission-advisor-amounts'), /xl:grid-cols-6/);
  assert.match(source, /whitespace-nowrap rounded-full[^\n]+\n\s+href=\{adminCommissionAuditHref\(row.closure.id, 'settlement'\)\}/);
});

test('layout preserves all audit destinations, percentage protection and live balances', () => {
  for (const section of ['billing', 'commission', 'deductions', 'debts', 'settlement', 'payments']) {
    assert.ok(source.includes(`adminCommissionAuditHref(row.closure.id, '${section}')`));
  }
  assert.ok(source.includes("locked={row.closure.status !== 'preliminary' || selectedPeriod?.status !== 'open'}"));
  assert.ok(source.includes('money(row.paymentBalanceUsd)'));
  assert.ok(source.includes('row.live?.supported ? row.live.customerDebtUsd : row.closure.pending_collection_usd'));
});
