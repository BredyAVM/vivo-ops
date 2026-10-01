import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAdminExecutiveKpiOverview } from '../../src/lib/admin-finance/executive-model.ts';
import { buildTreasurySummary } from '../../src/lib/admin-finance/model.ts';

const root = new URL('../../', import.meta.url);
const linkStub = new URL('tests/admin/__executive_link_stub.mjs', root).href;

const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: {
  resolve: (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => { url: string; shortCircuit?: boolean }) => { url: string; shortCircuit?: boolean };
  load: (url: string, context: object, next: (url: string, context: object) => { format?: string; source?: string | ArrayBufferView | null; shortCircuit?: boolean }) => { format?: string; source?: string | ArrayBufferView | null; shortCircuit?: boolean };
}) => void;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/link') return { url: linkStub, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`src/${specifier.slice(2)}.ts`, root).href, context);
    }
    if (specifier === './ExecutiveTrendChart') return nextResolve(`${specifier}.tsx`, context);
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

// Actual server components, deterministic data, and no authenticated/database access.
const { default: Dashboard } = await import('../../src/app/app/admin/_components/ExecutiveDashboard.tsx');
const data = buildAdminExecutiveKpiOverview({
  orders: [], financialStates: [], asOf: new Date('2026-09-30T16:00:00Z'),
});
const unavailable = { status: 'error' as const, message: 'No disponible' };
const finance = {
  definitionVersion: 'admin-finance-v1' as const,
  period: { key: 'week' as const, label: 'Semana', startKey: '2026-09-28', endExclusiveKey: '2026-10-01', fullEndExclusiveKey: '2026-10-05', previousStartKey: '2026-09-21', previousEndExclusiveKey: '2026-09-24', asOf: data.asOf },
  commercial: unavailable, treasury: unavailable, position: unavailable,
};

export function renderExecutivePreview() {
  const preview = structuredClone(data);
  preview.today = { ...preview.today, billedUsd: 825.25, closures: 24, coveredUsd: 712.25, pendingUsd: 113, deliveries: 18, deliveriesCompleted: 14, deliveriesPending: 4 };
  preview.week = { ...preview.week, billedUsd: 3240.25, closures: 96, coveredUsd: 2840.25, pendingUsd: 400, deliveries: 70 };
  preview.historicalAverage.todayBilledUsd = 760;
  preview.historicalAverage.todayClosures = 22;
  preview.trend = preview.trend.map((point, index) => ({ ...point, currentBilledUsd: index <= 2 ? [1100, 2415, 3240.25][index] : null, historicalBilledUsd: [1000, 2150, 2980, 4150, 5300, 6650, 7400][index] }));
  preview.operational.today = { closures: 24, commercialNetUsd: 825.25, confirmedPaidUsd: 712.25, pendingUsd: 113, financialStatesComplete: true };
  preview.operational.week = { closures: 96, commercialNetUsd: 3240.25, confirmedPaidUsd: 2840.25, pendingUsd: 400, financialStatesComplete: true };
  preview.operational.trend = preview.trend;
  return renderToStaticMarkup(createElement(Dashboard, { executive: { status: 'ready', data: preview }, finance }));
}

test('renders KPIs and chart before the closed module directory', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { executive: { status: 'ready', data }, finance }));
  assert.ok(html.indexOf('Indicadores principales') < html.indexOf('Facturación semanal'));
  assert.ok(html.indexOf('Facturación semanal') < html.indexOf('Todos los módulos'));
  assert.match(html, /<details id="centros"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(html, /Ver cifras por día/);
  assert.doesNotMatch(html, /min-w-\[520px\]/);
});

test('keeps financial errors distinct from zero pending tasks', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { executive: { status: 'ready', data }, finance }));
  for (const label of ['Pagos por revisar', 'Movimientos', 'Conciliaciones']) {
    assert.match(html, new RegExp(`${label}</span><span[^>]*title="No disponible"[^>]*>—</span>`));
  }
});

test('exposes direct income, expense and closure actions without prefetching destinations', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { executive: { status: 'ready', data }, finance }));
  assert.match(html, /href="\/app\/admin\/finanzas\/cuentas\/movimiento\?tipo=inflow"[^>]*data-prefetch="false"/);
  assert.match(html, /href="\/app\/admin\/finanzas\/cuentas\/movimiento\?tipo=outflow"[^>]*data-prefetch="false"/);
  assert.match(html, /href="\/app\/admin\/finanzas\/cuentas\/cierre"[^>]*data-prefetch="false"/);
  assert.match(html, /Jugadas \/ CRM/);
});

test('keeps modules reachable when the sales summary is unavailable', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { executive: unavailable, finance }));
  assert.match(html, /Indicadores no disponibles/);
  assert.match(html, /Ingreso \/ Egreso/);
  assert.match(html, /Todos los módulos/);
});

test('shows canonical weekly cash flows without conflating them with delivered sales', () => {
  const treasury = buildTreasurySummary({
    period: finance.period, pendingMovements: [], pendingPaymentReports: [],
    confirmedMovements: [
      { id: 1, movement_date: '2026-09-30', direction: 'inflow', movement_type: 'order_payment', amount_usd_equivalent: 15, movement_group_id: null },
      { id: 2, movement_date: '2026-09-30', direction: 'inflow', movement_type: 'other_income', amount_usd_equivalent: 5, movement_group_id: null },
      { id: 3, movement_date: '2026-09-30', direction: 'outflow', movement_type: 'expense_payment', amount_usd_equivalent: 3, movement_group_id: null },
    ],
  });
  const html = renderToStaticMarkup(createElement(Dashboard, {
    executive: { status: 'ready', data },
    finance: { ...finance, treasury: { status: 'ready', data: treasury } },
  }));
  const flow = html.split('aria-label="Flujo de caja semanal"')[1].split('</section>')[0];
  const currency = new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD' });
  for (const amount of [20, 3, 17]) assert.ok(flow.includes(currency.format(amount)));
  assert.doesNotMatch(flow, /Flujo no disponible|ganancia|utilidad/);
  assert.match(html, /Pagos por revisar<\/span><span[^>]*>0<\/span>/);
});
