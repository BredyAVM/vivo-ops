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
import { getKitchenItemPresentation } from '../../src/lib/kitchen/order-presentation.ts';

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

test('multiplies one configurable presentation when the order repeats it', () => {
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
  });

  assert.equal(presentation.repeatsSameConfiguration, true);
  assert.equal(presentation.totalUnits, 20);
  assert.equal(presentation.preparedUnits, 20);
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
  const presentation = getKitchenItemPresentation({
    qty: 2,
    name: 'Combo Sexy Mix Frito (50 und)',
    unitsPerService: 0,
    notes: [
      '20 Mini Tequeños Fritos',
      '20 Empanadas Fritas',
      '20 Cachitas Fritas',
      '20 Mandocas Fritas',
      '20 Bombys Fritos',
      '2 Salsa Tártara 5oz',
    ].join('\n'),
  });

  assert.equal(presentation.repeatsSameConfiguration, false);
  assert.equal(presentation.totalUnits, 100);
  assert.equal(presentation.preparedUnits, 100);
  assert.equal(presentation.detailLines[0]?.qty, 20);
  assert.equal(presentation.detailLines[0]?.qtyPerPresentation, null);
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
