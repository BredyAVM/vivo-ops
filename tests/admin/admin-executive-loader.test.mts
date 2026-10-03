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
const { readExecutivePages,readExecutiveFinancialStates } = await import('../../src/lib/admin-finance/executive-data.ts');

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
