import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

type Context = { parentURL?: string };
type Resolved = { url: string; shortCircuit?: boolean };
type Next = (s: string, c: Context) => Resolved;
const register = Reflect.get(await import('node:module'), 'registerHooks') as (hooks: { resolve: (s: string, c: Context, next: Next) => Resolved }) => void;
register({ resolve(s, c, next) {
  if (s === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
  if (c.parentURL?.includes('/admin-finance/') && ['./collections-model', './period'].includes(s)) return next(`${s}.ts`, c);
  return next(s, c);
} });
const { normalizeCollectionFilters, collectionHref, collectionPeriod, parseCollectionsOverview, collectionQueryRequested } = await import('../../src/lib/admin-finance/collections-model.ts');
const { loadCollections } = await import('../../src/lib/admin-finance/collections-data.ts');
const now = new Date('2026-09-28T16:00:00Z');
const person = '8c296814-8b98-48d4-8db1-ce27b4c808eb';
function payload() {
  return {
    version: 'admin-collections-v1', asOf: now.toISOString(), balanceSource: 'canonical_order_financial_state', cutoffMode: 'current_statement', page: 1, pages: 1, pageSize: 30,
    totals: { orders: 1, totalUsd: 29.78, coveredUsd: 29.78, pendingUsd: 0, reviewUsd: 0, reviewCount: 0 },
    people: [{ id: person, name: 'Administrador' }],
    orders: [{ id: 2784, clientName: 'Cliente', clientPhone: null, creatorId: person, creatorName: 'Administrador', advisorId: null, advisorName: null,
      createdDate: '2026-09-21', deliveredDate: '2026-09-21', source: 'master', fulfillment: 'pickup', stage: 'delivered', totalUsd: 29.78, coveredUsd: 29.78, pendingUsd: 0, reviewUsd: 0, reviewCount: 0, paymentStatus: 'paid' }],
  };
}
test('defaults to a period selection, with no implicit historical query', () => {
  const f = normalizeCollectionFilters({});
  assert.equal(f.from, ''); assert.equal(f.to, ''); assert.equal(f.status, 'pending');
  assert.equal(f.source, 'all'); assert.equal(f.personBasis, 'either'); assert.equal(f.role, 'all');
  assert.equal(f.scope, 'period'); assert.equal(collectionQueryRequested({}), false);
  assert.equal(collectionQueryRequested({ action: 'people' }), false);
  assert.equal(collectionQueryRequested({ from: '2026-09-07', to: '2026-09-13' }), false);
  assert.equal(collectionQueryRequested({ action: 'query' }), true);
});
test('strict inclusive dates reject impossible and reversed dates without silently widening the query', () => {
  for (const params of [{ from: '2026-02-30' }, { to: 'yesterday' }, { from: '2026-09-28', to: '2026-09-21' }]) assert.throws(() => normalizeCollectionFilters(params));
  assert.equal(normalizeCollectionFilters({ from: '2024-02-29', to: '2024-02-29' }).to, '2024-02-29');
});
test('links preserve role, seller, fulfillment, dates and search when changing pages', () => {
  const f = normalizeCollectionFilters({ from: '2026-09-07', to: '2026-09-13', person, role: 'admin', source: 'master', fulfillment: 'pickup', q: '27-8-4', personBasis: 'creator', basis: 'delivered', status: 'all' });
  const params = Object.fromEntries(new URL(collectionHref(f, { page: 2 }), 'https://example.test').searchParams);
  assert.deepEqual(normalizeCollectionFilters(params), { ...f, page: 2 });
});
test('Caracas presets use Monday weeks and include the current day', () => {
  assert.deepEqual(collectionPeriod('week', new Date('2026-09-28T02:00:00Z')), { from: '2026-09-21', to: '2026-09-27', page: 1 });
  assert.deepEqual(collectionPeriod('all', now), { from: '', to: '', page: 1 });
});
test('canonical debt is not reconstructed from rounded total minus covered', () => {
  const p = payload(); p.orders[0].totalUsd = 49.04; p.orders[0].coveredUsd = 6.04; p.orders[0].pendingUsd = 42.93998903163324;
  const result = parseCollectionsOverview(p, now);
  assert.equal(result.orders[0].pendingUsd, 42.93998903163324);
  assert.equal(parseCollectionsOverview(payload(), now).orders[0].pendingUsd, 0);
});
test('unverified reports remain separate from confirmed coverage and outstanding', () => {
  const p = payload(); Object.assign(p.orders[0], { coveredUsd: 10, pendingUsd: 19.78, reviewUsd: 19.78, reviewCount: 1, paymentStatus: 'pending_review' });
  const result = parseCollectionsOverview(p, now).orders[0];
  assert.equal(result.pendingUsd, 19.78); assert.equal(result.coveredUsd, 10); assert.equal(result.reviewUsd, 19.78);
});
test('missing, nonfinite, stale or truncated financial responses fail closed', () => {
  const mutations = [
    (p: Record<string, unknown>) => { p.asOf = '2026-09-28T12:00:00Z'; },
    (p: Record<string, unknown>) => { p.balanceSource = 'commission_snapshot'; },
    (p: Record<string, unknown>) => { p.orders = []; },
    (p: Record<string, unknown>) => { p.page = 0; },
    (p: Record<string, unknown>) => { p.totals = { ...payload().totals, pendingUsd: null }; },
    (p: Record<string, unknown>) => { p.totals = { ...payload().totals, coveredUsd: 'NaN' }; },
  ];
  for (const mutate of mutations) { const p = payload(); mutate(p); assert.throws(() => parseCollectionsOverview(p, now)); }
});
test('loader forwards all filters only to the admin RPC and never returns fake zeros on errors', async () => {
  const filters = normalizeCollectionFilters({ status: 'all', person, role: 'admin', from: '2026-09-07', to: '2026-09-13' });
  const calls: unknown[] = [];
  const result = await loadCollections({ async rpc(name, params) { calls.push({ name, params }); return { data: payload(), error: null }; } }, filters, now, true);
  assert.equal(result.status, 'ready'); assert.deepEqual(calls, [{ name: 'admin_collections_read_v1', params: { p_filters: filters } }]);
  const error = await loadCollections({ async rpc() { return { data: null, error: { message: 'denied' } }; } }, filters, now, true);
  assert.equal(error.status, 'error'); assert.equal('data' in error, false);
});
test('SQL is admin-only and read-only; pagination follows canonical filtering', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260928192947_admin_collections_read_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /r\.role='admin'/); assert.match(sql, /v_uid is null/); assert.match(sql, /security invoker set search_path = ''/);
  assert.match(sql, /from public,anon,authenticated,service_role/);
  assert.doesNotMatch(sql, /\b(insert into|update public\.|delete from)\b/i);
  assert.ok(sql.indexOf('financial as materialized') < sql.indexOf('page_rows as'));
  assert.match(sql, /public\.get_order_financial_state\(c\.id,v_today,null\)/);
  assert.match(sql, /case when c.stage='cancelled' then 0 else f.pending_usd end/);
});
test('UI uses short order IDs, contact links, protected data and no commission snapshot', () => {
  const ui = readFileSync(new URL('../../src/app/app/admin/finanzas/cobranzas/_components/CollectionsOverview.tsx', import.meta.url), 'utf8');
  assert.match(ui, /#\{o.id\}/); assert.doesNotMatch(ui, /orderNumber|order_number/);
  assert.match(ui, /normalizePhone\(order.clientPhone\)/); assert.match(ui, /rel="noopener noreferrer"/);
  const refresh = readFileSync(new URL('../../src/app/app/admin/finanzas/cobranzas/_components/CollectionRefresh.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(refresh, /useEffect|setInterval|visibilitychange|addEventListener/);
  assert.match(refresh, /onClick=.*router.refresh/);
});

test('opening the center or incomplete dates cannot execute a financial read', async () => {
  let calls = 0;
  const client = { async rpc() { calls++; return { data: payload(), error: null }; } };
  for (const params of [{}, { from: '2026-09-07', to: '2026-09-13' }, { scope: 'history' }]) {
    assert.equal((await loadCollections(client, normalizeCollectionFilters(params), now)).status, 'idle');
  }
  for (const params of [{}, { from: '2026-09-07' }, { to: '2026-09-13' }]) {
    assert.equal((await loadCollections(client, normalizeCollectionFilters(params), now, true)).status, 'error');
  }
  assert.equal(calls, 0);
  assert.equal((await loadCollections(client, normalizeCollectionFilters({ scope: 'history' }), now, true)).status, 'ready');
  assert.equal(calls, 1);
});

test('preset buttons only edit local fields, and financial query links disable prefetch', () => {
  const form = readFileSync(new URL('../../src/app/app/admin/finanzas/cobranzas/_components/CollectionFiltersForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /prefetch=\{false\}/);
  assert.match(form, /type="button" onClick/);
  assert.match(form, /setFrom\(period.from\); setTo\(period.to\)/);
  assert.match(form, /name="action" value="query"/);
  assert.doesNotMatch(form, /useEffect|router\.push|router\.refresh|setInterval/);
  assert.match(form, /disabled=\{people.length === 0 && !filters.person\}/);
  assert.match(form, /selectedPersonMissing && <option value=\{filters.person\}/);
  const url = new URL(collectionHref(normalizeCollectionFilters({ from: '2026-09-07', to: '2026-09-13' }), { page: 2 }), 'https://example.test');
  assert.equal(url.searchParams.get('action'), 'query');
  assert.equal(url.searchParams.get('from'), '2026-09-07');
});
