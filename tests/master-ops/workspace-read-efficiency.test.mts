import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { readWorkspaceOrderPeriods } from '../../src/lib/orders/workspace-order-periods.ts';

const require = createRequire(import.meta.url);
type Row = { id: number; created_at: string; extra_fields: { schedule?: { date?: unknown } } | null };
const dayRange = { startISO: '2026-10-28T04:00:00.000Z', endISO: '2026-10-29T04:00:00.000Z' };
const weekRange = { startKey: '2026-10-26', endExclusiveKey: '2026-11-02',
  startISO: '2026-10-26T04:00:00.000Z', endISO: '2026-11-02T04:00:00.000Z' };

function database(rows: Row[], options: { cap?: number; countMissing?: boolean; fail?: string } = {}) {
  const calls: string[] = [];
  const client = { from() {
    const filters: Array<[string, string, string]> = [];
    let limit = 900, exact = false;
    const query = {
      select(_fields: string, config?: { count: string }) { exact = config?.count === 'exact'; return query; },
      eq(field: string, value: string) { filters.push(['eq', field, value]); return query; },
      gte(field: string, value: string) { filters.push(['gte', field, value]); return query; },
      lt(field: string, value: string) { filters.push(['lt', field, value]); return query; },
      order() { return query; }, limit(value: number) { limit = value; return query; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        const scheduled = filters[0][1] !== 'created_at';
        const name = `${scheduled ? 'scheduled' : 'created'}-${limit === 500 ? 'day' : 'week'}`;
        calls.push(name);
        const selected = rows.filter(row => filters.every(([op, field, value]) => {
          const raw = field === 'created_at' ? row.created_at : row.extra_fields?.schedule?.date;
          if (raw == null) return false;
          const a = field === 'created_at' ? Date.parse(String(raw)) : String(raw);
          const b = field === 'created_at' ? Date.parse(value) : value;
          return op === 'eq' ? a === b : op === 'gte' ? a >= b : a < b;
        })).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        return Promise.resolve({ data: name === options.fail ? null : selected.slice(0, Math.min(limit, options.cap ?? 1000)),
          count: exact && !options.countMissing ? selected.length : null,
          error: name === options.fail ? { message: name + ' failed' } : null }).then(resolve, reject);
      },
    };
    return query;
  } };
  return { client: client as never, calls };
}
const input = (supabase: never, reuseWeekRows = true) => ({ supabase, orderSelect: '*',
  focusDate: '2026-10-28', dayRange, weekRange, reuseWeekRows });
const row = (id: number, created_at: string, date?: string): Row => ({ id, created_at,
  extra_fields: date === undefined ? null : { schedule: { date } } });

test('complete week responses produce exactly the old daily rows using two reads', async () => {
  const rows = [row(1, '2026-10-28T03:59:59Z'), row(2, '2026-10-28T00:00:00-04:00'),
    row(3, '2026-10-29T03:59:59Z'), row(4, '2026-10-29T04:00:00Z'),
    row(5, '2026-10-26T10:00:00Z', '2026-10-28'),
    row(6, '2026-10-28T10:00:00Z', '2026-10-28 '),
    row(7, '2026-10-28T10:00:00Z', ' 2026-10-28')];
  const before = database(rows), after = database(rows);
  const baseline = await readWorkspaceOrderPeriods<Row>(input(before.client, false));
  const current = await readWorkspaceOrderPeriods<Row>(input(after.client));
  assert.deepEqual(current.scheduledDayResult.data, baseline.scheduledDayResult.data);
  assert.deepEqual(current.createdDayResult.data, baseline.createdDayResult.data);
  assert.deepEqual(current.scheduledWeekResult.data, baseline.scheduledWeekResult.data);
  assert.deepEqual(current.createdWeekResult.data, baseline.createdWeekResult.data);
  assert.deepEqual(after.calls.sort(), ['created-week', 'scheduled-week']);
});

