import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getKitchenShiftDateBounds,
  getKitchenDayRange,
  isKitchenShiftCode,
  kitchenIncidentStatusFromLifecycle,
  kitchenOrderPriority,
  kitchenPrepMetric,
  kitchenShiftLabel,
  summarizeKitchenPrepMetrics,
} from '../../src/lib/kitchen/operations.ts';
import { getKitchenItemPresentation, type KitchenComponent, type KitchenPresentationItem } from '../../src/lib/kitchen/order-presentation.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KitchenOrder } from '../../src/app/app/kitchen/KitchenClient.tsx';

const packComponents: KitchenComponent[] = [
  { productId: 5, name: 'Mini Tequeños Fritos', mode: 'selectable', quantity: 1, required: true, countsTowardLimit: true, isNested: false },
  { productId: 11, name: 'Cachitas Fritas', mode: 'selectable', quantity: 1, required: true, countsTowardLimit: true, isNested: false },
  { productId: 2, name: 'Salsa Tártara 1oz', mode: 'fixed', quantity: 1, required: false, countsTowardLimit: false, isNested: false },
];
const comboComponents: KitchenComponent[] = [
  [5, 'Mini Tequeños Fritos'], [8, 'Empanadas Fritas'], [11, 'Cachitas Fritas'],
  [14, 'Mandocas Fritas'], [17, 'Bombys Fritos'], [24, 'Salsa Tártara 5oz'],
].map(([id, name]) => ({
  productId: Number(id), name: String(name), mode: 'fixed', quantity: id === 24 ? 1 : 10,
  required: true, countsTowardLimit: false, isNested: false,
}));
const packInput = (qty: number, notes: string): KitchenPresentationItem => ({
  qty, name: 'Single Pack (10 und)', notes, unitsPerService: 0,
  composition: { editable: true, detailLimit: 10, components: packComponents, snapshots: [] },
});
const comboInput = (qty: number, metadata = true): KitchenPresentationItem => ({
  qty, name: 'Combo Sexy Mix Frito (50 und)', unitsPerService: 0,
  notes: comboComponents.flatMap(c => [
    `${qty * c.quantity} ${c.name}`, ...(metadata ? [`@sel|${c.productId}|${qty * c.quantity}`] : []),
  ]).join('\n'),
  composition: { editable: false, detailLimit: 50, components: comboComponents, snapshots: [] },
});

test('prioritizes modified, incident and late kitchen orders in that order', () => {
  assert.equal(kitchenOrderPriority({
    hasPendingChanges: true,
    hasPendingIncident: true,
    remainingPrepMinutes: -12,
  }), 0);
  assert.equal(kitchenOrderPriority({
    hasPendingChanges: false,
    hasPendingIncident: true,
    remainingPrepMinutes: -12,
  }), 1);
  assert.equal(kitchenOrderPriority({
    hasPendingChanges: false,
    hasPendingIncident: false,
    remainingPrepMinutes: -1,
  }), 2);
  assert.equal(kitchenOrderPriority({
    hasPendingChanges: false,
    hasPendingIncident: false,
    remainingPrepMinutes: 0,
  }), 3);
});

test('derives the Kitchen-visible lifecycle from canonical incident events', () => {
  assert.equal(kitchenIncidentStatusFromLifecycle(null), 'reported');
  assert.equal(kitchenIncidentStatusFromLifecycle('kitchen_incident_reviewed'), 'reviewed');
  assert.equal(kitchenIncidentStatusFromLifecycle('kitchen_incident_resolved'), 'resolved');
  assert.equal(kitchenIncidentStatusFromLifecycle('kitchen_incident_reopened'), 'reopened');
});

test('preserves historical shift codes without exposing numbered shifts', () => {
  assert.equal(isKitchenShiftCode('shift_1'), true);
  assert.equal(isKitchenShiftCode('shift_2'), true);
  assert.equal(isKitchenShiftCode('shift_3'), false);
  assert.equal(kitchenShiftLabel('shift_1'), 'Conteo por turno');
  assert.equal(kitchenShiftLabel('shift_2'), 'Conteo por turno');
  assert.equal(kitchenShiftLabel(null), 'Conteo por turno');
});

