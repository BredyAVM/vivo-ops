import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { operationsPushWorker, waitForOperationsWorker, detachAdminPush } from '../../src/lib/pwa/operations-push.ts';
import { pushUrlForSubscription } from '../../src/lib/pwa/push-routing.ts';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('Admin installation has a distinct identity, in-scope start URL, branded icons and no zoom restriction', () => {
  const app = JSON.parse(read('public/pwa/admin.webmanifest'));
  assert.equal(app.id, '/app/admin');
  assert.equal(app.display, 'standalone');
  assert.equal(app.short_name, 'VIVO Admin');
  assert.ok(app.start_url.startsWith(app.scope));
  assert.ok(app.icons.every(icon => icon.src.includes('/admin-')));
  for (const icon of app.icons) {
    const bytes = readFileSync(new URL('../../public' + icon.src, import.meta.url));
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const layout = read('src/app/app/admin/layout.tsx');
  assert.match(layout, /manifest: '\/pwa\/admin.webmanifest'/);
  // Keep installation metadata outside the authenticated /app proxy. Browser
  // manifest requests must not receive a login page or rely on a nested Next metadata convention.
  const manifestPath = layout.match(/manifest: '([^']+)'/)[1];
  assert.equal(manifestPath, '/pwa/admin.webmanifest');
  assert.equal(JSON.parse(read('public' + manifestPath)).id, '/app/admin');
  assert.match(layout, /<AdminPwaRegistrar userId=\{ctx.user.id\}/);
  assert.doesNotMatch(layout, /maximumScale|userScalable/);
});

test('Admin and existing Master registrations are independent; no Advisor worker is replaced', () => {
  assert.deepEqual(operationsPushWorker('admin'), { script: '/admin-sw.js', scope: '/app/admin' });
  assert.deepEqual(operationsPushWorker('master'), { script: '/vivo-sw.js', scope: '/app/' });
  assert.match(read('public/admin-sw.js'), /importScripts\('\/vivo-sw.js'\)/);
  assert.match(read('src/app/app/advisor/AdvisorPwaRegistrar.tsx'), /scope: '\/app\/advisor\/'/);
});

test('registration activation waits for its own worker even when another role controls the page', async () => {
  let callback;
  const worker = { state: 'installing', addEventListener: (_event, fn) => { callback = fn; }, removeEventListener: () => {} };
  const registration = { active: null, installing: worker };
  const promise = waitForOperationsWorker(registration);
  worker.state = 'activated'; callback();
  assert.equal(await promise, registration);
  await assert.rejects(waitForOperationsWorker({ active: null }), /todavía no está disponible/);
});

test('redundant workers reject promptly rather than reporting Push active', async () => {
  const worker = { state: 'redundant', addEventListener() {}, removeEventListener() {} };
  await assert.rejects(waitForOperationsWorker({ active: null, waiting: worker }), /No se pudo activar/);
});

const routes = [
  ['/app/master/dashboard', 'master-order-2934-payment_reported', '/app/admin/ordenes?openOrder=2934'],
  ['/app/master/ops?openOrder=2565&tab=cambios', 'master-order-2565-correction', '/app/admin/ordenes?openOrder=2565&tab=cambios'],
  ['/app/master/dashboard', 'admin-money-approval', '/app/admin/operaciones'],
  ['/app/master/dashboard?adminSection=accounts', 'settings', '/app/admin/configuracion/cuentas'],
  ['/app/master/dashboard?adminSection=users', 'settings', '/app/admin/configuracion/usuarios'],
  ['/app/master/ops/finance?from=2026-09-07', 'money', '/app/admin/finanzas/pagos?from=2026-09-07'],
  ['/app/master/ops/inventory', 'inventory', '/app/admin/inventario'],
  ['/app/inventory/alerts', 'inventory', '/app/admin/inventario/alerts'],
  ['/app/commissions/operating?period=9', 'commission', '/app/admin/finanzas/comisiones/operar/operating?period=9'],
  ['/app/admin/autorizaciones?tipo=expense', 'expense', '/app/admin/autorizaciones?tipo=expense'],
];
for (const [source, tag, target] of routes) test('Admin notification destination: ' + source, () => {
  assert.equal(pushUrlForSubscription(source, 'admin', tag), target);
});

test('Admin routes reject external, malformed and other-role destinations', () => {
  for (const source of ['https://evil.invalid/app/admin', '//evil.invalid/app/admin', '/app/advisor/orders', '/app/administer', '/app/../../api/delete', '/app/admin/%2e%2e/secret', '/app/admin\\evil', '/app/admin\n'])
    assert.equal(pushUrlForSubscription(source, 'admin', ''), '/app/admin/operaciones');
});

