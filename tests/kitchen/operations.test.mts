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

test('accepts exactly two canonical inventory shifts', () => {
  assert.equal(isKitchenShiftCode('shift_1'), true);
  assert.equal(isKitchenShiftCode('shift_2'), true);
  assert.equal(isKitchenShiftCode('shift_3'), false);
  assert.equal(kitchenShiftLabel('shift_1'), 'Turno 1');
  assert.equal(kitchenShiftLabel('shift_2'), 'Turno 2');
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
