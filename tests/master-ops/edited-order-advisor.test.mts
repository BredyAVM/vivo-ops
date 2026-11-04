import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveEditedOrderAdvisor } from '../../src/lib/orders/edited-order-advisor.ts';

test('saving a master order preserves the attributed advisor', () => {
  assert.equal(resolveEditedOrderAdvisor({
    source: 'master', currentAdvisorId: 'original', selectedAdvisorId: null, hasCrmBenefit: false,
  }), 'original');
});

test('ordinary edits preserve an unassigned order and do not use a hidden selection', () => {
  for (const source of ['master', 'walk_in'] as const) {
    assert.equal(resolveEditedOrderAdvisor({
      source, currentAdvisorId: null, selectedAdvisorId: 'hidden', hasCrmBenefit: false,
    }), null);
  }
});

test('explicit advisor and CRM selections retain their existing behavior', () => {
  for (const [source, hasCrmBenefit] of [['advisor', false], ['master', true]] as const) {
    assert.equal(resolveEditedOrderAdvisor({
      source, currentAdvisorId: 'original', selectedAdvisorId: 'selected', hasCrmBenefit,
    }), 'selected');
    assert.throws(() => resolveEditedOrderAdvisor({
      source, currentAdvisorId: 'original', selectedAdvisorId: null, hasCrmBenefit,
    }), /seleccionar un asesor/);
  }
});

test('the edit action uses the saved advisor and records both sides of a real reassignment', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const edit = source.slice(source.indexOf('export async function updateOrderAction('), source.indexOf('type AdvisorCommissionOrderRow'));
  assert.match(edit, /resolveEditedOrderAdvisor\(\{[\s\S]*?currentAdvisorId: currentOrder\.attributed_advisor_id/);
  assert.match(edit, /attributed_advisor_id: attributedAdvisorId/);
  assert.match(edit, /previous_advisor_user_id: beforeSnapshot\.attributed_advisor_id/);
  assert.match(edit, /next_advisor_user_id: attributedAdvisorId/);
  assert.doesNotMatch(edit, /\? input\.attributedAdvisorUserId : user\.id/);
});
