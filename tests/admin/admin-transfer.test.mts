import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseMoneyTransferReceipt, isDefinitiveTransferRejection, validTransferRequestId, type MoneyTransferInput } from '../../src/lib/finance/money-transfer-model.ts';

const input: MoneyTransferInput = { requestId: '00000000-0000-4000-8000-000000000091', sourceMoneyAccountId: 1,
  targetMoneyAccountId: 2, sourceAmount: 5, targetAmount: 1000, feeAmount: 0.5, movementDate: '2026-09-12',
  sourceExchangeRateVesPerUsd: null, targetExchangeRateVesPerUsd: 200, referenceCode: '', counterpartyName: '', description: 'Traspaso entre cuentas', notes: '' };
const receipt = { movementGroupId: input.requestId, sourceMovementId: 11, targetMovementId: 12, feeMovementId: 13, replayed: false };
test('receipt certifies distinct positive legs, optional fee and the same retry identity', () => {
  assert.deepEqual(parseMoneyTransferReceipt(receipt, input), receipt);
  assert.equal(parseMoneyTransferReceipt({ ...receipt, replayed: true }, input)?.replayed, true);
  for (const patch of [{ sourceMovementId: 0 }, { targetMovementId: 11 }, { feeMovementId: null },
    { feeMovementId: 12 }, { replayed: undefined }, { movementGroupId: 'another' }, { sourceMovementId: '11' }]) {
    assert.equal(parseMoneyTransferReceipt({ ...receipt, ...patch }, input), null);
  }
  assert.equal(parseMoneyTransferReceipt({ ...receipt, feeMovementId: null }, { ...input, feeAmount: 0 })?.feeMovementId, null);
  assert.equal(parseMoneyTransferReceipt(receipt, { ...input, feeAmount: 0 }), null);
});
test('network errors are never classified as a definitive rejection', () => {
  for (const code of ['22023', '23514', '42501', 'P0001']) assert.equal(isDefinitiveTransferRejection(code), true);
  for (const code of ['', undefined, 'PGRST000', '500', 'timeout']) assert.equal(isDefinitiveTransferRejection(code), false);
  assert.equal(validTransferRequestId(input.requestId), true);
  assert.equal(validTransferRequestId(''), false);
});

const state = { roles: ['admin'] as string[], calls: [] as Array<{ name: string; params: Record<string, unknown> }>,
  response: { data: receipt as unknown, error: null as { code: string; message: string } | null }, throws: false, cacheThrows: false };
Reflect.set(globalThis, '__transferTest', {
  context() {
    if (!state.roles.includes('admin')) throw new Error('No autorizado');
    return { supabase: { async rpc(name: string, params: Record<string, unknown>) {
      state.calls.push({ name, params }); if (state.throws) throw new Error('connection lost'); return state.response;
    } } };
  },
  cache() { if (state.cacheThrows) throw new Error('cache unavailable'); },
});
const registerHooks = Reflect.get(await import('node:module'), 'registerHooks') as (hooks: {
  resolve: (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => { url: string }) => { url: string; shortCircuit?: boolean };
}) => void;
registerHooks({ resolve(specifier, context, next) {
  const mocks: Record<string, string> = {
    'server-only': 'export {};',
    '@/lib/auth': 'export async function requireAdminContext(){return globalThis.__transferTest.context()}',
    'next/cache': 'export function revalidatePath(){globalThis.__transferTest.cache()} export function updateTag(){globalThis.__transferTest.cache()}',
  };
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL(`../../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier === './money-transfer-model') return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { createAdminTransferAction } = await import('../../src/app/app/admin/finanzas/cuentas/transferencia/actions.ts');
function reset() { state.roles = ['admin']; state.calls = []; state.response = { data: receipt, error: null }; state.throws = false; state.cacheThrows = false; }

test('Admin uses one canonical call preserving native amounts, rates and request identity', async () => {
  reset(); const result = await createAdminTransferAction(input);
  assert.equal(result.status, 'confirmed'); assert.equal(state.calls.length, 1);
  const { requestId, ...body } = input;
  assert.deepEqual(state.calls[0], { name: 'create_money_transfer_v1', params: { p_request_id: requestId, p_input: body } });
});
test('anonymous, advisor and Master cannot reach the transfer call', async () => {
  for (const roles of [[], ['advisor'], ['master']]) {
    reset(); state.roles = roles;
    await assert.rejects(createAdminTransferAction(input), /No autorizado/); assert.equal(state.calls.length, 0);
  }
});
test('invalid request identity does not reach the database', async () => {
  reset(); assert.equal((await createAdminTransferAction({ ...input, requestId: '' })).status, 'rejected');
  assert.equal(state.calls.length, 0);
});
test('invalid receipts and lost responses require identical retries', async () => {
  reset(); state.response.data = null;
  assert.equal((await createAdminTransferAction(input)).status, 'uncertain');
  state.throws = true;
  assert.equal((await createAdminTransferAction(input)).status, 'uncertain');
  assert.deepEqual(state.calls[0], state.calls[1]);
  state.throws = false; state.response.data = { ...receipt, replayed: true };
  const result = await createAdminTransferAction(input);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') assert.equal(result.receipt.replayed, true);
});
test('database rejection is surfaced without claiming success', async () => {
  reset(); state.response = { data: null, error: { code: '22023', message: 'Ambas cuentas deben estar activas.' } };
  const result = await createAdminTransferAction(input);
  assert.deepEqual(result, { status: 'rejected', message: 'Ambas cuentas deben estar activas.' });
});
test('a cache error never hides a committed receipt', async () => {
  reset(); state.cacheThrows = true;
  assert.equal((await createAdminTransferAction(input)).status, 'confirmed');
});
test('form freezes uncertain attempts and only starts a new identity after confirmation', () => {
  const source = readFileSync(new URL('../../src/app/app/admin/finanzas/cuentas/transferencia/TransferForm.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(busy.current/);
  assert.match(source, /input = attempt.current \?\? buildInput\(\)/);
  assert.match(source, /requestId.current \?\?= crypto.randomUUID\(\)/);
  assert.match(source, /result\?\.status === 'uncertain'/);
  assert.match(source, /<fieldset disabled=\{locked\}/);
  assert.equal((source.match(/requestId.current = null/g) ?? []).length, 1);
  assert.ok(source.indexOf('requestId.current = null') > source.indexOf("if (result?.status === 'confirmed'"));
});
