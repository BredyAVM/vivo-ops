import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdvisorGoalSimulation } from '../../src/lib/commissions/goal-simulation.ts';
import { buildAdvisorGoalPublicationBundle } from '../../src/lib/commissions/goal-publication.ts';
import { advisorGoalFinalizationBlock, buildAdvisorGoalResultApplication, withPublishedAdvisorGoalTargets } from '../../src/lib/commissions/goal-application.ts';

const metrics = Array.from({ length: 8 }, (_, index) => ({
  periodKey: `2026-${String(5 + Math.floor(index / 2)).padStart(2, '0')}-${index % 2 + 1}`,
  periodFrom: `2026-${String(5 + Math.floor(index / 2)).padStart(2, '0')}-${index % 2 ? '16' : '01'}`,
  periodTo: `2026-${String(5 + Math.floor(index / 2)).padStart(2, '0')}-${index % 2 ? '30' : '15'}`,
  periodYear: 2026, periodMonth: 5 + Math.floor(index / 2), periodHalf: index % 2 + 1,
  advisorUserId: 'advisor', advisorName: 'Asesor', billingUsd: 100, closuresCount: 10,
  newOwnClientsCount: 1, newAssignedClientsCount: 1,
}));
const simulation = buildAdvisorGoalSimulation({ periodFrom: '2026-09-01', periodTo: '2026-09-15', metrics,
  projectionAdvisors: [{ advisorUserId: 'advisor', advisorName: 'Asesor' }],
  context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 } });
const previous = buildAdvisorGoalPublicationBundle({ simulation, periodId: 7, intent: 'publish', reason: '',
  publicationMessage: null, actorUserId: 'admin', recordedAt: '2026-08-31T12:00:00Z', previousConfig: null,
  previousByAdvisorId: new Map() }).publications[0].publication;
const advisor = { ...simulation.advisors[0], score: { ...simulation.advisors[0].score!,
  points: 220, calculatedCommissionPct: 11, band: { key: 'gold' as const, label: 'Oro', minPoints: 200, commissionPct: 11 } } };
const params = { advisor, previous, closureStatus: 'preliminary', intent: 'automatic' as const,
  actorUserId: 'admin', recordedAt: '2026-09-16T12:00:00Z' };

test('un preliminar toma el porcentaje actual y conserva los objetivos publicados', () => {
  const result = buildAdvisorGoalResultApplication(params)!;
  assert.equal(result.appliedCommissionPct, 11);
  assert.equal(result.status, 'provisional');
  assert.equal(result.metrics.billing.target, previous.metrics.billing.target);
  assert.equal(result.audit.at(-1)?.action, 'result_applied');
  assert.equal(buildAdvisorGoalResultApplication({ ...params, previous: result }), result);
});

test('la lectura JSONB no agrega revisiones cuando solo cambia el orden de las claves', () => {
  const applied = buildAdvisorGoalResultApplication(params)!;
  const databaseResult: typeof applied = JSON.parse(JSON.stringify(applied, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? 1 : left > right ? -1 : 0))
      : value));
  assert.equal(buildAdvisorGoalResultApplication({ ...params, previous: databaseResult }), databaseResult);
  const changed = buildAdvisorGoalResultApplication({ ...params, previous: databaseResult,
    advisor: { ...advisor, score: { ...advisor.score, points: advisor.score.points + 1 } } })!;
  assert.equal(changed.revision, applied.revision + 1);
});

test('no altera cierres confirmados o pagados ni porcentajes finales', () => {
  assert.equal(buildAdvisorGoalResultApplication({ ...params, closureStatus: 'closed' }), null);
  assert.equal(buildAdvisorGoalResultApplication({ ...params, closureStatus: 'paid' }), null);
  const final = { ...previous, status: 'final' as const, appliedCommissionPct: 9 };
  assert.equal(buildAdvisorGoalResultApplication({ ...params, previous: final }), final);
  assert.throws(() => buildAdvisorGoalResultApplication({ ...params, previous: final, intent: 'preliminary' }), /rectificación/);
  assert.throws(() => buildAdvisorGoalResultApplication({ ...params, previous: final, intent: 'final' }), /motivo/);
});

test('la excepción requiere motivo, se conserva al actualizar y permite volver a automático', () => {
  assert.throws(() => buildAdvisorGoalResultApplication({ ...params, override: { commissionPct: 9, reason: '' } }), /motivo/);
  const manual = buildAdvisorGoalResultApplication({ ...params, override: { commissionPct: 9, reason: 'Acuerdo aprobado.' } })!;
  const refreshed = buildAdvisorGoalResultApplication({ ...params, previous: manual })!;
  assert.equal(refreshed.appliedCommissionPct, 9);
  assert.equal(refreshed.rateOverrideReason, 'Acuerdo aprobado.');
  const automatic = buildAdvisorGoalResultApplication({ ...params, previous: manual, intent: 'preliminary', override: null })!;
  assert.equal(automatic.appliedCommissionPct, 11);
  assert.equal(automatic.rateOverrideReason, null);
  assert.equal(automatic.audit.at(-1)?.next?.automatic, true);
});

test('un cambio histórico no mueve la meta que recibió el asesor', () => {
  const changed = buildAdvisorGoalSimulation({ periodFrom: '2026-09-01', periodTo: '2026-09-15',
    metrics: metrics.map((row) => ({ ...row, billingUsd: 1000, closuresCount: 100 })),
    projectionAdvisors: [{ advisorUserId: 'advisor', advisorName: 'Asesor' }],
    context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 } });
  const result = withPublishedAdvisorGoalTargets(changed, new Map([['advisor', previous]]));
  assert.notEqual(changed.advisors[0].metrics.billing.target, previous.metrics.billing.target);
  assert.equal(result.advisors[0].metrics.billing.target, previous.metrics.billing.target);
  const final = { ...previous, status: 'final' as const };
  assert.equal(withPublishedAdvisorGoalTargets(changed, new Map([['advisor', final]])).advisors[0].score, final.score);
});

test('confirma por asesor antes de cinco días solo con cobranza completa y fechas verificables', () => {
  const paid = { ...advisor, metrics: { ...advisor.metrics, closures: { ...advisor.metrics.closures, actual: 1 } }, collection: { ...advisor.collection, ordersCount: 1, orders: [
    { pendingUsd: 0, status: 'punctual_paid' as const },
  ] as typeof advisor.collection.orders } };
  const dates = { periodTo: '2026-09-30', cutoffDate: '2026-10-05', today: '2026-10-01' };
  assert.equal(advisorGoalFinalizationBlock({ ...dates, advisor: paid }), null);
  const unpaid = { ...paid, collection: { ...paid.collection, orders: [
    { pendingUsd: 10, status: 'credit_open' as const },
  ] as typeof advisor.collection.orders } };
  assert.match(advisorGoalFinalizationBlock({ ...dates, advisor: unpaid })!, /pendiente/);
  assert.equal(advisorGoalFinalizationBlock({ ...dates, today: '2026-10-05', advisor: unpaid }), null);
  const missing = { ...paid, collection: { ...paid.collection, orders: [
    { pendingUsd: 0, status: 'missing_registration' as const },
  ] as typeof advisor.collection.orders } };
  assert.match(advisorGoalFinalizationBlock({ ...dates, today: '2026-10-05', advisor: missing })!, /verificarse/);
  assert.match(advisorGoalFinalizationBlock({ ...dates, today: '2026-09-30', advisor: paid })!, /curso/);
});
