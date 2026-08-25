import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAdvisorGoalSimulation, type AdvisorGoalCommercialMetricRow } from '../../src/lib/commissions/goal-simulation.ts';
import { suggestNextAdvisorGoalPeriod } from '../../src/lib/commissions/goal-period.ts';

function row(periodKey: string, billingUsd: number, closuresCount: number): AdvisorGoalCommercialMetricRow {
  const [year, month, half] = periodKey.split('-').map(Number);
  return {
    periodKey,
    periodFrom: `${year}-${String(month).padStart(2, '0')}-${half === 1 ? '01' : '16'}`,
    periodTo: `${year}-${String(month).padStart(2, '0')}-${half === 1 ? '15' : '30'}`,
    periodYear: year,
    periodMonth: month,
    periodHalf: half,
    advisorUserId: 'advisor',
    advisorName: 'Martin Montiel',
    billingUsd,
    closuresCount,
    newOwnClientsCount: 1,
    newAssignedClientsCount: 3,
  };
}

test('conserva la fórmula anterior en los periodos previos a septiembre 1', () => {
  const metrics = [
    row('2025-07-2', 500, 10),
    row('2025-08-1', 450, 9),
    row('2026-05-1', 458.07, 14),
    row('2026-05-2', 428.52, 13),
    row('2026-06-1', 427.35, 12),
    row('2026-06-2', 448.06, 12),
    row('2026-07-1', 678.41, 13),
    row('2026-07-2', 793.55, 18),
    { ...row('2026-08-1', 514.72, 12), newOwnClientsCount: 1, newAssignedClientsCount: 2 },
  ];
  const simulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-08-01',
    periodTo: '2026-08-15',
    metrics,
    context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 },
  });
  const advisor = simulation.advisors[0];

  assert.equal(simulation.referenceLagPeriods, 0);
  assert.equal(advisor.metrics.billing.reference, 678.41);
  assert.equal(advisor.metrics.billing.expectedCapacity, 678.41);
  assert.equal(advisor.metrics.billing.target, 746.251);
  assert.equal(advisor.metrics.closures.target, 15);
  assert.equal(advisor.metrics.billing.recentContext, null);
  assert.equal(simulation.seasonality.billing.suggestedPct, -10);
  assert.equal(simulation.cutoffDate, '2026-08-20');
});

test('no inventa un porcentaje cuando faltan tres periodos válidos', () => {
  const simulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-08-01',
    periodTo: '2026-08-15',
    metrics: [row('2026-07-1', 100, 5), row('2026-07-2', 110, 6), row('2026-08-1', 120, 7)],
  });

  assert.equal(simulation.advisors[0].score, null);
  assert.match(simulation.advisors[0].warning ?? '', /Faltan referencias/);
});

test('proyecta agosto 2 antes de tener ventas sin inventar un resultado observado', () => {
  const metrics = [
    row('2026-05-1', 458.07, 14),
    row('2026-05-2', 428.52, 13),
    row('2026-06-1', 427.35, 12),
    row('2026-06-2', 448.06, 12),
    row('2026-07-1', 678.41, 13),
    row('2026-07-2', 793.55, 18),
    row('2026-08-1', 514.72, 12),
  ];
  const simulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-08-16',
    periodTo: '2026-08-31',
    metrics,
    projectionAdvisors: [{ advisorUserId: 'advisor', advisorName: 'Martin Montiel' }],
    mode: 'projection',
    context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 },
  });

  assert.equal(simulation.mode, 'projection');
  assert.equal(simulation.periodKey, '2026-08-2');
  assert.equal(simulation.advisors[0].metrics.billing.actual, 0);
  assert.equal(simulation.advisors[0].metrics.billing.recentContext, null);
  assert.ok((simulation.advisors[0].metrics.billing.target ?? 0) > 0);
  assert.equal(simulation.advisors[0].targetScore?.points, 200);
  assert.equal(simulation.advisors[0].targetScore?.calculatedCommissionPct, 11);
});

test('aplica una base de puntos y bandas configurables por periodo', () => {
  const metrics = [
    row('2026-05-1', 458.07, 14),
    row('2026-05-2', 428.52, 13),
    row('2026-06-1', 427.35, 12),
    row('2026-06-2', 448.06, 12),
    row('2026-07-1', 678.41, 13),
    row('2026-07-2', 793.55, 18),
    row('2026-08-1', 514.72, 12),
  ];
  const bands = [
    { key: 'yuca' as const, label: 'Yuca', minPoints: 0, commissionPct: 7 },
    { key: 'bronze' as const, label: 'Bronce', minPoints: 120, commissionPct: 8 },
    { key: 'silver' as const, label: 'Plata', minPoints: 180, commissionPct: 9 },
    { key: 'gold' as const, label: 'Oro', minPoints: 210, commissionPct: 10 },
    { key: 'platinum' as const, label: 'Platino', minPoints: 250, commissionPct: 11 },
  ];
  const simulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-08-16',
    periodTo: '2026-08-31',
    metrics,
    projectionAdvisors: [{ advisorUserId: 'advisor', advisorName: 'Martin Montiel' }],
    mode: 'projection',
    context: {
      billingContextPct: 0,
      closuresContextPct: 0,
      growthChallengePct: 10,
      metricBasePoints: {
        billing: 80,
        closures: 50,
        collection: 30,
        new_own_clients: 30,
        new_assigned_clients: 10,
      },
      bands,
    },
  });

  assert.equal(simulation.scoring.metrics.find((metric) => metric.key === 'closures')?.weightPct, 25);
  assert.equal(simulation.scoring.metrics.find((metric) => metric.key === 'collection')?.basePoints, 30);
  assert.equal(simulation.advisors[0].targetScore?.points, 200);
  assert.equal(simulation.advisors[0].targetScore?.band.key, 'silver');
  assert.equal(simulation.advisors[0].targetScore?.calculatedCommissionPct, 9);
});

test('septiembre 1 omite agosto 2 y lo conserva como contexto reciente', () => {
  const metrics = [
    row('2026-05-1', 400, 10),
    row('2026-05-2', 420, 11),
    row('2026-06-1', 440, 12),
    row('2026-06-2', 460, 13),
    row('2026-07-1', 480, 14),
    row('2026-07-2', 500, 15),
    row('2026-08-1', 520, 16),
    row('2026-08-2', 100, 3),
    row('2026-09-1', 0, 0),
  ];
  const simulation = buildAdvisorGoalSimulation({
    periodFrom: '2026-09-01',
    periodTo: '2026-09-15',
    metrics,
    context: { billingContextPct: 0, closuresContextPct: 0, growthChallengePct: 10 },
  });
  const billing = simulation.advisors[0].metrics.billing;

  assert.equal(simulation.referenceLagPeriods, 1);
  assert.deepEqual(billing.recentContext, { periodKey: '2026-08-2', value: 100 });
  assert.deepEqual(billing.capacity.excludedPeriods, ['2026-08-2']);
  assert.equal(billing.history.some((item) => item.periodKey === '2026-08-2'), false);
  assert.equal(billing.history.at(-1)?.periodKey, '2026-08-1');
});

test('sugiere la siguiente quincena completa', () => {
  assert.deepEqual(suggestNextAdvisorGoalPeriod('2026-08-15'), {
    name: 'Agosto 02',
    dateFrom: '2026-08-16',
    dateTo: '2026-08-31',
    year: 2026,
    month: 8,
    half: 2,
  });
  assert.equal(suggestNextAdvisorGoalPeriod('2026-08-31').name, 'Septiembre 01');
});
