import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
  if (context.parentURL?.includes('/admin-finance/') && (specifier === './commissions-model' || specifier === './period')) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { parseCommissionsOverview, commissionPeriodView, normalizeCommissionFilters } = await import('../../src/lib/admin-finance/commissions-model.ts');
const { loadCommissionsOverview } = await import('../../src/lib/admin-finance/commissions-data.ts');
const now = new Date('2026-09-10T16:00:00Z');
const filters = normalizeCommissionFilters({});
function closure(patch: Record<string, unknown> = {}) {
  return { id: 1, period_id: 1, advisor_user_id: 'advisor', advisor_name: 'Asesor', eligible_now: true,
    status: 'closed', gross_commission_usd: 100, payable_usd: 70, gift_deductions_usd: 10,
    manual_deductions_usd: 0, pending_collection_usd: 20, generated_at: now.toISOString(), closed_at: now.toISOString(), paid_at: null,
    snapshot: { version: 2, totals: { grossCommissionUsd: 100, payableUsd: 70 },
      settlement: { formulaVersion: 'advisor-settlement-v1', retainedCommissionUsd: 20, calculationCutoffAt: now.toISOString() },
      commissionWorkflow: { conformity: { status: 'confirmed', confirmedAt: now.toISOString(), recordedByUserId: 'admin' } } }, ...patch };
}
function payload(closures = [closure()], payments: Record<string, unknown>[] = []) {
  return { definitionVersion: 'admin-finance-commissions-v1', asOf: now.toISOString(), paymentLinkBasis: 'legacy_description',
    periodCount: 1, closureCount: closures.length, paymentCount: payments.length,
    periods: [{ id: 1, name: 'Septiembre', date_from: '2026-09-01', date_to: '2026-09-15', status: 'open' }],
    closures, payments, eligibleAdvisorIds: ['advisor'] };
}
function payment(patch: Record<string, unknown> = {}) {
  return { id: 3, description: 'Liquidación de comisión · Cierre 1 · Septiembre · Asesor', amount_usd_equivalent: 70, movement_date: '2026-09-10', ...patch };
}
test('loads one protected read with no recalculation, preserves snapshot amounts', async () => {
  const calls: unknown[] = [];
  const result = await loadCommissionsOverview({ asOf: now, supabase: { async rpc(name, params) { calls.push({ name, params }); return { data: payload(), error: null }; } } });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const summary = commissionPeriodView(result.data, filters).summary;
  assert.equal(summary.grossUsd, 100); assert.equal(summary.retainedUsd, 20); assert.equal(summary.conformedUsd, 70);
  assert.equal(summary.pendingUsd, null);
  assert.deepEqual(calls, [{ name: 'admin_finance_commissions_read_v1', params: {} }]);
});
test('preliminary payable is not conformed debt and a paid label is not proof of payment', () => {
  const prelim = commissionPeriodView(parseCommissionsOverview(payload([closure({ status: 'preliminary', closed_at: null })]), now), filters);
  assert.equal(prelim.summary.conformedUsd, 0); assert.equal(prelim.summary.pendingUsd, 0);
  const paid = parseCommissionsOverview(payload([closure({ status: 'paid' })]), now).rows[0];
  assert.equal(paid.pendingUsd, null);
  assert.ok(paid.issues.some(issue => issue.includes('sin abonos suficientes')));
});
test('even matching legacy payment references never certify a zero outstanding balance', () => {
  const result = parseCommissionsOverview(payload([closure({ status: 'paid' })], [payment()]), now);
  assert.equal(result.rows[0].referencedPaidUsd, 70);
  assert.equal(result.rows[0].pendingUsd, null);
  assert.equal(commissionPeriodView(result, filters).summary.pendingUsd, null);
  assert.ok(result.rows[0].issues.some(issue => issue.includes('solo por descripción')));
});
test('legacy retention uses existing carry rule, missing versioned retention is unavailable not zero', () => {
  const legacy = parseCommissionsOverview(payload([closure({ snapshot: { version: 1 } })]), now).rows[0];
  assert.equal(legacy.retainedUsd, 20); assert.equal(legacy.retainedBasis, 'legacy'); assert.equal(legacy.conformed, false);
  for (const snapshot of [{ version: 3 }, { version: 2, settlement: { formulaVersion: 'advisor-settlement-v1' } }]) {
    assert.equal(parseCommissionsOverview(payload([closure({ snapshot })]), now).rows[0].retainedUsd, null);
  }
});
test('snapshot-column disagreements and invalid conformity prevent certification', () => {
  const c = closure(); c.snapshot.totals.payableUsd = 69;
  const row = parseCommissionsOverview(payload([c]), now).rows[0];
  assert.equal(row.retainedUsd, null); assert.equal(row.conformed, false);
  assert.equal(commissionPeriodView(parseCommissionsOverview(payload([c]), now), filters).summary.conformedUsd, null);
});
test('one period at a time avoids double-counting carry, default never selects a future period over current', () => {
  const data = payload([closure(), closure({ id: 2, period_id: 2 })]);
  data.periods.push({ id: 2, name: 'Futuro', date_from: '2026-10-01', date_to: '2026-10-15', status: 'open' }); data.periodCount++;
  const overview = parseCommissionsOverview(data, now);
  assert.equal(commissionPeriodView(overview, filters).summary.retainedUsd, 20);
  assert.equal(commissionPeriodView(overview, filters).period?.id, 1);
  assert.equal(commissionPeriodView(overview, { ...filters, periodId: 999 }).period, null);
});
test('pre-period setup snapshots never publish false zero commissions for the current period', () => {
  const c = closure({ status: 'preliminary', generated_at: '2026-08-30T16:00:00Z', snapshot: { version: 1 }, gross_commission_usd: 0, payable_usd: 0 });
  const view = commissionPeriodView(parseCommissionsOverview(payload([c]), now), filters);
  assert.equal(view.summary.grossUsd, null); assert.equal(view.summary.retainedUsd, null);
  assert.equal(view.missingCurrentAdvisors, 1); assert.equal(view.rows[0].calculationBeforePeriod, true);
});
test('inactive preliminary excluded, inactive finalized preserved; missing current advisor calculation explicit', () => {
  const data = payload([closure({ eligible_now: false, status: 'preliminary' })]); data.eligibleAdvisorIds = ['another'];
  let view = commissionPeriodView(parseCommissionsOverview(data, now), filters);
  assert.equal(view.excluded, 1); assert.equal(view.summary.grossUsd, null); assert.equal(view.missingCurrentAdvisors, 1);
  data.closures[0].status = 'closed';
  view = commissionPeriodView(parseCommissionsOverview(data, now), filters);
  assert.equal(view.count, 1); assert.equal(view.summary.conformedUsd, 70);
});
test('unmatched payment descriptions and overpayments are explicit; bank-fee prefix does not reduce commission', () => {
  const overview = parseCommissionsOverview(payload([closure()], [payment({ amount_usd_equivalent: 80 }),
    payment({ id: 4, description: 'Comisión bancaria · Liquidación de comisión · Cierre 1' }),
    payment({ id: 5, description: 'Liquidación de comisión · Cierre 999 · Septiembre' })]), now);
  assert.equal(overview.unmatchedPayments, 2); assert.equal(overview.rows[0].referencedPaidUsd, 80);
  assert.ok(overview.rows[0].issues.some(issue => issue.includes('superiores')));
});
test('all filtered rows contribute before pagination; search and status agree with KPIs', () => {
  const data = payload(Array.from({ length: 35 }, (_, i) => closure({ id: i + 1, advisor_user_id: `a${i}` })));
  data.eligibleAdvisorIds = Array.from({ length: 35 }, (_, i) => `a${i}`);
  const view = commissionPeriodView(parseCommissionsOverview(data, now), { ...filters, page: 8, q: 'ASESOR', status: 'closed' });
  assert.equal(view.page, 2); assert.equal(view.rows.length, 5); assert.equal(view.summary.grossUsd, 3500);
});
test('rejects failed/truncated/duplicate/malformed reads and stale cutoff; never manufactures zero', async () => {
  for (const patch of [{ closureCount: 2 }, { asOf: '2026-09-09T12:00:00Z' }, { payments: null }, { periodCount: 9 }, { definitionVersion: 'bad' }]) {
    assert.throws(() => parseCommissionsOverview({ ...payload(), ...patch }, now));
  }
  for (const patch of [{ gross_commission_usd: null }, { payable_usd: ' ' }, { payable_usd: -1 }, { period_id: 999 }]) {
    assert.throws(() => parseCommissionsOverview(payload([closure(patch)]), now));
  }
  assert.throws(() => parseCommissionsOverview(payload([closure(), closure()]), now));
  assert.equal((await loadCommissionsOverview({ asOf: now, supabase: { async rpc() { return { data: null, error: { message: 'denied' } }; } } })).status, 'error');
});
test('new RPC is invoker/admin-only, preserves RLS, excludes pending/voided/fee payments and strips order arrays', () => {
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  const file = readdirSync(directory).find(name => name.endsWith('_admin_finance_commissions_read_v1.sql'));
  assert.ok(file);
  const sql = readFileSync(new URL(file, directory), 'utf8');
  assert.match(sql, /security invoker set search_path = ''/);
  assert.match(sql, /public\.get_advisor_profiles\(\)/);
  assert.match(sql, /v_uid is null or not exists/); assert.match(sql, /r\.role = 'admin'/);
  assert.match(sql, /from public, anon, authenticated, service_role/);
  assert.match(sql, /status = 'confirmed' and direction = 'outflow' and movement_type = 'expense_payment'/);
  assert.doesNotMatch(sql, /\b(?:insert into|update public|delete from|security definer)\b/i);
});
