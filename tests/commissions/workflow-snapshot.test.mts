import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmAdvisorCommissionWorkflowSnapshot,
  preserveAdvisorCommissionWorkflowSnapshot,
  readAdvisorCommissionWorkflowSnapshot,
  reopenAdvisorCommissionWorkflowSnapshot,
} from '../../src/lib/commissions/workflow-snapshot.ts';

test('registra la conformidad sin borrar la foto economica', () => {
  const snapshot = confirmAdvisorCommissionWorkflowSnapshot({
    snapshot: { version: 2, orders: [{ orderId: 10 }] },
    confirmedAt: '2026-08-20T12:00:00-04:00',
    recordedByUserId: 'admin-1',
  });

  assert.deepEqual(snapshot.orders, [{ orderId: 10 }]);
  assert.deepEqual(readAdvisorCommissionWorkflowSnapshot(snapshot), {
    conformity: {
      status: 'confirmed',
      confirmedAt: '2026-08-20T16:00:00.000Z',
      recordedByUserId: 'admin-1',
      source: 'admin-recorded',
    },
    revisionCount: 0,
  });
});

test('una rectificacion invalida la conformidad y conserva el motivo', () => {
  const confirmed = confirmAdvisorCommissionWorkflowSnapshot({
    snapshot: { version: 2 },
    confirmedAt: '2026-08-20T16:00:00.000Z',
    recordedByUserId: 'admin-1',
  });
  const reopened = reopenAdvisorCommissionWorkflowSnapshot({
    snapshot: confirmed,
    reopenedAt: '2026-08-21T10:00:00-04:00',
    reopenedByUserId: 'admin-2',
    reason: 'Orden atribuida al asesor incorrecto',
  });

  assert.deepEqual(readAdvisorCommissionWorkflowSnapshot(reopened), {
    conformity: {
      status: 'requires_reconfirmation',
      supersededAt: '2026-08-21T14:00:00.000Z',
      supersededByUserId: 'admin-2',
      reason: 'Orden atribuida al asesor incorrecto',
    },
    revisionCount: 1,
  });
});

test('el recálculo conserva el historial de conformidad', () => {
  const reopened = reopenAdvisorCommissionWorkflowSnapshot({
    snapshot: { version: 2, totals: { payableUsd: 100 } },
    reopenedAt: '2026-08-21T14:00:00.000Z',
    reopenedByUserId: 'admin-2',
    reason: 'Corrección excepcional',
  });
  const merged = preserveAdvisorCommissionWorkflowSnapshot({
    generatedSnapshot: { version: 1, orders: [{ orderId: 20 }] },
    previousSnapshot: reopened,
  });

  assert.deepEqual((merged as { orders: unknown }).orders, [{ orderId: 20 }]);
  assert.equal(readAdvisorCommissionWorkflowSnapshot(merged).revisionCount, 1);
  assert.equal(
    readAdvisorCommissionWorkflowSnapshot(merged).conformity.status,
    'requires_reconfirmation'
  );
});