test('a lower PostgREST cap cannot silently lose daily orders', async () => {
  const rows = [row(1, '2026-10-28T12:00:00Z', '2026-10-28'),
    row(2, '2026-10-30T12:00:00Z', '2026-10-30')];
  const db = database(rows, { cap: 1 });
  const result = await readWorkspaceOrderPeriods<Row>(input(db.client));
  assert.equal(result.scheduledDayResult.data?.[0].id, 1);
  assert.equal(result.createdDayResult.data?.[0].id, 1);
  assert.equal(db.calls.length, 4);
});

test('only the incomplete weekly result needs its daily fallback', async () => {
  const rows = [row(1, '2026-10-28T12:00:00Z', '2026-10-28'), row(2, '2026-10-30T12:00:00Z')];
  const db = database(rows, { cap: 1 });
  await readWorkspaceOrderPeriods<Row>(input(db.client));
  assert.deepEqual(db.calls.sort(), ['created-day', 'created-week', 'scheduled-week']);
});

test('missing exact counts use the original reads rather than guessing completeness', async () => {
  const db = database([row(1, '2026-10-28T12:00:00Z')], { countMissing: true });
  await readWorkspaceOrderPeriods<Row>(input(db.client));
  assert.equal(db.calls.length, 4);
});

test('weekly failures and fallback failures are preserved for the loader', async () => {
  const rows = [row(1, '2026-10-28T12:00:00Z')];
  const weekly = database(rows, { fail: 'created-week' });
  assert.equal((await readWorkspaceOrderPeriods<Row>(input(weekly.client))).createdWeekResult.error?.message, 'created-week failed');
  const daily = database(rows, { countMissing: true, fail: 'created-day' });
  assert.equal((await readWorkspaceOrderPeriods<Row>(input(daily.client))).createdDayResult.error?.message, 'created-day failed');
});

test('the 500-row daily limit is preserved even when a complete week has more daily rows', async () => {
  const rows = Array.from({ length: 700 }, (_, i) => row(i, '2026-10-28T12:00:00Z', '2026-10-28'));
  const db = database(rows);
  const result = await readWorkspaceOrderPeriods<Row>(input(db.client));
  assert.equal(result.scheduledDayResult.data?.length, 500);
  assert.equal(result.createdDayResult.data?.length, 500);
  assert.equal(result.scheduledWeekResult.data?.length, 700);
  assert.equal(db.calls.length, 2);
});

test('a day outside the weekly range retains both original daily reads', async () => {
  const db = database([]);
  await readWorkspaceOrderPeriods<Row>({ ...input(db.client), focusDate: '2026-11-03',
    dayRange: { startISO: '2026-11-03T04:00:00Z', endISO: '2026-11-04T04:00:00Z' } });
  assert.equal(db.calls.length, 4);
});

test('representative, capped and boundary datasets match all four original result sets', async () => {
  for (const size of [0, 1, 10, 499, 500, 501, 899, 900, 901, 1100]) {
    const rows = Array.from({ length: size }, (_, i) => row(i,
      new Date(Date.parse('2026-10-25T12:00:00Z') + (i % 9) * 86400000 + i * 1000).toISOString(),
      i % 3 ? undefined : `2026-10-${String(26 + (i % 6)).padStart(2, '0')}`));
    for (const cap of [20, 1000]) {
      const before = database(rows, { cap }), after = database(rows, { cap });
      const baseline = await readWorkspaceOrderPeriods<Row>(input(before.client, false));
      const current = await readWorkspaceOrderPeriods<Row>(input(after.client));
      for (const key of ['scheduledDayResult', 'createdDayResult', 'scheduledWeekResult', 'createdWeekResult'] as const) {
        assert.deepEqual(current[key].data, baseline[key].data, `${key}: size=${size}, cap=${cap}`);
      }
    }
  }
});

function load(relative: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL('../../' + relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name in imports) return imports[name];
    return require(name);
  }, module, module.exports);
  return module.exports;
}
const inventoryModule = load('src/lib/orders/workspace-inventory-summary.ts', {
  'server-only': {}, '@/lib/auth': { isMasterOrAdminRole: (roles: string[]) => roles.includes('master') || roles.includes('admin') },
});
const readInventory = inventoryModule.readWorkspaceInventorySummary as (...args: unknown[]) => Promise<{ ok: boolean; summary?: Record<string, unknown> }>;