test('existing Master/Advisor routing stays intact and explicit order query wins over a tag', () => {
  assert.equal(pushUrlForSubscription('/app/master/dashboard', 'master', 'master-order-2-payment'), '/app/master/dashboard');
  assert.equal(pushUrlForSubscription('/app/advisor/orders/2', 'advisor', 'advisor-order-2'), '/app/advisor/orders/2');
  assert.equal(pushUrlForSubscription('/app/master/dashboard?tab=pagos#details', 'master_ops', 'master-order-2-payment'), '/app/master/ops?tab=pagos&openOrder=2#details');
  assert.equal(pushUrlForSubscription('/app/master/ops?openOrder=5', 'admin', 'master-order-2-payment'), '/app/admin/ordenes?openOrder=5');
});

function workerHarness(admin = true) {
  const handlers = {}, notices = [], opened = [], clients = [], deleted = [];
  const self = {
    VIVO_PUSH_WORKSPACE: admin ? 'admin' : undefined,
    location: { origin: 'https://vivo.test' },
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { showNotification: async (title, options) => { notices.push({ title, options }); } },
    clients: { matchAll: async () => clients, openWindow: async url => { opened.push(url); }, claim: async () => {} },
  };
  vm.runInNewContext(read('public/vivo-sw.js'), {
    self, URL, caches: { keys: async () => ['advisor-cache', 'vivo-ops-app-v1', 'vivo-ops-app-v2'], delete: async key => { deleted.push(key); } },
  });
  async function dispatch(name, event) {
    let result;
    handlers[name]({ ...event, waitUntil: promise => { result = promise; } });
    await result;
  }
  return { notices, opened, clients, deleted, handlers, dispatch };
}

test('Admin Push remains available without an open window and uses the Admin icon', async () => {
  const sw = workerHarness();
  await sw.dispatch('push', { data: { json: () => ({ title: '#2934: pago reportado', url: '/app/admin/ordenes?openOrder=2934' }) } });
  assert.equal(sw.notices[0].options.icon, '/pwa/admin-192.png');
  assert.equal(sw.notices[0].options.data.url, '/app/admin/ordenes?openOrder=2934');
});

test('click opens Admin without hijacking an Advisor window; hostile links fall back internally', async () => {
  const sw = workerHarness(); let advisorNavigated = false;
  sw.clients.push({ url: 'https://vivo.test/app/advisor/orders', focus() {}, navigate() { advisorNavigated = true; } });
  await sw.dispatch('notificationclick', { notification: { close() {}, data: { url: '/app/admin/ordenes?openOrder=2934' } } });
  assert.equal(advisorNavigated, false);
  assert.deepEqual(sw.opened, ['/app/admin/ordenes?openOrder=2934']);
  await sw.dispatch('push', { data: { json: () => ({ url: 'https://evil.invalid/app/admin' }) } });
  assert.equal(sw.notices[0].options.data.url, '/app/admin/operaciones');
});

