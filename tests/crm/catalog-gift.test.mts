import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decideCatalogGift, shouldResolveCatalogGift } from '../../src/lib/crm/catalog-gift.ts';

const candidate = { play_member_id: 1, play_benefit_id: 2, play_benefit_upgrade_id: null, quantity: 1, benefit_status: 'available' };
test('only dual-use Gambits are automatically considered; never a normal paid product', () => {
  assert.equal(shouldResolveCatalogGift({ type: 'gambit', extra_fields: { catalog_access_scope: 'advisor_gift' } }), true);
  for (const scope of ['advisor_gift_only', 'crm_only', 'gambit_disabled', 'admin_internal', undefined]) {
    assert.equal(shouldResolveCatalogGift({ type: 'gambit', extra_fields: { catalog_access_scope: scope } }), false);
  }
  assert.equal(shouldResolveCatalogGift({ type: 'combo', extra_fields: { catalog_access_scope: 'advisor_gift' } }), false);
});
test('no matching membership preserves the discretionary gift', () => {
  assert.equal(decideCatalogGift([], 1).kind, 'discretionary');
});
test('one exact match links the existing selection', () => {
  assert.deepEqual(decideCatalogGift([candidate], 1), { kind: 'match', candidate });
});
test('two campaigns require an explicit choice, never first-match guessing', () => {
  assert.equal(decideCatalogGift([candidate, { ...candidate, play_member_id: 3 }], 1).kind, 'choose');
});
test('redeemed and reserved gifts cannot silently fall back to discretionary', () => {
  for (const benefit_status of ['reserved', 'redeemed']) {
    assert.equal(decideCatalogGift([{ ...candidate, benefit_status }], 1).kind, 'unavailable');
  }
});
test('quantity mismatch/invalid input cannot multiply an entitlement', () => {
  for (const quantity of [0, -1, 2, NaN, Infinity]) assert.equal(decideCatalogGift([candidate], quantity).kind, 'invalid_quantity');
});
test('an explicitly eligible campaign is selectable when another campaign is consumed', () => {
  assert.equal(decideCatalogGift([{ ...candidate, benefit_status: 'redeemed' }, { ...candidate, play_member_id: 3 }], 1).kind, 'match');
});
test('migration uses private mappings and the normal lifecycle, not delivery simulation', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260918171721_crm_catalog_gift_auto_link.sql', import.meta.url), 'utf8');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /crm_set_play_benefits_v2/);
  assert.match(sql, /before insert on public.order_items/);
  assert.match(sql, /auth.uid\(\) is distinct from ord.attributed_advisor_id/);
  assert.doesNotMatch(sql, /disable trigger|set status\s*=\s*'delivered'|insert into public.crm_play_redemptions/i);
});
