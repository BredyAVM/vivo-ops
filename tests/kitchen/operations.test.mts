import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getKitchenShiftDateBounds,
  isKitchenShiftCode,
  kitchenIncidentStatusFromLifecycle,
  kitchenOrderPriority,
  kitchenShiftLabel,
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