test('Admin activation preserves Advisor caches and financial/API/HTML data is never cached', async () => {
  const sw = workerHarness();
  await sw.dispatch('activate', {});
  assert.deepEqual(sw.deleted, ['vivo-ops-app-v1']);
  for (const path of ['/app/admin', '/app/admin/finanzas/cuentas', '/api/push-subscriptions']) {
    let intercepted = false;
    sw.handlers.fetch({ request: { method: 'GET', url: 'https://vivo.test' + path }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

function subscriptionsRoute({ actor = 'admin', roleError = false } = {}) {
  const calls = [];
  const supabase = {
    auth: { getUser: async token => token === 'valid' ? { data: { user: { id: 'verified-user' } }, error: null } : { data: {}, error: { message: 'invalid' } } },
    from(table) {
      const chain = {
        select() { return chain; },
        eq(key, value) { calls.push({ table, key, value }); return chain; },
        maybeSingle: async () => ({ data: actor === 'admin' ? { user_id: 'verified-user' } : null, error: roleError ? { message: 'failed' } : null }),
        upsert: async (payload, options) => { calls.push({ table, payload, options }); return { error: null }; },
        delete() { return chain; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return chain;
    },
  };
  const exports = {};
  const source = ts.transpileModule(read('src/app/api/push-subscriptions/route.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, {
    exports, process: { env: { SUPABASE_URL: 'https://local.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake-key' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (payload, options) => ({ payload, status: options?.status ?? 200 }) } };
      if (name === '@supabase/supabase-js') return { createClient: () => supabase };
      if (name === '@/lib/push') return { normalizePushSubscription: value => value?.endpoint && value?.keys ? value : null };
      throw new Error(name);
    },
  });
  const request = body => ({ json: async () => body, headers: { get: () => 'Unit test' } });
  const subscription = { endpoint: 'https://push.test/admin', keys: { p256dh: 'fake-key', auth: 'fake-auth' } };
  return { route: exports, request, subscription, calls };
}

test('subscription API rejects anonymous and invalid sessions before any write', async () => {
  const h = subscriptionsRoute();
  assert.equal((await h.route.POST(h.request({ scope: 'admin' }))).status, 401);
  assert.equal((await h.route.POST(h.request({ accessToken: 'invalid', scope: 'admin', subscription: h.subscription }))).status, 401);
  assert.equal(h.calls.length, 0);
});

test('Advisor cannot impersonate Admin scope and role lookup errors fail closed', async () => {
  for (const options of [{ actor: 'advisor' }, { roleError: true }]) {
    const h = subscriptionsRoute(options);
    assert.equal((await h.route.POST(h.request({ accessToken: 'valid', scope: 'admin', subscription: h.subscription, roles: ['admin'] }))).status, 403);
    assert.ok(h.calls.every(call => !call.payload));
  }
});

test('Admin subscription binds the verified user, never a user ID supplied by the browser', async () => {
  const h = subscriptionsRoute();
  assert.equal((await h.route.POST(h.request({ accessToken: 'valid', scope: 'admin', user_id: 'victim', subscription: h.subscription }))).status, 200);
  const saved = h.calls.find(call => call.payload);
  assert.equal(saved.payload.user_id, 'verified-user');
  assert.equal(saved.payload.scope, 'admin');
  assert.equal(saved.options.onConflict, 'endpoint');
});

test('deactivation is limited to the verified user and specified endpoint', async () => {
  const h = subscriptionsRoute();
  assert.equal((await h.route.DELETE(h.request({ accessToken: 'valid', subscription: h.subscription }))).status, 200);
  assert.ok(h.calls.some(call => call.key === 'user_id' && call.value === 'verified-user'));
  assert.ok(h.calls.some(call => call.key === 'endpoint' && call.value === h.subscription.endpoint));
});

test('automatic registrar never prompts, subscribes or sends test notifications', () => {
  const registrar = read('src/app/app/admin/AdminPwaRegistrar.tsx');
  assert.doesNotMatch(registrar, /requestPermission|pushManager.subscribe|push-notifications\/test|setInterval|router.refresh/);
  assert.match(registrar, /data.session\?\.user.id !== userId/);
  const install = read('src/components/notifications/PwaInstallProvider.tsx');
  assert.match(install, /beforeinstallprompt/);
  assert.match(install, /Añadir a pantalla de inicio/);
  assert.match(install, /16.4/);
  const push = read('src/components/notifications/OperationsPushPanel.tsx');
  assert.match(push, /scope: workspace, endpoint: subscription\?\.endpoint/);
  assert.match(push, /permission !== 'granted'/);
});

test('logout detaches only the Admin device, even if the server returns an error', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalFetch = globalThis.fetch;
  let unsubscribed = 0;
  const requests = [];
  const subscription = { toJSON: () => ({ endpoint: 'https://push.test/admin' }), unsubscribe: async () => { unsubscribed++; } };
  let scope = 'https://vivo.test/app/';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    serviceWorker: { getRegistration: async () => ({ scope, pushManager: { getSubscription: async () => subscription } }) },
  } });
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: false }; };
  try {
    await detachAdminPush('test-token');
    assert.equal(unsubscribed, 0);
    scope = 'https://vivo.test/app/admin';
    await detachAdminPush('test-token');
    assert.equal(unsubscribed, 1);
    assert.equal(JSON.parse(requests[0].options.body).scope, 'admin');
    assert.equal(requests[0].options.method, 'DELETE');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('stored Admin scope is reauthorized at delivery and tests select only the current device', () => {
  const sender = read('src/lib/push.ts');
  assert.match(sender, /rows.some\(row => row.scope === 'admin'\)/);
  assert.match(sender, /roleError \|\| !role\) subscriptions = rows.filter\(row => row.scope !== 'admin'\)/);
  const route = read('src/app/api/push-notifications/test/route.ts');
  assert.match(route, /\.eq\('user_id', userRes.user.id\)/);
  assert.match(route, /subscriptionsQuery.eq\('scope', scope\)/);
  assert.match(route, /subscriptionsQuery.eq\('endpoint', body.endpoint\)/);
  assert.match(route, /roleError \|\| !role/);
  assert.match(route, /pushUrlForSubscription\(testPayload.url, row.scope, testPayload.tag\)/);
});
