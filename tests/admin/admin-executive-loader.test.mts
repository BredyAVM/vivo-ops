import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Context = { parentURL?: string };
type Resolved = { url: string; shortCircuit?: boolean };
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: {
  resolve: (specifier: string, context: Context, next: (specifier: string, context: Context) => Resolved) => Resolved;
}) => void;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    return next(specifier, context);
  },
});
const { readExecutivePages,readExecutiveFinancialStates,loadAdminExecutiveKpis } = await import('../../src/lib/admin-finance/executive-data.ts');

test('financial states walk capped batches with at most four concurrent queries',async()=>{
 const ids=Array.from({length:1251},(_,i)=>i+1),sizes:number[]=[];let active=0,max=0;
 const supabase={from(){throw new Error('unexpected table')},async rpc(_name:string,p:{p_order_ids:number[]}){
 active++;max=Math.max(max,active);sizes.push(p.p_order_ids.length);await Promise.resolve();active--;
 return {data:p.p_order_ids.map(order_id=>({order_id,total_usd:10,confirmed_paid_usd:10,pending_usd:0})),error:null};
 }};
 const rows=await readExecutiveFinancialStates(supabase as never,ids);
 assert.deepEqual(rows.map(r=>r.order_id),ids);assert.deepEqual(sizes,[250,250,250,250,250,1]);assert.ok(max<=4);
});
test('financial states reject missing, duplicate and unrelated answers instead of zeroing debt',async()=>{
 for(const data of [[],[{order_id:7},{order_id:7}],[{order_id:9}]]){
 await assert.rejects(readExecutiveFinancialStates({rpc:async()=>({data,error:null})} as never,[7]),/saldos/);
 }
});

test('financial state batches reject malformed amounts while preserving valid numeric strings', async () => {
  const good = { order_id: 7, total_usd: '11.004', confirmed_paid_usd: '5.003', pending_usd: '6.001' };
  const client = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;
  assert.deepEqual(await readExecutiveFinancialStates(client([good]), [7]), [good]);
  for (const value of [null, '', 'NaN', 'Infinity', -1, false]) {
    for (const field of ['total_usd', 'confirmed_paid_usd', 'pending_usd']) {
      await assert.rejects(readExecutiveFinancialStates(client([{ ...good, [field]: value }]), [7]), /saldos/);
    }
  }
});

test('executive pagination reads past API row caps without losing or duplicating a row', async () => {
  const data = Array.from({ length: 722 }, (_, id) => ({ id }));
  const calls: [number, number][] = [];
  const result = await readExecutivePages<{ id: number }>(async (from, to) => {
    calls.push([from, to]);
    return { data: data.slice(from, to + 1), error: null };
  });
  assert.deepEqual(result, data);
  assert.deepEqual(calls, [[0, 249], [250, 499], [500, 749]]);
});

test('executive pagination checks the page after an exact boundary and returns known empty results', async () => {
  let calls = 0;
  const result = await readExecutivePages(async (from) => {
    calls += 1;
    return { data: from === 0 ? Array.from({ length: 250 }, (_, id) => id) : [], error: null };
  });
  assert.equal(result.length, 250);
  assert.equal(calls, 2);
  assert.deepEqual(await readExecutivePages(async () => ({ data: [], error: null })), []);
});

test('executive pagination rejects partial reads after a query error or unsafe volume', async () => {
  await assert.rejects(readExecutivePages(async (from) => from === 0
    ? { data: Array.from({ length: 250 }, (_, id) => id), error: null }
    : { data: null, error: { message: 'consulta fallida' } }), /consulta fallida/);
  await assert.rejects(readExecutivePages(async () => ({ data: Array.from({ length: 250 }, (_, id) => id), error: null })), /8.000 registros/);
});

