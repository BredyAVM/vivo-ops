import assert from 'node:assert/strict';
import test from 'node:test';

import {
  preserveAdvisorGoalPublicationSnapshot,
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
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
