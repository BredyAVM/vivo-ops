import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { phoneSearchDigits, matchesPhoneSearch } from '../../src/lib/search/phone-search.ts';

const variants = ['+584140618841', '584140618841', '04140618841', '4140618841', '+58 (414) 061-8841', '0414 061 88 41', '0058 414 0618841'];
for (const variant of variants) {
  test('canonical phone match: ' + variant, () => {
    assert.equal(phoneSearchDigits(variant), '584140618841');
    for (const stored of variants) assert.equal(matchesPhoneSearch(variant, stored), true);
  });
}
test('partial phones, short numbers, empty values and unrelated phones', () => {
  assert.equal(matchesPhoneSearch('0618841', '+58 414 061-8841'), true);
  assert.equal(matchesPhoneSearch('41', '+584140618841'), false);
  assert.equal(matchesPhoneSearch('', '+584140618841'), false);
  assert.equal(matchesPhoneSearch('04141234567', '+584140618841'), false);
  assert.equal(matchesPhoneSearch('0618841', null, undefined), false);
  assert.equal(phoneSearchDigits('+1 (212) 555-1234'), '12125551234');
  assert.equal(phoneSearchDigits('+592 600 1234'), '5926001234');
  assert.equal(phoneSearchDigits('00592 600 1234'), '5926001234');
});
const source = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
test('both master surfaces use the same directory search and a distinct client profile', () => {
  for (const path of ['src/app/app/master/ops/MasterOpsClient.tsx', 'src/app/app/master/dashboard/MasterDashboardClient.tsx']) {
    const text = source(path);
    assert.match(text, /searchMasterDirectoryAction\(\{ query, limit: 10 \}\)/);
    assert.match(text, /MasterClientSearchResults clients=\{clientSearchResults\}/);
    assert.match(text, /matchesPhoneSearch\(/);
  }
});
test('client lookup is projected, bounded and independent of operational orders', () => {
  const text = source('src/lib/search/client-search.ts');
  assert.match(text, /search_clients_unaccent/);
  assert.match(text, /select\('id,full_name,phone,primary_advisor_id'\)/);
  assert.doesNotMatch(text, /from\('orders'\)|service_role/);
});
test('advisor preserves ownership filtering and uses canonical client lookup', () => {
  const text = source('src/app/app/advisor/page.tsx');
  assert.match(text, /searchClientSummaries\(ctx.supabase/);
  assert.match(text, /\.eq\('attributed_advisor_id', ctx.user.id\)/);
  assert.match(text, /client.primary_advisor_id === ctx.user.id/);
});
test('SQL keeps invoker access, short-order priority and phone checks on both search RPCs', () => {
  const text = source('supabase/migrations/20260921150735_operational_phone_client_search.sql');
  assert.equal((text.match(/create or replace function/gi) ?? []).length, 4);
  assert.match(text, /where \(length\(n.q\) >= 2 or n.q ~ '\^\[0-9\]\+\$'\)/);
  assert.doesNotMatch(text, /security definer/i);
  assert.match(text, /when o.id::text = n.q then 0/);
  assert.match(text, /public.search_phone_digits\(o.receiver_phone\)/);
  assert.match(text, /public.search_phone_digits\(c.phone\)/);
  assert.doesNotMatch(text, /drop function|update public|delete from/i);
});