function executiveFixture(input: {
  scheduled?: Record<string, unknown>[];
  legacy?: Record<string, unknown>[];
  delivered?: Record<string, unknown>[];
  deliveredIds: number[];
  failLookup?: boolean;
}) {
  const lookups: number[][] = [];
  const balanceReads: number[][] = [];
  let concurrent = 0, maxConcurrent = 0;
  const supabase = {
    from(table: string) {
      let from = 0, to = 249, scheduled = false, ids: number[] | null = null;
      const query = {
        select() { return query; }, eq() { return query; }, neq() { return query; },
        gte(field: string) { scheduled ||= field.includes('schedule'); return query; },
        lt() { return query; }, lte() { return query; }, order() { return query; },
        range(a: number, b: number) { from = a; to = b; return query; },
        in(_field: string, value: number[]) { ids = value; return query; },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          const read = async () => {
            if (ids) {
              lookups.push(ids);
              concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
              await Promise.resolve();
              concurrent--;
              return { data: input.failLookup ? null : (input.delivered ?? []).filter(row => ids!.includes(Number(row.id))),
                error: input.failLookup ? { message: 'lookup unavailable' } : null };
            }
            const rows = table === 'order_events'
              ? input.deliveredIds.map(order_id => ({ order_id, created_at: '2026-11-25T12:00:00Z' }))
              : scheduled ? input.scheduled ?? [] : input.legacy ?? [];
            return { data: rows.slice(from, to + 1), error: null };
          };
          return read().then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(_name: string, params: { p_order_ids: number[] }) {
      balanceReads.push(params.p_order_ids);
      return { data: params.p_order_ids.map(order_id => ({ order_id, total_usd: 10, confirmed_paid_usd: 4, pending_usd: 6 })), error: null };
    },
  };
  return { supabase: supabase as never, lookups, balanceReads, maxConcurrent: () => maxConcurrent };
}

const executiveOrder = (id: number, date: string | null = '2026-11-25') => ({
  id, status: 'delivered', fulfillment: 'delivery', total_usd: 10, total_bs_snapshot: null,
  created_at: '2026-11-25T10:00:00Z', extra_fields: date ? { schedule: { date } } : null,
});
const asOf = new Date('2026-11-25T18:00:00Z');

test('executive reuses this request\'s known orders but still reads their current canonical balances', async () => {
  const orders = [executiveOrder(1), executiveOrder(2, null)];
  const f = executiveFixture({ scheduled: [orders[0]], legacy: orders, deliveredIds: [1, 2] });
  const result = await loadAdminExecutiveKpis({ supabase: f.supabase, asOf });
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.balanceReads, [[1, 2]]);
  assert.equal(result.today.deliveriesCompleted, 2);
  assert.equal(result.operational.today.pendingUsd, 12);
  assert.equal(result.operational.week.financialStatesComplete, true);
});

test('orders created before the historical window are still fetched when delivered this week', async () => {
  const older = { ...executiveOrder(9, null), created_at: '2026-09-01T10:00:00Z' };
  const f = executiveFixture({ deliveredIds: [9], delivered: [older] });
  const result = await loadAdminExecutiveKpis({ supabase: f.supabase, asOf });
  assert.deepEqual(f.lookups, [[9]]);
  assert.deepEqual(f.balanceReads, [[9]]);
  assert.equal(result.today.billedOrders, 1);
  assert.equal(result.today.pendingUsd, 6);
});

test('a scheduled row excluded from the legacy set is not mistaken for a reused delivery', async () => {
  const later = executiveOrder(3, '2027-01-01');
  const f = executiveFixture({ legacy: [later], deliveredIds: [3], delivered: [later] });
  const result = await loadAdminExecutiveKpis({ supabase: f.supabase, asOf });
  assert.deepEqual(f.lookups, [[3]]);
  assert.deepEqual(f.balanceReads, [[3]]);
  assert.equal(result.today.billedOrders, 1);
});

test('delivery lookups stay bounded to four concurrent 250-row batches', async () => {
  const delivered = Array.from({ length: 1_001 }, (_, i) => executiveOrder(i + 1));
  const f = executiveFixture({ deliveredIds: delivered.map(row => row.id), delivered });
  const result = await loadAdminExecutiveKpis({ supabase: f.supabase, asOf, includeFinancialStates: false });
  assert.deepEqual(f.lookups.map(ids => ids.length), [250, 250, 250, 250, 1]);
  assert.equal(f.maxConcurrent(), 4);
  assert.equal(result.today.deliveriesCompleted, 1_001);
});

test('failed missing-order lookups still fail instead of publishing incomplete indicators', async () => {
  const f = executiveFixture({ deliveredIds: [9], failLookup: true });
  await assert.rejects(loadAdminExecutiveKpis({ supabase: f.supabase, asOf }), /lookup unavailable/);
  assert.deepEqual(f.balanceReads, []);
});