test('computes operating dates in Caracas rather than the machine timezone', () => {
  const bounds = getKitchenShiftDateBounds(new Date('2026-08-11T02:30:00.000Z'));
  assert.deepEqual(bounds, { min: '2026-08-09', max: '2026-08-10' });
});

test('builds the canonical Caracas day range', () => {
  assert.deepEqual(getKitchenDayRange('2026-08-11'), {
    startISO: '2026-08-11T04:00:00.000Z',
    endISO: '2026-08-12T04:00:00.000Z',
  });
  assert.throws(() => getKitchenDayRange('2026-02-31'));
});

test('measures preparation against the ETA committed by Kitchen', () => {
  const onTime = kitchenPrepMetric({
    startedAt: '2026-08-11T14:00:00.000Z',
    readyAt: '2026-08-11T14:18:00.000Z',
    etaMinutes: 20,
  });
  const late = kitchenPrepMetric({
    startedAt: '2026-08-11T15:00:00.000Z',
    readyAt: '2026-08-11T15:15:00.000Z',
    etaMinutes: 10,
  });

  assert.deepEqual(onTime, {
    actualMinutes: 18,
    committedMinutes: 20,
    varianceMinutes: -2,
    onTime: true,
  });
  assert.equal(late?.varianceMinutes, 5);
  assert.equal(late?.onTime, false);
  assert.deepEqual(summarizeKitchenPrepMetrics([onTime!, late!]), {
    measuredCount: 2,
    committedCount: 2,
    averageActualMinutes: 16.5,
    averageVarianceMinutes: 1.5,
    onTimePct: 50,
  });
});

test('order 1828 reads stored totals and confirms historical per-pack notes without multiplying again', () => {
  const presentation = getKitchenItemPresentation({
    qty: 2,
    name: 'Single Pack (10 und)',
    unitsPerService: 0,
    notes: [
      '5 Mini Tequeños Fritos',
      '@sel|5|5',
      '5 Cachitas Fritas',
      '@sel|11|5',
      '1 Salsa Tártara 1oz',
      '@sel|2|1',
    ].join('\n'),
    composition: {
      editable: true, detailLimit: 10, components: packComponents,
      snapshots: [
        { productId: 5, name: 'Mini Tequeños Fritos', qty: 10 },
        { productId: 11, name: 'Cachitas Fritas', qty: 10 },
        { productId: 2, name: 'Salsa Tártara 1oz', qty: 2 },
      ],
    },
  });

  assert.equal(presentation.repeatsSameConfiguration, true);
  assert.equal(presentation.totalUnits, 20);
  assert.equal(presentation.preparedUnits, 20);
  assert.equal(presentation.quantityWarning, null);
  assert.deepEqual(
    presentation.detailLines.map((line) => ({
      label: line.label,
      qty: line.qty,
      qtyPerPresentation: line.qtyPerPresentation,
    })),
    [
      { label: 'Mini Tequeños Fritos', qty: 10, qtyPerPresentation: 5 },
      { label: 'Cachitas Fritas', qty: 10, qtyPerPresentation: 5 },
      { label: 'Salsa Tártara 1oz', qty: 2, qtyPerPresentation: 1 },
    ],
  );
});

test('does not multiply fixed combo details that already contain order totals', () => {
  const presentation = getKitchenItemPresentation(comboInput(2, false));

  assert.equal(presentation.repeatsSameConfiguration, true);
  assert.equal(presentation.totalUnits, 100);
  assert.equal(presentation.preparedUnits, 100);
  assert.equal(presentation.detailLines[0]?.qty, 20);
  assert.equal(presentation.detailLines[0]?.qtyPerPresentation, 10);
  assert.equal(presentation.quantityWarning, null);
});

test('order 2621 matches the actual inventory exit: 150 pieces and 3 sauces, not 450 and 9', () => {
  const presentation = getKitchenItemPresentation(comboInput(3));
  assert.deepEqual(presentation.detailLines.map(line => line.qty), [30, 30, 30, 30, 30, 3]);
  assert.deepEqual(presentation.detailLines.map(line => line.qtyPerPresentation), [10, 10, 10, 10, 10, 1]);
  assert.equal(presentation.totalUnits, 150);
  assert.equal(presentation.preparedUnits, 150);
  assert.equal(presentation.quantityWarning, null);
});

