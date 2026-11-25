import assert from 'node:assert/strict';
import test from 'node:test';
import { observeServerOperation } from '../../src/lib/observability/server-operation.ts';

const context = { surface: 'counter' as const, operation: 'apply_order_payments' };

test('a successful command runs once and returns the original receipt without logging its payload', async (t) => {
  const records: string[] = [];
  t.mock.method(console, 'info', (value: string) => records.push(value));
  let executions = 0;
  const receipt = { data: { amount: 10, payer: 'private-payer', idempotencyKey: 'private-key' }, error: null };
  const result = await observeServerOperation(context, () => { executions++; return receipt; }, { logSuccess: true });
  assert.equal(result, receipt);
  assert.equal(executions, 1);
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).outcome, 'success');
  assert.doesNotMatch(records[0], /private-payer|private-key|amount/);
});

test('a returned database failure remains unchanged and exposes only its safe error code', async (t) => {
  const records: string[] = [];
  t.mock.method(console, 'error', (value: string) => records.push(value));
  const response = { data: null, error: { code: '23505', message: 'private financial detail', details: 'private record' } };
  assert.equal(await observeServerOperation(context, () => response), response);
  const record = JSON.parse(records[0]);
  assert.equal(record.outcome, 'error');
  assert.equal(record.errorCode, '23505');
  assert.doesNotMatch(records[0], /private/);
});

test('a rejected command is never retried and rethrows the same failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  let executions = 0;
  const error = new Error('original failure');
  await assert.rejects(observeServerOperation(context, () => { executions++; throw error; }), (received) => received === error);
  assert.equal(executions, 1);
});

test('a logger failure never repeats or reverses an operation result', async (t) => {
  t.mock.method(console, 'info', () => { throw new Error('logger failed'); });
  t.mock.method(console, 'error', () => { throw new Error('logger failed'); });
  let executions = 0;
  const receipt = { data: { committed: true }, error: null };
  assert.equal(await observeServerOperation(context, () => { executions++; return receipt; }, { logSuccess: true }), receipt);
  const response = { data: null, error: { code: 'P0001' } };
  assert.equal(await observeServerOperation(context, () => { executions++; return response; }), response);
  assert.equal(executions, 2);
});

test('routine fast reads stay quiet and slow-read records contain duration rather than CPU', async (t) => {
  const records: string[] = [];
  t.mock.method(console, 'info', (value: string) => records.push(value));
  await observeServerOperation({ surface: 'admin', operation: 'read_executive_kpis' }, () => 1);
  assert.equal(records.length, 0);
  await observeServerOperation({ surface: 'admin', operation: 'read_executive_kpis' }, () => 2, { slowAfterMs: 0 });
  const record = JSON.parse(records[0]);
  assert.equal(record.surface, 'admin');
  assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0);
  assert.equal('cpu' in record, false);
});
