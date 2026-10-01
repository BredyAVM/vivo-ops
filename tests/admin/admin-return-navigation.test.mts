import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appContextHref, safeAppReturnHref } from '../../src/lib/navigation/return-navigation.ts';

const orders = '/app/admin/ordenes?focusDate=2026-09-30';
const accounts = '/app/admin/finanzas/cuentas';
const account = `${accounts}/11?desde=2026-09-27&hasta=2026-10-01&estado=confirmed&page=2`;
const parent = (href: string) => new URL(href, 'https://vivo.invalid').searchParams.get('returnTo');
const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('the complete Orders → Accounts → Account → Payment path returns one screen at a time', () => {
  const list = appContextHref(accounts, orders);
  const selected = appContextHref(account, list);
  const payment = appContextHref(`${accounts}/11/movimientos/8790`, selected);
  assert.equal(parent(payment), selected);
  assert.equal(parent(selected), list);
  assert.equal(parent(list), orders);
  assert.equal(new URL(parent(payment)!, 'https://vivo.invalid').searchParams.get('page'), '2');
});
test('entering from the executive dashboard returns there, not unconditionally to Orders', () => {
  assert.equal(parent(appContextHref(accounts, '/app/admin')), '/app/admin');
  assert.equal(parent(appContextHref(accounts, '/app/master/dashboard?adminSection=accounts')), '/app/master/dashboard?adminSection=accounts');
});
test('filters, tabs and pagination on the same screen retain the original parent', () => {
  const source = appContextHref(account, appContextHref(accounts, orders));
  const changed = appContextHref(`${accounts}/11?vista=closures&page=3`, source);
  assert.equal(parent(changed), parent(source));
  assert.equal(new URL(changed, 'https://vivo.invalid').searchParams.get('page'), '3');
  const list = appContextHref(`${accounts}?grupo=pos&q=BDV`, appContextHref(accounts, orders));
  assert.equal(parent(list), orders);
});
test('external, command, encoded-path, traversal and executable return destinations are rejected', () => {
  for (const input of [null, undefined, '', 'https://evil.test/app', '//evil.test/app', 'javascript:alert(1)', '/api/delete', '/application', '/app/../login', '/app\\evil', '/app/%2f%2fevil', '/app\n', '/app/admin?x=' + 'a'.repeat(6000)]) {
    assert.equal(safeAppReturnHref(input), null, String(input));
  }
  assert.equal(appContextHref(accounts, 'https://evil.test'), accounts);
  assert.equal(appContextHref('https://example.test', orders), 'https://example.test');
});
test('context links preserve the requested destination parameters and do not depend on arbitrary browser history', () => {
  const result = new URL(appContextHref('/app/admin/ordenes?openOrder=2998&tab=pagos', account), 'https://vivo.invalid');
  assert.equal(result.searchParams.get('openOrder'), '2998'); assert.equal(result.searchParams.get('tab'), 'pagos');
  const back = read('src/components/navigation/BackLink.tsx');
  assert.match(back, /safeAppReturnHref\(search.get\('returnTo'\)\)/);
  assert.match(back, /safeAppReturnHref\(fallbackHref\)/);
  assert.doesNotMatch(back, /history\.length|router\.back|localStorage|sessionStorage/);
  assert.match(back, /name="returnTo"/);
});
test('account forms and both account views preserve the return context', () => {
  for (const file of ['AccountsOverview', 'AccountDetail']) {
    const source = read(`src/app/app/admin/finanzas/cuentas/_components/${file}.tsx`);
    assert.match(source, /<ReturnContextField \/>/); assert.match(source, /<BackLink fallbackHref=/);
    assert.match(source, /@\/components\/navigation\/ContextLink/);
  }
  assert.match(read('src/app/app/admin/_components/AdminNavigation.tsx'), /@\/components\/navigation\/ContextLink/);
  assert.match(read('src/app/app/admin/_components/ExecutiveDashboard.tsx'), /@\/components\/navigation\/ContextLink/);
});
test('Admin view controls share the date row on desktop and retain wrapping on mobile', () => {
  const source = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.match(source, /lg:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(source, /aria-label="Vistas de órdenes"/);
  assert.match(source, /lg:col-start-2 lg:row-start-1 lg:justify-self-end/);
  assert.match(source, /compact=\{isAdminSurface\}/);
  assert.match(source, /flex min-w-0 flex-wrap items-center gap-2 lg:col-span-2 lg:row-start-2/);
});
