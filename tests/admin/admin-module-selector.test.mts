import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APP_MODULES, getEnabledModulesForRoles, getModuleByKey, isModuleAvailableForRoles, normalizeAppRoles, resolveHomePathForRoles } from '../../src/lib/app-modules.ts';

test('administrators can select both the new and old module with distinct keys', () => {
  const modules = getEnabledModulesForRoles(['admin']);
  assert.deepEqual(modules.map(({ key, label, href }) => ({ key, label, href })), [
    { key: 'admin', label: 'Administrador', href: '/app/admin' },
    { key: 'admin-legacy', label: 'Administrador antiguo', href: '/app/master/dashboard' },
  ]);
  assert.equal(new Set(APP_MODULES.map(module => module.key)).size, APP_MODULES.length);
  assert.equal(resolveHomePathForRoles(['admin']), '/app');
});

test('saved module choices distinguish both dashboards without creating a new role', () => {
  assert.equal(resolveHomePathForRoles(['admin'], 'admin'), '/app/admin');
  assert.equal(resolveHomePathForRoles(['admin'], 'admin-legacy'), '/app/master/dashboard');
  assert.deepEqual(normalizeAppRoles(['admin', 'admin-legacy']), ['admin']);
  const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  assert.match(read('src/app/app/master/dashboard/MasterDashboardClient.tsx'), /activeModuleKey = isAdmin \? 'admin-legacy' : 'master'/);
  assert.match(read('src/app/app/admin/_components/AdminShell.tsx'), /<ModulePreference moduleKey="admin"/);
  assert.match(read('src/app/app/admin/_components/AdminShell.tsx'), /href="\/app" prefetch=\{false\}/);
});

test('non-admin roles never receive either administrative module or its preferred entry', () => {
  for (const role of ['master', 'advisor', 'counter', 'kitchen', 'driver']) {
    for (const key of ['admin', 'admin-legacy']) {
      assert.equal(isModuleAvailableForRoles(key, [role]), false);
      assert.ok(!getEnabledModulesForRoles([role]).some(module => module.key === key));
      assert.notEqual(resolveHomePathForRoles([role], key), getModuleByKey(key)?.href);
    }
  }
  assert.equal(getModuleByKey('master')?.href, '/app/master/ops');
  assert.deepEqual(getEnabledModulesForRoles([]), []);
});
