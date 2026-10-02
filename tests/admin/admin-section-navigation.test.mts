import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  activeAdminNavigationGroup, activeAdminNavigationKey, adminNavigation, mobileAdminNavigation,
} from '../../src/app/app/admin/_lib/navigation.ts';

const root = new URL('../../', import.meta.url);
const linkStub = new URL('tests/admin/__hub_link_stub.mjs', root).href;
const navigationStub = 'data:text/javascript,' + encodeURIComponent(`
let pathname = '/app/admin';
export function usePathname(){ return pathname; }
export function useSearchParams(){ return new URLSearchParams(); }
export function setPathname(value){ pathname = value; }
export function redirect(href){ throw new Error('REDIRECT:' + href); }
`);
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: {
  resolve: (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => { url: string; shortCircuit?: boolean }) => { url: string; shortCircuit?: boolean };
  load: (url: string, context: object, next: (url: string, context: object) => { format?: string; source?: string | ArrayBufferView | null; shortCircuit?: boolean }) => { format?: string; source?: string | ArrayBufferView | null; shortCircuit?: boolean };
}) => void;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/link') return { url: linkStub, shortCircuit: true };
    if (specifier === 'next/navigation') return { url: navigationStub, shortCircuit: true };
    if (specifier === '@/components/navigation/ContextLink') return nextResolve(new URL('src/components/navigation/ContextLink.tsx', root).href, context);
    if (specifier.startsWith('@/')) return nextResolve(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    if (specifier === '../_lib/navigation') return nextResolve(`${specifier}.ts`, context);
    if (specifier === '../_components/AdminSectionHub') return nextResolve(`${specifier}.tsx`, context);
    if (specifier === './return-navigation' && context.parentURL?.endsWith('/admin-workspace.ts')) return nextResolve('./return-navigation.ts', context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === linkStub) return {
      format: 'module', shortCircuit: true,
      source: `import { createElement } from 'react'; export default function Link({prefetch, ...props}) { return createElement('a', {...props, 'data-prefetch': String(prefetch)}); }`,
    };
    if (url.endsWith('.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { default: Navigation } = await import('../../src/app/app/admin/_components/AdminNavigation.tsx');
const { default: Hub } = await import('../../src/app/app/admin/_components/AdminSectionHub.tsx');
const { default: FinancePage } = await import('../../src/app/app/admin/finanzas/page.tsx');
const { setPathname } = await import(navigationStub);

test('mobile navigation has the same four primary areas as desktop', () => {
  assert.deepEqual(mobileAdminNavigation.map((item) => item.key), ['home', 'operations', 'finance', 'business']);
  assert.ok(adminNavigation.every((item) => item.prefetch === false));
});

test('selects the most specific administrative destination and its actual group', () => {
  assert.equal(activeAdminNavigationKey('/app/admin'), 'home');
  assert.equal(activeAdminNavigationGroup('/app/admin'), undefined);
  assert.equal(activeAdminNavigationGroup('/app/admin/finanzas/pedidos'), 'operations');
  assert.equal(activeAdminNavigationKey('/app/admin/finanzas/cuentas/8'), 'accounts');
  assert.equal(activeAdminNavigationGroup('/app/admin/finanzas/cuentas/8'), 'finance');
  assert.equal(activeAdminNavigationGroup('/app/admin/herramientas'), 'business');
  assert.equal(activeAdminNavigationKey('/app/admin/ordenes-fake'), undefined);
  assert.equal(activeAdminNavigationKey('/app/master/dashboard'), undefined);
});

test('desktop groups start closed at home and only the current group opens on deep routes', () => {
  setPathname('/app/admin');
  const home = renderToStaticMarkup(createElement(Navigation, { variant: 'desktop' }));
  assert.equal((home.match(/<details/g) ?? []).length, 3);
  assert.doesNotMatch(home, /<details[^>]* open=/);
  setPathname('/app/admin/finanzas/cuentas/8');
  const accounts = renderToStaticMarkup(createElement(Navigation, { variant: 'desktop' }));
  assert.equal((accounts.match(/<details[^>]* open=/g) ?? []).length, 1);
  const accountLink = (accounts.match(/<a\b[^>]*>/g) ?? []).find((link) => /href="\/app\/admin\/finanzas\/cuentas\?/.test(link));
  assert.match(accountLink ?? '', /aria-current="page"/);
  assert.doesNotMatch(accounts, /Panel anterior|\/app\/master\/dashboard|data-prefetch="true"/);
  const source = readFileSync(new URL('src/app/app/admin/_components/AdminNavigation.tsx', root), 'utf8');
  assert.ok(source.includes('key={`${group.key}:${pathname}`}'), 'A different route must reopen its active group after a manual collapse');
});

test('mobile keeps its finance area active on account detail without falsely calling it the current page', () => {
  setPathname('/app/admin/finanzas/cuentas/8');
  const html = renderToStaticMarkup(createElement(Navigation, { variant: 'mobile' }));
  assert.match(html, /aria-label="Finanzas" aria-current="location"/);
  assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
});

test('hubs render bounded links only; opening a group cannot import another domain loader', () => {
  for (const section of ['operations', 'finance', 'business'] as const) {
    const html = renderToStaticMarkup(createElement(Hub, { section }));
    assert.doesNotMatch(html, /data-prefetch="true"|<table|<iframe|Panel anterior/);
    assert.match(html, /text-sm font-medium/);
  }
  for (const file of ['_components/AdminSectionHub.tsx', '_components/AdminNavigation.tsx', 'operaciones/page.tsx', 'negocio/page.tsx', 'finanzas/page.tsx']) {
    const source = readFileSync(new URL(`src/app/app/admin/${file}`, root), 'utf8');
    assert.doesNotMatch(source, /loadAdmin|supabase|setInterval|useEffect|FinancialDashboard|master\/dashboard\/actions/);
  }
});

test('finance entry exposes actual income, expense, closure and transfer actions without fetching figures', async () => {
  setPathname('/app/admin/finanzas');
  const html = renderToStaticMarkup(await FinancePage({}));
  for (const label of ['Ingreso', 'Egreso', 'Cierre de caja', 'Transferencia', 'Cuentas y caja', 'Resumen financiero']) assert.ok(html.includes(label));
  assert.match(html, /movimiento\?tipo=inflow&amp;returnTo=/);
  assert.match(html, /movimiento\?tipo=outflow&amp;returnTo=/);
  assert.match(html, /href="\/app\/admin\/finanzas\/resumen\?returnTo=/);
  assert.doesNotMatch(html, /data-prefetch="true"/);
});

test('old dated snapshot URLs keep all filters and return context when routed to the separate summary', async () => {
  const params = { period: 'week', asOf: '2026-10-01T15:00:00Z', definition: 'admin-finance-v1', returnTo: '/app/admin/ordenes?date=2026-10-01', tag: ['one', 'two'] };
  await assert.rejects(() => FinancePage({ searchParams: Promise.resolve(params) }), (error: Error) => {
    const url = new URL(error.message.replace('REDIRECT:', ''), 'https://vivo.test');
    assert.equal(url.pathname, '/app/admin/finanzas/resumen');
    for (const key of ['period', 'asOf', 'definition', 'returnTo'] as const) assert.equal(url.searchParams.get(key), params[key]);
    assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
    return true;
  });
});

test('removes routine legacy panel links while preserving the legacy module selector entry', () => {
  for (const file of ['src/app/app/admin/_components/ExecutiveDashboard.tsx', 'src/components/orders/OrdersWorkspaceClient.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /Panel anterior/);
  }
  assert.match(readFileSync(new URL('src/lib/app-modules.ts', root), 'utf8'), /key: 'admin-legacy'[\s\S]*?href: '\/app\/master\/dashboard'/);
});
