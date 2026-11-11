import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import type { KitchenTakeResult } from '../../src/app/app/kitchen/actions.ts';

const source = readFileSync(new URL('../../src/app/app/kitchen/actions.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../src/app/app/kitchen/KitchenClient.tsx', import.meta.url), 'utf8');
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledAction = compile(source);
type Input = { orderId: number; etaMinutes: number };
type Options = {
  status?: string;
  roles?: string[];
  authenticated?: boolean;
  authFailure?: boolean;
  missing?: boolean;
  readErrorAt?: number;
  take?: (order: { status: string; eta_minutes: number; kitchen_started_at: string }) => void;
};

function serverFixture(options: Options = {}) {
  const order = { status: options.status ?? 'confirmed', eta_minutes: 15, kitchen_started_at: '2026-11-10T20:50:00Z' };
  const original = { ...order };
  const calls: Input[] = [];
  let reads = 0;
  const logs: unknown[][] = [];
  const supabase = {
    from(table: string) {
      assert.equal(table, 'orders');
      return { select(columns: string) {
        assert.equal(columns, 'status', 'no sensitive or mutable fields requested');
        return { eq(key: string, value: number) {
          assert.equal(key, 'id'); assert.equal(value, 3913);
          return { async maybeSingle() {
            reads++;
            if (options.readErrorAt === reads) return { data: null, error: { message: 'private database detail' } };
            return { data: options.missing ? null : { status: order.status }, error: null };
          } };
        } };
      } };
    },
  };
  const exports = {} as { takeOrderForKitchenAction(input: Input): Promise<KitchenTakeResult> };
  const boundaryRequire = (name: string) => {
    if (name === 'next/cache') return { revalidatePath() { assert.fail('adapter must not invalidate another module'); } };
    if (name === '@/lib/auth') return { async getAuthContext() {
      if (options.authFailure) throw new Error('private auth detail');
      return options.authenticated === false ? null : { supabase, roles: options.roles ?? ['kitchen'] };
    } };
    if (name === '../master/dashboard/actions') return { async kitchenTakeAction(input: Input) {
      calls.push(input);
      if (options.take) options.take(order);
      else { order.status = 'in_kitchen'; order.eta_minutes = input.etaMinutes; }
    } };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function('require', 'exports', 'console', compiledAction)(boundaryRequire, exports, { error: (...args: unknown[]) => logs.push(args) });
  return { run: (input: Input = { orderId: 3913, etaMinutes: 20 }) => exports.takeOrderForKitchenAction(input),
    calls, order, original, reads: () => reads, logs };
}

test('3913 already preparing returns clear feedback without taking again or changing its clock', async () => {
  const f = serverFixture({ status: 'in_kitchen' });
  const result = await f.run();
  assert.equal(result.outcome, 'state_changed');
  assert.equal(result.status, 'in_kitchen');
  assert.match(result.message!, /ya está en preparación.*tiempo original/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.order, f.original);
});

test('an eligible order delegates exactly once with the requested ETA to the canonical action', async () => {
  const f = serverFixture();
  assert.deepEqual(await f.run(), { outcome: 'taken', status: 'in_kitchen', message: null });
  assert.deepEqual(f.calls, [{ orderId: 3913, etaMinutes: 20 }]);
  assert.equal(f.reads(), 1);
});

test('a concurrent Master take is reconciled after rejection without restarting its ETA', async () => {
  const f = serverFixture({ take(order) {
    order.status = 'in_kitchen'; // Master wins after our preflight read.
    throw new Error('Order 3913 cannot be taken by kitchen from its current status');
  } });
  const result = await f.run();
  assert.equal(result.outcome, 'state_changed');
  assert.equal(result.status, 'in_kitchen');
  assert.equal(f.calls.length, 1);
  assert.equal(f.reads(), 2);
  assert.equal(f.order.eta_minutes, f.original.eta_minutes);
  assert.equal(f.order.kitchen_started_at, f.original.kitchen_started_at);
});

test('failure after a committed take reads state but never retries the mutation or events', async () => {
  const f = serverFixture({ take(order) {
    order.status = 'in_kitchen'; order.eta_minutes = 20;
    throw new Error('timeline delivery failure');
  } });
  assert.equal((await f.run()).outcome, 'state_changed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.order.eta_minutes, 20);
  assert.equal(f.logs.length, 1, 'unexpected failure remains observable on the server');
});

for (const [status, label] of [['ready', 'ya está listo'], ['out_for_delivery', 'salió a delivery'], ['delivered', 'entregado'], ['cancelled', 'cancelado'], ['draft', 'estado de este pedido cambió']]) {
  test(`stale take in ${status} returns accurate feedback and performs no write`, async () => {
    const f = serverFixture({ status });
    const result = await f.run();
    assert.equal(result.outcome, 'state_changed');
    assert.equal(result.status, status);
    assert.ok(result.message?.includes(label));
    assert.deepEqual(f.order, f.original);
    assert.equal(f.calls.length, 0);
  });
}

test('rejected action with unchanged status never claims success or exposes internal errors', async () => {
  const f = serverFixture({ take() { throw new Error('private database detail'); } });
  const result = await f.run();
  assert.equal(result.outcome, 'error');
  assert.equal(result.status, null);
  assert.doesNotMatch(result.message!, /private|React|digest/);
  assert.equal(f.calls.length, 1);
});

test('unavailable, missing and unauthorized state never enables a blind take', async () => {
  for (const options of [{ missing: true }, { readErrorAt: 1 }, { roles: ['advisor'] }, { authenticated: false }, { authFailure: true }]) {
    const f = serverFixture(options);
    assert.equal((await f.run()).outcome, 'error');
    assert.equal(f.calls.length, 0);
    if (options.roles || options.authenticated === false || options.authFailure) assert.equal(f.reads(), 0);
  }
});

test('failed recovery query remains unconfirmed and never retries a write', async () => {
  const f = serverFixture({ readErrorAt: 2, take() { throw new Error('temporary failure'); } });
  assert.equal((await f.run()).outcome, 'error');
  assert.equal(f.calls.length, 1);
  assert.equal(f.reads(), 2);
});

test('combined roles, Master and admin retain the same Kitchen authority', async () => {
  for (const roles of [['advisor', 'kitchen'], ['master'], ['admin']]) {
    const f = serverFixture({ roles });
    assert.equal((await f.run()).outcome, 'taken');
    assert.equal(f.calls.length, 1);
  }
});

test('invalid order IDs and ETA values are rejected before querying or mutating', async () => {
  for (const input of [{ orderId: 0, etaMinutes: 15 }, { orderId: 1.2, etaMinutes: 15 },
    ...[0, -1, 181, NaN, Infinity, 1.5].map(etaMinutes => ({ orderId: 3913, etaMinutes }))]) {
    const f = serverFixture();
    assert.equal((await f.run(input)).outcome, 'error');
    assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0);
  }
});

// Exercise the actual production event handler (not a rewritten implementation).
const start = client.indexOf('  const runAction =');
const handler = client.slice(start, client.indexOf('\n  const focusOrder =', start)).trim();
function clientFixture(online = true) {
  const lock = { current: false };
  const errors: Array<string | null> = [], notices: Array<string | null> = [], tabs: string[] = [];
  const refreshes: unknown[][] = [], pending: Array<string | null> = [], tasks: Promise<void>[] = [];
  const exports = {} as { runAction(key: string, action: () => Promise<void | KitchenTakeResult>): void };
  runInNewContext(compile('export ' + handler), {
    exports, Error, console: { error() {} }, isPending: false, actionInFlightRef: lock,
    navigator: { onLine: online },
    setErrorMessage: (value: string | null) => errors.push(value),
    setActionNotice: (value: string | null) => notices.push(value),
    setActiveStatus: (value: string) => tabs.push(value),
    setPendingKey: (value: string | null) => pending.push(value),
    startActionTransition: (callback: () => Promise<void>) => tasks.push(callback()),
    requestRefresh: (...args: unknown[]) => refreshes.push(args),
  });
  return { run: exports.runAction, lock, errors, notices, tabs, refreshes, pending, tasks };
}

test('real Kitchen handler blocks immediate double taps and refreshes the confirmed state', async () => {
  const f = clientFixture();
  let complete!: (result: KitchenTakeResult) => void;
  let calls = 0;
  const action = () => { calls++; return new Promise<KitchenTakeResult>(resolve => { complete = resolve; }); };
  f.run('take-3913', action); f.run('take-3913', action);
  assert.equal(calls, 1); assert.equal(f.lock.current, true);
  complete({ outcome: 'state_changed', status: 'in_kitchen', message: 'Este pedido ya está en preparación. Se conserva su tiempo original.' });
  await Promise.all(f.tasks);
  assert.equal(f.lock.current, false);
  assert.match(f.notices.at(-1)!, /tiempo original/);
  assert.deepEqual(f.tabs, ['in_kitchen']);
  assert.deepEqual(f.refreshes, [['action', true]]);
  assert.deepEqual(f.pending, ['take-3913', null]);
  assert.deepEqual(f.errors, [null]);
});

test('real handler replaces minified/transport errors with safe feedback and refreshes without retry', async () => {
  const f = clientFixture(); let calls = 0;
  f.run('take-3913', async () => { calls++; throw new Error('Minified React error #441; private details'); });
  await Promise.all(f.tasks);
  assert.equal(calls, 1);
  assert.match(f.errors.at(-1)!, /Revisa el estado actualizado/);
  assert.doesNotMatch(f.errors.at(-1)!, /React|private/);
  assert.deepEqual(f.refreshes, [['action', true]]);
  assert.equal(f.lock.current, false);
});

test('real handler keeps validation and session feedback clear and never fakes a successful take', async () => {
  const f = clientFixture();
  f.run('take-3913', async () => ({ outcome: 'error', status: null, message: 'Tu sesión venció.' }));
  await Promise.all(f.tasks);
  assert.equal(f.errors.at(-1), 'Tu sesión venció.');
  assert.deepEqual(f.tabs, []);
  f.run('take-3913', async () => { throw new Error('Indica un ETA entre 1 y 180 minutos.'); });
  await Promise.all(f.tasks);
  assert.equal(f.errors.at(-1), 'Indica un ETA entre 1 y 180 minutos.');
});

test('offline tap makes no call and no false refresh claim', async () => {
  const f = clientFixture(false);
  f.run('take-3913', async () => assert.fail('offline mutation'));
  await Promise.all(f.tasks);
  assert.match(f.errors.at(-1)!, /No hay conexión/);
  assert.equal(f.refreshes.length, 0);
  assert.equal(f.lock.current, false);
});

test('Kitchen wiring uses its adapter and accessible informational feedback, not duplicate mutation logic', () => {
  assert.match(client, /await takeOrderForKitchenAction\(\{ orderId: order.id, etaMinutes \}\)/);
  assert.ok(client.includes('Pedido #${order.displayNumber}: ${result.message}'));
  assert.doesNotMatch(client, /\bkitchenTakeAction\b/);
  assert.match(client, /role="status" aria-live="polite"/);
  assert.match(client, /<span>\{actionNotice\}<\/span>/);
  const adapter = source.slice(source.indexOf('export async function takeOrderForKitchenAction'), source.indexOf('type KitchenChangeRecipientRow'));
  assert.doesNotMatch(adapter, /\.update\(|\.insert\(|\.rpc\(|service_role|ServiceRole|revalidatePath\(/);
  assert.equal((adapter.match(/await kitchenTakeAction\(/g) ?? []).length, 1);
});
