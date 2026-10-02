import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currencyLabel } from '../../src/lib/ui/currency-label.ts';
import { normalizeCollectionFilters } from '../../src/lib/admin-finance/collections-model.ts';
import { buildAdminFinancePeriod } from '../../src/lib/admin-finance/period.ts';
import { buildCommercialSummary, buildTreasurySummary, buildPositionSummary } from '../../src/lib/admin-finance/model.ts';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const linkStub = new URL('tests/admin/__compact_link_stub.mjs', root).href;
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: object) => void;
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: object) => { url: string }) {
    if (specifier === 'next/link') return { url: linkStub, shortCircuit: true };
    if (specifier === 'next/navigation') return { url: 'data:text/javascript,' + encodeURIComponent("export function usePathname(){return '/app/admin/finanzas/resumen';} export function useSearchParams(){return new URLSearchParams();}"), shortCircuit: true };
    if (specifier.startsWith('@/') || specifier.startsWith('.')) {
      const url = specifier.startsWith('@/') ? new URL('src/' + specifier.slice(2), root) : new URL(specifier, context.parentURL);
      for (const extension of ['.ts', '.tsx']) if (existsSync(fileURLToPath(url) + extension)) return next(url.href + extension, context);
    }
    return next(specifier, context);
  },
  load(url: string, context: object, next: (url: string, context: object) => { format?: string; source?: string | ArrayBufferView | null }) {
    if (url === linkStub) return { format: 'module', shortCircuit: true, source: "import {createElement} from 'react'; export default function Link({prefetch,...props}){return createElement('a',{...props,'data-prefetch':String(prefetch)});}" };
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return next(url, context);
  },
});

const { default: Dashboard } = await import('../../src/app/app/admin/_components/FinancialDashboard.tsx');
const { default: CollectionFilters } = await import('../../src/app/app/admin/finanzas/cobranzas/_components/CollectionFiltersForm.tsx');
const { default: InventoryProducts } = await import('../../src/app/app/inventory/products/InventoryProductsClient.tsx');
const period = buildAdminFinancePeriod('week', new Date('2026-10-02T16:00:00Z'));
const overview = {
  definitionVersion: 'admin-finance-v1' as const, period,
  commercial: { status: 'ready' as const, data: buildCommercialSummary({ period, deliveredEvents: [], deliveredOrders: [], scheduledOrders: [] }) },
  treasury: { status: 'ready' as const, data: buildTreasurySummary({ period, confirmedMovements: [], pendingPaymentReports: [], pendingMovements: [] }) },
  position: { status: 'ready' as const, data: buildPositionSummary({ activeRate: null, accounts: [], profiles: [], baselines: [], closures: [], reconciliations: [], clientBalances: [], clientFundMovements: [] }) },
};

test('currency labels are persistent, human-readable and never assume dollars for an unknown account', () => {
  assert.equal(currencyLabel('USD'), 'USD');
  assert.equal(currencyLabel('VES'), 'Bs');
  assert.equal(currencyLabel(null), 'selecciona cuenta');
  assert.equal(currencyLabel(undefined), 'selecciona cuenta');
  assert.equal(currencyLabel(''), 'selecciona cuenta');
  assert.equal(currencyLabel('EUR'), 'EUR');
});

test('order price editor permanently labels both units and preserves precise pricing handlers', () => {
  const editor = read('src/app/app/master/ops/MasterOpsOrderEditor.tsx');
  assert.match(editor, /<Field label="Precio unitario · USD">/);
  assert.match(editor, /<Field label="Precio unitario · Bs">/);
  assert.match(editor, /updateItemOverride\(item, "USD", event.target.value\)/);
  assert.match(editor, /updateItemOverride\(item, "VES", event.target.value\)/);
  assert.match(editor, /compact\(item.sourcePriceAmount, 6\)/);
  assert.match(editor, /Monto que entrega · \$\{currencyLabel\(form.paymentChangeCurrency\)\}/);
});