function inventoryDb(roles: string[], errors = [false, false]) {
  let reads = 0;
  const signals: AbortSignal[] = [];
  const query = (value: unknown) => {
    const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
      abortSignal(signal: AbortSignal) { signals.push(signal); return q; },
      then(resolve: (value: unknown) => unknown) { reads++; return Promise.resolve(value).then(resolve); } };
    return q;
  };
  return { ctx: { roles, supabase: {
    rpc: () => query({ data: { summary: { active: '9', open: 7, managed: 2, critical: 1, requires_action: 3 } }, error: errors[0] ? {} : null }),
    from: () => query({ data: [{ id: 42 }], count: 2, error: errors[1] ? {} : null }),
  } }, reads: () => reads, signals };
}

test('inventory authorization rejects operationally unrelated roles before any reads', async () => {
  assert.equal((await readInventory(null)).ok, false);
  for (const roles of [[], ['advisor'], ['kitchen'], ['counter']]) {
    const db = inventoryDb(roles);
    assert.equal((await readInventory(db.ctx)).ok, false);
    assert.equal(db.reads(), 0);
  }
});

test('inventory uses the supplied Master/Admin context and preserves the existing counter mapping', async () => {
  for (const role of ['master', 'admin']) {
    const db = inventoryDb([role]);
    const result = await readInventory(db.ctx);
    assert.equal(db.reads(), 2);
    assert.deepEqual(result.summary, { active: 9, open: 7, managed: 2, critical: 1,
      requiresAction: 3, pendingReviews: 2, nextPendingReviewId: 42 });
  }
});

test('inventory failures stay optional and the timeout applies to both upstream reads', async () => {
  const db = inventoryDb(['master'], [true, true]);
  const signal = AbortSignal.timeout(2000);
  assert.equal((await readInventory(db.ctx, signal)).ok, false);
  assert.deepEqual(db.signals, [signal, signal]);
});

test('a pending inventory response is inside its own Suspense boundary, not awaited by the order loader', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(r => { resolve = r; });
  const Link = () => null;
  const navigation = load('src/lib/orders/workspace-inventory-navigation.tsx', {
    'server-only': {}, '@/components/orders/OrdersWorkspaceInventoryLinks': { default: Link },
    './workspace-inventory-summary': { readWorkspaceInventorySummary: () => pending },
  });
  const element = navigation.createWorkspaceInventoryNavigation({}) as {
    type: unknown; props: { fallback: { props: { summary: unknown } }; children: { type: (p: unknown) => Promise<{ props: { summary: unknown } }>; props: unknown } };
  };
  assert.equal(element.type, Symbol.for('react.suspense'));
  assert.equal(element.props.fallback.props.summary, null);
  resolve({ ok: true, summary: { active: 9 } });
  assert.deepEqual((await element.props.children.type(element.props.children.props)).props.summary, { active: 9 });
});

test('inventory links retain the last successful counts after a failed streamed read', () => {
  let saved: unknown;
  const module = load('src/components/orders/OrdersWorkspaceInventoryLinks.tsx', {
    react: { useState: (initial: unknown) => { saved ??= initial; return [saved, (next: unknown) => { saved = next; }]; } },
    '@/components/navigation/ContextLink': { default: () => null },
    '@/lib/orders/workspace-navigation': { ordersWorkspaceNavigation: () => ({ inventory: '/inventory' }) },
  });
  const render = (summary: unknown) => module.default({ summary }) as { props: { children: Array<{ props: { title: string } }> } };
  assert.match(render({ active: 9, critical: 1, pendingReviews: 0 }).props.children[0].props.title, /9 alertas/);
  assert.match(render({ active: 12, critical: 1, pendingReviews: 0 }).props.children[0].props.title, /12 alertas/);
  assert.match(render(null).props.children[0].props.title, /12 alertas/);
});
