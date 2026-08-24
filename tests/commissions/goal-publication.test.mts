import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAdvisorGoalPublicationBundle } from '../../src/lib/commissions/goal-publication.ts';
import { buildAdvisorGoalSimulation, type AdvisorGoalCommercialMetricRow } from '../../src/lib/commissions/goal-simulation.ts';

function row(index: number, target = false): AdvisorGoalCommercialMetricRow {
  const month = target ? 8 : 5 + Math.floor(index / 2);
  const half = target ? 1 : index % 2 + 1;
  const year = 2026;
  return {
    periodKey: `${year}-${String(month).padStart(2, '0')}-${half}`,
    periodFrom: `${year}-${String(month).padStart(2, '0')}-${half === 1 ? '01' : '16'}`,
    periodTo: `${year}-${String(month).padStart(2, '0')}-${half === 1 ? '15' : '30'}`,
    periodYear: year,
    periodMonth: month,
    periodHalf: half,
    advisorUserId: 'advisor',
    advisorName: 'Asesor',
    billingUsd: 100 + index * 10,
    closuresCount: 10 + index,
    newOwnClientsCount: 2,
    newAssignedClientsCount: 3,
  };
}

const simulation = buildAdvisorGoalSimulation({
  periodFrom: '2026-08-01',
  periodTo: '2026-08-15',
  metrics: [...Array.from({ length: 6 }, (_, index) => row(index)), row(6, true)],
  context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 },
});

test('crea borrador por periodo y asesor con evidencia histórica', () => {
  const bundle = buildAdvisorGoalPublicationBundle({
    simulation,
    periodId: 5,
    intent: 'draft',
    reason: '',
    publicationMessage: null,
    actorUserId: 'admin',
    recordedAt: '2026-08-02T12:00:00.000Z',
    previousConfig: null,
    previousByAdvisorId: new Map(),
  });

  assert.equal(bundle.config.status, 'draft');
  assert.equal(bundle.config.revision, 1);
  assert.equal(bundle.publications[0].publication.metrics.billing.history.length, 6);
  assert.equal(bundle.publications[0].publication.audit[0].action, 'generated');
});

test('publicar una modificación exige motivo y aumenta la revisión', () => {
  const first = buildAdvisorGoalPublicationBundle({
    simulation,
    periodId: 5,
    intent: 'draft',
    reason: '',
    publicationMessage: null,
    actorUserId: 'admin',
    recordedAt: '2026-08-02T12:00:00.000Z',
    previousConfig: null,
    previousByAdvisorId: new Map(),
  });
  const adjustedSimulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-08-01',
    periodTo: '2026-08-15',
    metrics: [...Array.from({ length: 6 }, (_, index) => row(index)), row(6, true)],
    context: { billingContextPct: 5, closuresContextPct: 0, growthChallengePct: 10 },
  });
  assert.throws(() => buildAdvisorGoalPublicationBundle({
    simulation: adjustedSimulation,
    periodId: 5,
    intent: 'publish',
    reason: '',
    publicationMessage: null,
    actorUserId: 'admin',
    recordedAt: '2026-08-03T12:00:00.000Z',
    previousConfig: first.config,
    previousByAdvisorId: new Map(first.publications.map((row) => [row.advisorUserId, row.publication])),
  }), /motivo/);

  const published = buildAdvisorGoalPublicationBundle({
    simulation: adjustedSimulation,
    periodId: 5,
    intent: 'publish',
    reason: 'Ajuste aprobado por administración.',
    publicationMessage: 'Esta es tu meta del periodo.',
    actorUserId: 'admin',
    recordedAt: '2026-08-03T12:00:00.000Z',
    previousConfig: first.config,
    previousByAdvisorId: new Map(first.publications.map((row) => [row.advisorUserId, row.publication])),
  });
  assert.equal(published.config.status, 'published');
  assert.equal(published.config.revision, 2);
  assert.equal(published.publications[0].publication.audit.at(-1)?.action, 'published');
});

test('finaliza el resultado y audita una sustitución excepcional del porcentaje', () => {
  const bundle = buildAdvisorGoalPublicationBundle({
    simulation,
    periodId: 5,
    intent: 'finalize',
    reason: 'Resultado revisado por administración.',
    publicationMessage: null,
    actorUserId: 'admin',
    recordedAt: '2026-08-20T12:00:00.000Z',
    previousConfig: null,
    previousByAdvisorId: new Map(),
    commissionOverrideByAdvisorId: new Map([
      ['advisor', { commissionPct: 12, reason: 'Reconocimiento excepcional aprobado.' }],
    ]),
  });

  assert.equal(bundle.config.status, 'closed');
  assert.equal(bundle.publications[0].publication.status, 'final');
  assert.equal(bundle.publications[0].publication.appliedCommissionPct, 12);
  assert.equal(bundle.publications[0].publication.audit.at(-1)?.action, 'rate_overridden');
});