test('payments, refunds and rate fields have visible currency labels, not placeholder-only labels', () => {
  const orders = read('src/components/orders/OrdersWorkspaceClient.tsx');
  assert.equal((orders.match(/Monto · \{currencyLabel\(account\?\.currencyCode\)\}/g) ?? []).length, 3);
  assert.equal((orders.match(/Tasa · Bs\/USD/g) ?? []).length, 3);
  assert.match(orders, /Monto · \{currencyLabel\(selectedPaymentAccount\?\.currencyCode\)\}/);
  assert.match(orders, /selectedPaymentAccount.currencyCode === "VES" \? `Pendiente \$\{formatMasterOrderBs/);
  const movement = read('src/app/app/admin/finanzas/cuentas/movimiento/AdminMovementForm.tsx');
  assert.match(movement, /Comisión bancaria · \$\{currencyLabel\(account\?\.currencyCode\)\}/);
  const catalog = read('src/components/admin/CatalogPricesForm.tsx');
  assert.match(catalog, /Precio · \{currencyLabel\(r.currency\)\}/);
});

test('closure does not silently select a bank and does not start a balance read until an account is chosen', () => {
  const closure = read('src/app/app/admin/finanzas/cuentas/cierre/ClosureForm.tsx');
  assert.match(closure, /useState\(initialAccountId \?\? 0\)/);
  assert.match(closure, /if \(!accountId\) return/);
  assert.match(closure, /Selecciona una cuenta para consultar el saldo/);
  assert.doesNotMatch(closure, /accounts\[0\]/);
});

test('financial overview uses compact indicators and closed breakdowns without hiding unavailable data', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { overview, basePath: '/app/admin/finanzas/resumen', detail: true }));
  assert.match(html, /Resumen financiero/);
  assert.doesNotMatch(html, /text-(?:2xl|3xl|4xl|5xl)|Radiografía financiera|operación avanzada en transición/);
  for (const id of ['commercial-detail', 'treasury-detail', 'position-detail']) {
    assert.match(html, new RegExp('<details[^>]*id="' + id + '"[^>]*>'));
    assert.doesNotMatch(html, new RegExp('<details[^>]*id="' + id + '"[^>]* open'));
    assert.match(html, new RegExp('/app/admin/finanzas/resumen\\?period=week[^"]*#' + id));
  }
  assert.match(html, /No disponible/);
  assert.match(html, /Cómo se calcula/);
});

test('all financial destinations stay in Admin and disable speculative prefetch', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { overview, basePath: '/app/admin/finanzas/resumen', detail: true }));
  assert.doesNotMatch(html, /href="\/app\/master/);
  assert.doesNotMatch(html, /href="[^"]+"(?![^>]*data-prefetch="false")[^>]*>/);
  assert.match(html, /autorizaciones\?tipo=payment/);
});

test('advanced collection filters remain submitted, preserve active values and never query on render', () => {
  const filters = normalizeCollectionFilters({ from: '2026-09-07', to: '2026-09-13', source: 'master', fulfillment: 'pickup', role: 'admin', basis: 'delivered' });
  const html = renderToStaticMarkup(createElement(CollectionFilters, { filters, people: [], todayIso: '2026-10-02T16:00:00Z' }));
  for (const key of ['from', 'to', 'status', 'person', 'basis', 'personBasis', 'source', 'fulfillment', 'role', 'stage', 'sort', 'q', 'scope']) assert.match(html, new RegExp('name="' + key + '"'));
  assert.match(html, /<details open/);
  assert.match(html, /value="master" selected/);
  assert.match(html, /value="pickup" selected/);
  assert.match(html, /<button(?=[^>]*name="action")(?=[^>]*value="query")[^>]*>/);
  assert.match(html, /<button(?=[^>]*name="action")(?=[^>]*value="people")(?=[^>]*formNoValidate)[^>]*>/);
  assert.doesNotMatch(read('src/app/app/admin/finanzas/cobranzas/_components/CollectionFiltersForm.tsx'), /useEffect|supabase|\.rpc\(/);
});

test('advanced filters start collapsed for an ordinary collection query', () => {
  const html = renderToStaticMarkup(createElement(CollectionFilters, { filters: normalizeCollectionFilters({}), people: [], todayIso: '2026-10-02T16:00:00Z' }));
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details open/);
});

test('inventory renders only thirty rows per view and exposes mobile details without a wide table', () => {
  const products = Array.from({ length: 75 }, (_, index) => ({ id: index + 1, sku: null, name: 'Producto ' + (index + 1), productType: 'product', isActive: true, inventoryPolicy: 'none' as const, configurationStatus: 'ready' as const, allowsHalfService: false, componentCount: 0, links: [] }));
  const html = renderToStaticMarkup(createElement(InventoryProducts, { products }));
  assert.match(html, /Página 1 de 3/);
  assert.match(html, /Producto 30/);
  assert.doesNotMatch(html, /Producto 31|Producto 75|min-w-\[1080px\]/);
  assert.equal((html.match(/<details/g) ?? []).length, 30);
  assert.match(html, /hidden overflow-x-auto lg:block/);
});

test('sidebar wraps names, shared headings are compact and mobile targets remain touch-sized', () => {
  assert.match(read('src/app/app/admin/_components/AdminNavigation.tsx'), /whitespace-normal break-words font-medium/);
  assert.match(read('src/app/globals.css'), /admin-workspace h1 \{ font-size: 1rem/);
  assert.match(read('src/components/ui/QueryControls.tsx'), /min-h-11[\s\S]*md:min-h-8/);
  assert.doesNotMatch(read('src/app/app/master/plays/MasterPlaysClient.tsx'), /#777785|#666675/);
});

test('order dialogs share stacked focus containment, named close controls and mobile progressive navigation', () => {
  const detail = read('src/components/orders/OrdersWorkspaceClient.tsx'), editor = read('src/app/app/master/ops/MasterOpsOrderEditor.tsx'), hook = read('src/components/ui/useDialogFocus.ts');
  for (const source of [detail, editor]) {
    assert.match(source, /useDialogFocus/);
    assert.match(source, /role="dialog" aria-modal="true"/);
    assert.match(source, /data-dialog-close/);
  }
  assert.match(hook, /event.key === 'Escape'/);
  assert.match(hook, /event.key !== 'Tab'/);
  assert.match(hook, /dialogs.at\(-1\) === dialog/);
  assert.match(hook, /previous\?\.isConnected/);
  assert.match(detail, /Seguimiento ·/);
  assert.match(detail, /group\/more/);
  assert.match(detail, /Cerrar detalle de orden/);
});
