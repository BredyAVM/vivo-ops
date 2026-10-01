import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const read = (path: string) => readFileSync(new URL(`../../src/app/app/${path}`,import.meta.url),'utf8');

test('authorization server action independently requires admin', () => {
  const action = read('master/ops/crm-validity-actions.ts').split('export async function authorizeCrmOrderValidityAction')[1];
  assert.match(action,/await requireAdminContext\(\)/);
  assert.doesNotMatch(action,/await requireMasterOrAdminContext\(\)/);
});
test('client and play-member links lead to the same scoped exception page', () => {
  assert.match(read('master/dashboard/MasterDashboardClient.tsx'),/exceptions\?client=\$\{selectedClient.id\}/);
  assert.match(read('master/plays/MasterPlaysClient.tsx'),/exceptions\?client=\$\{member.clientId\}&member=\$\{member.id\}/);
  const page = read('master/plays/exceptions/page.tsx');
  assert.match(page,/await requireMasterOrAdminContext\(\)/);
  assert.match(page,/eq\('id',memberId\).eq\('client_id',clientId\)/);
  assert.match(page,/eq\('client_id',clientId\)/);
  assert.match(page,/OrderExceptionCard key=\{order.id\} orderId=\{Number\(order.id\)\}/);
  assert.match(read('master/plays/exceptions/OrderExceptionCard.tsx'),/CrmOrderValidityPanel orderId=\{orderId\}/);
  assert.match(page,/isAdmin=\{isAdmin\}/);
});
test('order and client views share the panel; no independent exception mutation', () => {
  assert.match(read('master/_components/MasterOrderDetailCore.tsx'),/CrmOrderValidityPanel/);
  assert.match(read('master/ops/MasterOpsOrderEditor.tsx'),/CrmOrderValidityPanel/);
  assert.doesNotMatch(read('master/plays/exceptions/page.tsx'),/\.insert\(|\.update\(/);
  assert.match(read('master/ops/CrmOrderValidityPanel.tsx'),/expanded && !closed && rule.canAuthorize/);
});

test('campaign member name is the accessible link, including closed campaigns', () => {
  const list = read('master/plays/MasterPlaysClient.tsx').split('function MemberList(')[1].split('function PlayMonitor(')[0];
  assert.match(list,/Toca el nombre del cliente/);
  const nameLink = list.match(/<Link\s+href=\{`\/app\/master\/plays\/exceptions\?client=\$\{member.clientId\}&member=\$\{member.id\}`\}[\s\S]*?<\/Link>/)?.[0];
  assert.ok(nameLink);
  assert.match(nameLink,/\{member.clientName\}/);
  assert.match(nameLink,/aria-label=\{`Ver órdenes y excepciones de/);
  assert.match(nameLink,/prefetch=\{false\}/);
  assert.doesNotMatch(nameLink,/play.status|disabled/);
});

test('order heading toggles the same lazily loaded exception panel', () => {
  const card = read('master/plays/exceptions/OrderExceptionCard.tsx');
  assert.match(card,/<h2>\s*<button[\s\S]*?Orden #\{orderId\}[\s\S]*?<\/button>\s*<\/h2>/);
  assert.match(card,/aria-controls=\{panelId\}/);
  assert.match(card,/id=\{panelId\} hidden=\{!open\}/);
  assert.match(card,/open \? <>\s*<CrmOrderValidityPanel/);
});
