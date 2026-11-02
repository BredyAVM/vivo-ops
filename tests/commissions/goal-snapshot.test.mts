import assert from 'node:assert/strict';
import test from 'node:test';

import {
  preserveAdvisorGoalPublicationSnapshot,
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
  resolveAdvisorGoalScoringConfiguration,
  withAdvisorGoalPublicationSnapshot,
  type AdvisorGoalPeriodConfig,
  type AdvisorGoalPublicationSnapshot,
} from '../../src/lib/commissions/goal-snapshot.ts';

const observed = {
  suggestedPct: -6.73,
  typicalLowPct: -10,
  typicalHighPct: -2,
  sampleCount: 14,
  yearCount: 3,
  confidence: 'high' as const,
};

const periodConfig: AdvisorGoalPeriodConfig = {
  version: 1,
  status: 'published',
  growthChallengePct: 10,
  campaignBoostPct: 4,
  billing: { observed, appliedPct: -2, reason: 'Campaña activa' },
  closures: { observed: { ...observed, suggestedPct: -11.09 }, appliedPct: -5, reason: 'Campaña activa' },
  publicationMessage: 'Impulsaremos reuniones y celebraciones.',
  generatedAt: '2026-08-03T12:00:00.000Z',
  generatedByUserId: 'admin',
  publishedAt: '2026-08-04T12:00:00.000Z',
  publishedByUserId: 'admin',
  revision: 1,
  audit: [],
};

const publication: AdvisorGoalPublicationSnapshot = {
  version: 1,
  status: 'published',
  periodId: 5,
  advisorUserId: 'advisor',
  advisorName: 'Asesor',
  generatedAt: '2026-08-03T12:00:00.000Z',
  generatedByUserId: 'admin',
  publishedAt: '2026-08-04T12:00:00.000Z',
  publishedByUserId: 'admin',
  revision: 1,
  explanation: 'La meta separa capacidad y crecimiento.',
  publicationMessage: null,
  calculatedCommissionPct: 9,
  appliedCommissionPct: 9,
  rateOverrideReason: null,
  score: {
    points: 160,
    calculatedCommissionPct: 9,
    band: { key: 'bronze', label: 'Bronce', minPoints: 140, commissionPct: 9 },
    metrics: [],
  },
  metrics: {},
  audit: [],
};

test('lee la configuración versionada del periodo sin crear tablas paralelas', () => {
  assert.deepEqual(readAdvisorGoalPeriodConfig(periodConfig), periodConfig);
  assert.equal(readAdvisorGoalPeriodConfig({ version: 2 }), null);
  const scoring = resolveAdvisorGoalScoringConfiguration(periodConfig, '2026-08-01');
  assert.equal(scoring.metricBasePoints.billing, 100);
  assert.equal(scoring.bands.find((band) => band.key === 'platinum')?.commissionPct, 12);
});

test('el valor predeterminado desde octubre es 6 a 10 y septiembre conserva 8 a 12', () => {
  const rates = (from?: string) => resolveAdvisorGoalScoringConfiguration(null, from).bands.map((band) => band.commissionPct);
  assert.deepEqual(rates(), [6, 7, 8, 9, 10]);
  assert.deepEqual(rates('2026-09-16'), [8, 9, 10, 11, 12]);
  assert.deepEqual(rates('2026-10-01'), [6, 7, 8, 9, 10]);
  assert.deepEqual(rates('2026-10-16'), [6, 7, 8, 9, 10]);
  assert.deepEqual(rates('2026-11-01'), [6, 7, 8, 9, 10]);
});

test('un período nuevo hereda solo la última configuración aprobada de su misma política', () => {
  const approvedScoring = resolveAdvisorGoalScoringConfiguration(null, '2026-10-01');
  approvedScoring.bands.forEach((band) => { band.commissionPct -= 1; });
  const approved = { ...periodConfig, scoring: approvedScoring };
  const candidates = [
    { date_from: '2026-10-01', goal_config: approved },
    { date_from: '2026-10-16', goal_config: { ...approved, status: 'draft', scoring: resolveAdvisorGoalScoringConfiguration(null) } },
    { date_from: '2026-11-16', goal_config: { ...approved, scoring: resolveAdvisorGoalScoringConfiguration(null) } },
    { date_from: '2026-09-16', goal_config: { ...approved, scoring: resolveAdvisorGoalScoringConfiguration(null, '2026-09-16') } },
  ];
  const before = JSON.stringify(candidates);
  const inherited = resolveAdvisorGoalScoringConfiguration(null, '2026-11-01', candidates);
  assert.deepEqual(inherited.bands.map((band) => band.commissionPct), [5, 6, 7, 8, 9]);
  inherited.bands[0].commissionPct = 0;
  assert.equal(JSON.stringify(candidates), before, 'heredar nunca modifica la configuración de origen');
  assert.deepEqual(resolveAdvisorGoalScoringConfiguration(null, '2026-10-01', candidates).bands.map((band) => band.commissionPct), [6, 7, 8, 9, 10]);
  const newerApproved = { ...approved, scoring: resolveAdvisorGoalScoringConfiguration(null) };
  assert.deepEqual(resolveAdvisorGoalScoringConfiguration(null, '2026-11-01', [
    ...candidates, { date_from: '2026-10-16', goal_config: newerApproved },
  ]).bands.map((band) => band.commissionPct), [6, 7, 8, 9, 10]);
});

test('las bandas explícitas de un período guardado prevalecen y nunca se reescriben al leer', () => {
  const saved = { ...periodConfig, scoring: resolveAdvisorGoalScoringConfiguration(null, '2026-09-16') };
  const before = JSON.stringify(saved);
  assert.deepEqual(resolveAdvisorGoalScoringConfiguration(saved, '2026-10-16').bands.map((band) => band.commissionPct), [8, 9, 10, 11, 12]);
  assert.equal(JSON.stringify(saved), before);
});

test('rechaza una base inconsistente y conserva compatibilidad con periodos anteriores', () => {
  assert.equal(readAdvisorGoalPeriodConfig({
    ...periodConfig,
    scoring: {
      metricBasePoints: {
        billing: 100,
        closures: 40,
        collection: 20,
        new_own_clients: 30,
        new_assigned_clients: 20,
      },
      bands: resolveAdvisorGoalScoringConfiguration(null).bands,
    },
  }), null);
  assert.equal(resolveAdvisorGoalScoringConfiguration(periodConfig).metricBasePoints.new_assigned_clients, 10);
});

test('guarda la publicación dentro del snapshot existente', () => {
  const snapshot = withAdvisorGoalPublicationSnapshot({ orders: [{ id: 1 }] }, publication);
  assert.deepEqual(snapshot.orders, [{ id: 1 }]);
  assert.deepEqual(readAdvisorGoalPublicationSnapshot(snapshot), publication);
});

test('un recálculo de comisiones conserva la meta publicada y reemplaza el resto', () => {
  const previous = withAdvisorGoalPublicationSnapshot({ orders: [{ id: 1 }] }, publication);
  const generated = { orders: [{ id: 2 }], totals: { billedUsd: 100 } };
  const merged = preserveAdvisorGoalPublicationSnapshot({
    generatedSnapshot: generated,
    previousSnapshot: previous,
  });

  assert.deepEqual(merged.orders, [{ id: 2 }]);
  assert.deepEqual(merged.totals, { billedUsd: 100 });
  assert.deepEqual(readAdvisorGoalPublicationSnapshot(merged), publication);
});
