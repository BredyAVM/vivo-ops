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
const { readExecutivePages } = await import('../../src/lib/admin-finance/executive-data.ts');

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
