import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/app/app/advisor/new/AdvisorOrderComposer.tsx', import.meta.url), 'utf8');
const start = source.indexOf('async function handleSubmit(e: FormEvent)');
const handler = source.slice(start, source.indexOf('\n  if (loading)', start)).trim();

function fixture(overrides: Record<string, unknown> = {}) {
  let calls = 0;
  const finishes: Array<(value: unknown) => void> = [];
  const saved: boolean[] = [];
  const errors: string[] = [];
  const routes: string[] = [];
  const lock = {current: false};
  const created = {current: null as number | null};
  const exports: {handleSubmit?: (event: {preventDefault(): void}) => Promise<void>} = {};
  const globals = {
    exports, catalogGiftBusyRef: {current: false}, catalogGiftChoices: [],
    savingOrderRef: lock, createdOrderIdRef: created, isEditingOrder: false,
    router: {push: (url: string) => routes.push(url)}, setSaving: (value: boolean) => saved.push(value),
    setError: (value: string) => errors.push(value), clearMessages() {},
    activeDraftId: null, draftItems: [{product_id: 1, editable_detail_lines: []}],
    availabilityByProductId: new Map(), protectedDraftViolation: () => null,
    createReady: true, scheduleReady: true, crmContext: null, isAsap: true,
    deliveryHour12: '', deliveryMinute: '', deliveryAmPm: 'AM',
    rounded: {hour12: '10', minute: '00', ampm: 'AM'}, from12hTo24h: () => '10:00',
    availabilityTargetAt: '2026-11-06T14:00:00Z',
    supabase: {rpc: () => {calls++; return new Promise(resolve => {finishes.push(resolve);});}},
  };
  const compiled = ts.transpileModule('export ' + handler, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  });
  runInNewContext(compiled.outputText, {...globals, ...overrides});
  return {submit: () => exports.handleSubmit!({preventDefault() {}}),
    calls: () => calls, finishes, saved, errors, lock, created, routes};
}

test('the real submit handler rejects a second tap during asynchronous preflight', async () => {
  const f = fixture();
  const first = f.submit();
  assert.equal(f.calls(), 1);
  assert.equal(f.lock.current, true);
  await f.submit();
  assert.equal(f.calls(), 1, 'second tap must not start another preflight or write');
  f.finishes[0]({data: {products: [{product_id: 1, inventory_blocks_submission: true, message: 'Validacion detenida'}]}, error: null});
  await first;
  assert.equal(f.lock.current, false);
  assert.deepEqual(f.saved, [true, false]);
  assert.deepEqual(f.errors, ['Validacion detenida']);
});

test('a failed preflight releases the lock for a later corrected attempt', async () => {
  const f = fixture();
  const first = f.submit();
  f.finishes[0]({data: {products: [{product_id: 1, inventory_blocks_submission: true, message: 'Revisar'}]}, error: null});
  await first;
  const retry = f.submit();
  assert.equal(f.calls(), 2);
  f.finishes[1]({data: {products: [{product_id: 1, inventory_blocks_submission: true, message: 'Revisar'}]}, error: null});
  await retry;
  assert.equal(f.lock.current, false);
});

test('an early synchronous validation return also releases the lock', async () => {
  const f = fixture({createReady: false, scheduleReady: false});
  await f.submit();
  assert.equal(f.calls(), 0);
  assert.equal(f.lock.current, false);
  assert.deepEqual(f.saved, [true, false]);
  assert.deepEqual(f.errors, ['Falta colocar la fecha y la hora de entrega.']);
});

test('after a completed creation a new tap opens the existing order without creating again', async () => {
  const f = fixture(); f.created.current = 999;
  await f.submit(); await f.submit();
  assert.deepEqual(f.routes, ['/app/advisor/orders/999', '/app/advisor/orders/999']);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.saved, []);
  assert.match(handler, /targetOrderId = createResult.orderId;\s*createdOrderIdRef.current = targetOrderId/);
  assert.doesNotMatch(handler, /orderCreationRequestRef.current = null|orderCreationTimeRef.current = null/);
});