test('current multi-packs read aggregate choices, without inventing identical distribution', () => {
  const presentation = getKitchenItemPresentation(packInput(2, '10 Mini Tequeños Fritos\n@sel|5|10\n10 Cachitas Fritas\n@sel|11|10\n2 Salsa Tártara 1oz\n@sel|2|2'));
  assert.deepEqual(presentation.detailLines.map(line => line.qty), [10, 10, 2]);
  assert.equal(presentation.preparedUnits, 20);
  assert.equal(presentation.quantityWarning, null);
  assert.equal(presentation.repeatsSameConfiguration, false);
  assert.ok(presentation.detailLines.every(line => line.qtyPerPresentation === null));
  assert.match(presentation.assemblyNote!, /reparto por presentación/);
});

test('separate packs keep their own configuration, aliases and quantities', () => {
  const presentations = [
    packInput(1, 'Para: A\n10 Mini Tequeños Fritos\n@sel|5|10'),
    packInput(1, 'Para: B\n10 Cachitas Fritas\n@sel|11|10'),
  ].map(getKitchenItemPresentation);
  assert.equal(presentations.reduce((sum, p) => sum + p.preparedUnits, 0), 20);
  assert.deepEqual(presentations.map(p => p.detailLines[0].label), ['Mini Tequeños Fritos', 'Cachitas Fritas']);
  assert.deepEqual(presentations.map(p => p.detailLines.at(-1)?.label), ['Para: A', 'Para: B']);
  assert.ok(presentations.every(p => !p.quantityWarning && !p.assemblyNote));
});

test('legacy per-pack notes without authoritative totals are flagged, not guessed', () => {
  const presentation = getKitchenItemPresentation(packInput(2, '5 Mini Tequeños Fritos\n@sel|5|5\n5 Cachitas Fritas\n@sel|11|5\n1 Salsa Tártara 1oz\n@sel|2|1'));
  assert.deepEqual(presentation.detailLines.map(line => line.qty), [5, 5, 1]);
  assert.match(presentation.quantityWarning!, /10 piezas.*requieren 20/);
  assert.equal(presentation.repeatsSameConfiguration, false);
});

test('Master edits cannot silently replace conflicting stored component totals', () => {
  const input = packInput(2, '20 Cachitas Fritas\n@sel|11|20');
  input.composition!.snapshots = [{ productId: 5, qty: 20, name: 'Mini Tequeños Fritos' }];
  const presentation = getKitchenItemPresentation(input);
  assert.deepEqual(presentation.detailLines.map(line => [line.label, line.qty]), [['Mini Tequeños Fritos', 20]]);
  assert.match(presentation.quantityWarning!, /no coinciden/);
  assert.equal(presentation.repeatsSameConfiguration, false);
});

test('structured choices take precedence over a wrong visible product name or amount', () => {
  const presentation = getKitchenItemPresentation(packInput(1, '10 Mini Tequeños Fritos\n@sel|11|10'));
  assert.deepEqual(presentation.detailLines.map(line => [line.label, line.qty]), [['Cachitas Fritas', 10]]);
  assert.match(presentation.quantityWarning!, /detalle escrito difiere/);
});

test('unknown components and malformed selections require review, never silent repair', () => {
  for (const notes of ['@sel|5|-1', '@sel|5|NaN', '@sel|5|10|extra', '@sel|999|10']) {
    assert.ok(getKitchenItemPresentation(packInput(1, notes)).quantityWarning);
  }
  const unknown = getKitchenItemPresentation(packInput(1, '@sel|999|10'));
  assert.equal(unknown.detailLines[0].label, 'Componente #999');
  assert.equal(unknown.detailLines[0].qty, 10);
});

