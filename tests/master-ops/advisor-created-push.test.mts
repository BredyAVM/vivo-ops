import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliverAdvisorCreatedPush, type CreationPushReceipt } from '../../src/lib/orders/advisor-created-push.ts';
import { pushUrlForSubscription } from '../../src/lib/pwa/push-routing.ts';

const input = { orderId: 3501, claimId: 'claim-one' };

test('durable claim wins before send; new and compatibility retries broadcast once', async () => {
  let claimed = false;
  let sends = 0;
  const receipts: CreationPushReceipt[] = [];
  const dependencies = {
    claim: async () => {
      if (claimed) return { claimed: false };
      claimed = true;
      return { claimed: true, eventId: 33844 };
    },
    send: async (payload: { url: string; tag: string; roles: string[]; tone: string }) => {
      assert.equal(claimed, true);
      assert.equal(payload.url, '/app/master/ops?openOrder=3501&tab=pedido');
      assert.equal(payload.tag, 'master-order-3501-order_created');
      assert.deepEqual(payload.roles, ['master', 'admin']);
      assert.equal(payload.tone, 'critical');
      assert.equal(pushUrlForSubscription(payload.url, 'master_ops', payload.tag), payload.url);
      assert.equal(pushUrlForSubscription(payload.url, 'admin', payload.tag), '/app/admin/ordenes?openOrder=3501&tab=pedido');
      sends++;
      return { skipped: false, delivered: 2, failures: [] };
    },
    finish: async (receipt: CreationPushReceipt) => { receipts.push(receipt); },
    report: () => {},
  };
  await Promise.all(Array.from({ length: 8 }, () => deliverAdvisorCreatedPush(input, dependencies)));
  assert.equal(sends, 1);
  assert.deepEqual(receipts, [{ eventId: 33844, claimId: input.claimId, status: 'sent', delivered: 2, failures: 0 }]);
});

for (const [name, result, expected] of [
  ['missing configuration', { skipped: true }, 'skipped'],
  ['no subscriptions', { skipped: false, delivered: 0, failures: [] }, 'skipped'],
  ['some devices rejected', { skipped: false, delivered: 1, failures: [{}] }, 'partial'],
  ['all devices rejected', { skipped: false, delivered: 0, failures: [{}] }, 'failed'],
] as const) {
  test(`records ${name} without silently declaring delivery`, async () => {
    let receipt: CreationPushReceipt | undefined;
    await deliverAdvisorCreatedPush(input, {
      claim: async () => ({ claimed: true, eventId: 1 }),
      send: async () => ({ ...result, ...('failures' in result ? { failures: [...result.failures] } : {}) }),
      finish: async (value) => { receipt = value; }, report: () => {},
    });
    assert.equal(receipt?.status, expected);
  });
}

test('ambiguous network failure is recorded and never triggers a second send', async () => {
  let attempts = 0;
  let claimed = false;
  let status = '';
  const deps = {
    claim: async () => { const first = !claimed; claimed = true; return { claimed: first, eventId: 1 }; },
    send: async () => { attempts++; throw new Error('connection lost after acceptance'); },
    finish: async (receipt: CreationPushReceipt) => { status = receipt.status; }, report: () => {},
  };
  await deliverAdvisorCreatedPush(input, deps);
  await deliverAdvisorCreatedPush(input, deps);
  assert.equal(attempts, 1);
  assert.equal(status, 'uncertain');
});

test('claim failure or malformed receipt sends nothing', async () => {
  for (const claim of [async () => { throw new Error('database unavailable'); }, async () => ({ claimed: true })]) {
    let sends = 0;
    await assert.rejects(() => deliverAdvisorCreatedPush(input, {
      claim, send: async () => { sends++; return { skipped: false }; }, finish: async () => {}, report: () => {},
    }));
    assert.equal(sends, 0);
  }
});

test('a lost completion receipt cannot cause another broadcast', async () => {
  let claimed = false, sends = 0;
  const deps = {
    claim: async () => { const first = !claimed; claimed = true; return { claimed: first, eventId: 1 }; },
    send: async () => { sends++; return { skipped: false, delivered: 1 }; },
    finish: async () => { throw new Error('completion response lost'); }, report: () => {},
  };
  await assert.rejects(() => deliverAdvisorCreatedPush(input, deps));
  await deliverAdvisorCreatedPush(input, deps);
  assert.equal(sends, 1);
});

test('both authenticated creation entry points schedule after commit, not during insert', () => {
  const source = readFileSync(new URL('../../src/app/app/advisor/new/actions.ts', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('export async function createAdvisorOrderAction'), source.indexOf('export async function replaceAdvisorOrderItemsAction'));
  const compatibility = source.slice(source.indexOf('export async function ensureAdvisorOrderCreatedEventAction'), source.indexOf('export async function updateAdvisorOrderHeaderAction'));
  assert.ok(create.indexOf("rpc('advisor_create_order_atomic_v1'") < create.indexOf('scheduleAdvisorCreatedPush(orderId, ctx.user.id)'));
  assert.match(compatibility, /order.attributed_advisor_id !== ctx.user.id/);
  assert.match(compatibility, /scheduleAdvisorCreatedPush\(orderId, ctx.user.id\)/);
  assert.doesNotMatch(compatibility, /if \(existingEvent\) return|sendPushToRoleDevices|\.insert\(/);
  const scheduler = source.slice(source.indexOf('function scheduleAdvisorCreatedPush'), source.indexOf('function toFiniteNumber'));
  assert.match(scheduler, /after\(async \(\) =>/);
  assert.match(scheduler, /claim_advisor_created_push_v1/);
  assert.match(scheduler, /finish_advisor_created_push_v1/);
  assert.doesNotMatch(scheduler, /requireAuthContext|\.from\('orders'\)|setTimeout/);
});