test('fixed missing choices use only the required recipe, optional sauce is not invented', () => {
  const combo = comboInput(3);
  combo.notes = null;
  assert.deepEqual(getKitchenItemPresentation(combo).detailLines.map(line => line.qty), [30, 30, 30, 30, 30, 3]);
  const pack = getKitchenItemPresentation(packInput(1, '@sel|5|10'));
  assert.deepEqual(pack.detailLines.map(line => line.qty), [10]);
  assert.equal(pack.quantityWarning, null);
});

test('fixed and optional component mismatches stay visible with a warning', () => {
  const combo = comboInput(3);
  combo.notes = combo.notes!.replace('30 Mini', '90 Mini').replace('@sel|5|30', '@sel|5|90');
  const presentation = getKitchenItemPresentation(combo);
  assert.equal(presentation.detailLines[0].qty, 90);
  assert.match(presentation.quantityWarning!, /composición fija indica 30/);
  assert.ok(getKitchenItemPresentation(packInput(1, '@sel|5|10\n@sel|2|2')).quantityWarning);
});

test('quantity checks use the contract, not a product name or promotional label', () => {
  const gift = packInput(1, '@sel|5|6\n@sel|2|1');
  gift.name = 'Single Pack (6 und)';
  gift.composition!.detailLimit = 6;
  const original = getKitchenItemPresentation(gift);
  gift.name = 'Obsequio de jugada con nombre nuevo';
  assert.deepEqual(getKitchenItemPresentation(gift), original);
  assert.equal(original.preparedUnits, 6);
  assert.equal(original.quantityWarning, null);
});

test('open-size products preserve exact choices and never infer size from their name', () => {
  const input = packInput(2, '@sel|5|13\n@sel|11|4');
  input.composition!.detailLimit = 0;
  const presentation = getKitchenItemPresentation(input);
  assert.equal(presentation.preparedUnits, 17);
  assert.equal(presentation.totalUnits, 17);
  assert.equal(presentation.quantityWarning, null);
  assert.equal(presentation.repeatsSameConfiguration, false);
});

test('half packs retain quantities without floor rounding or a second multiplier', () => {
  const presentation = getKitchenItemPresentation(packInput(0.5, '@sel|5|5\n@sel|2|0.5'));
  assert.deepEqual(presentation.detailLines.map(line => line.qty), [5, 0.5]);
  assert.equal(presentation.preparedUnits, 5);
  assert.equal(presentation.quantityWarning, null);
});

test('numeric instructions are not food and internal metadata never reaches the ticket', () => {
  const presentation = getKitchenItemPresentation(packInput(1, '2 bolsas separadas\nPara: Ana\n10 Mini Tequeños Fritos\n@sel|5|10\n@prep|fried\n@event|budget\n@crm|gift'));
  assert.equal(presentation.preparedUnits, 10);
  assert.equal(presentation.quantityWarning, null);
  assert.ok(presentation.detailLines.some(line => line.qty === null && line.label === '2 bolsas separadas'));
  assert.ok(presentation.detailLines.every(line => !line.label.startsWith('@')));
});

test('unsupported nested or unavailable compositions request review', () => {
  const input = packInput(1, '@sel|5|10');
  input.composition!.components = [{ ...packComponents[0], isNested: true }];
  assert.match(getKitchenItemPresentation(input).quantityWarning!, /anidada/);
  input.composition!.components = [];
  assert.ok(getKitchenItemPresentation(input).quantityWarning);
});

test('ordinary service instructions do not become extra units or a pack', () => {
  const p = getKitchenItemPresentation({ qty: 2, name: 'Servicio', unitsPerService: 10, notes: '2 bolsas separadas', composition: null });
  assert.equal(p.hasCountedDetails, false);
  assert.equal(p.quantityWarning, null);
  assert.equal(p.preparedUnits, 20);
  assert.equal(p.detailLines[0].qty, null);
});

test('the actual Kitchen JSX renders the same corrected quantities and review warnings on screen and ticket', () => {
  // Render the production component without running effects, auth or mutations.
  // Only framework/service boundaries are stubbed; no alternate JSX fixture.
  const source = readFileSync(new URL('../../src/app/app/kitchen/KitchenClient.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
  const require = createRequire(import.meta.url);
  const loadedModule = { exports: {} as { default: ComponentType<Record<string, unknown>> } };
  const boundaryRequire = (name: string) => {
    if (name === 'next/navigation') return { useRouter: () => ({ refresh() {} }) };
    if (name === 'next/link') return { default: ({ children, href }: { children: string; href: string }) => createElement('a', { href }, children) };
    if (name === '@/lib/supabase/browser') return { createSupabaseBrowser: () => ({}) };
    if (name === '@/lib/kitchen/operations') return { kitchenOrderPriority };
    if (name === './useKitchenLiveSync') return { useKitchenLiveSync: () => ({ connectionState: 'live', lastRealtimeEventAt: null, requestRefresh() {} }) };
    if (name === '../ModulePreference') return { ModulePreference: () => null };
    if (name.endsWith('/actions')) return {};
    return require(name);
  };
  new Function('require', 'module', 'exports', compiled.outputText)(boundaryRequire, loadedModule, loadedModule.exports);
  const order: KitchenOrder = {
    id: 2621, orderNumber: '2621', displayNumber: '2621', status: 'confirmed',
    clientName: 'Prueba Cocina', clientPhone: null, fulfillment: 'delivery', deliveryAddress: null,
    notes: null, createdAt: '2026-09-15T16:12:52Z', scheduledDate: null, scheduledTime: null,
    sentToKitchenAt: null, kitchenStartedAt: null, readyAt: null, etaMinutes: null,
    items: [{ id: 12035, qty: 3, name: 'Combo Sexy Mix Frito (50 und)', crmPlayName: 'Jugada de prueba', presentation: getKitchenItemPresentation(comboInput(3)) }],
  };
  const render = () => renderToStaticMarkup(createElement(loadedModule.exports.default, {
    publicVapidKey: '', fullName: 'Prueba', orders: [order], changeAlerts: [], incidentAlerts: [], inventoryTaskCount: 0,
  }));
  const html = render();
  assert.match(html, /3 presentaciones iguales/);
  assert.equal((html.match(/150 piezas en total/g) ?? []).length, 2);
  assert.match(html, /30 × Mini Tequeños Fritos/);
  assert.match(html, /3 × Salsa Tártara 5oz/);
  assert.doesNotMatch(html, />450<|90 × Mini|9 × Salsa/);
  assert.match(html, /Jugada de prueba/);
  order.items[0].presentation = { ...order.items[0].presentation, quantityWarning: 'Composición contradictoria' };
  const warned = render();
  assert.match(warned, /REVISAR CANTIDADES:/);
  assert.match(warned, /Revisar cantidades con Máster/);
  assert.match(warned, />Revisar<\/div>/);
  assert.doesNotMatch(warned, /150 piezas en total/);
});

test('Kitchen computes once per item on the server and shares it with screen, counter and ticket', () => {
  const page = readFileSync(new URL('../../src/app/app/kitchen/page.tsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../../src/app/app/kitchen/KitchenClient.tsx', import.meta.url), 'utf8');
  assert.match(page, /snapshots:order_item_components\(component_product_id, qty, component_name_snapshot\)/);
  assert.match(page, /\.in\('order_id', orderIds\)/);
  assert.match(page, /presentation: getKitchenItemPresentation\(presentationInput\)/);
  assert.doesNotMatch(client, /getKitchenItemPresentation\(/);
  assert.equal((client.match(/const presentation = item\.presentation;/g) ?? []).length, 2);
  assert.match(client, /sum \+ item\.presentation\.preparedUnits/);
  assert.match(client, /REVISAR CANTIDADES:/);
  assert.match(client, /Revisar cantidades con Máster/);
  assert.doesNotMatch(page, /inventory_commit_order_sale|inventory_sync_order_item_components|\.update\(|\.insert\(/);
});

test('keeps accessory products out of the prepared-pieces counter', () => {
  const presentation = getKitchenItemPresentation({
    qty: 3,
    name: 'Salsa Tártara 1oz',
    unitsPerService: 1,
    notes: null,
  });

  assert.equal(presentation.totalUnits, 3);
  assert.equal(presentation.preparedUnits, 0);
});
