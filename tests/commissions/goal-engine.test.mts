import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVISOR_GOAL_BANDS,
  ADVISOR_GOAL_METRICS,
  buildAdvisorGoalTarget,
  buildAdvisorNewClientTarget,
  calculateAdvisorCollectionOrderValue,
  calculateAdvisorCollectionRatio,
  calculateAdvisorGoalMetricPoints,
  calculateAdvisorGoalScore,
  calculateAdvisorGoalSeasonality,
  selectAdvisorGoalCapacity,
  validateAdvisorGoalConfiguration,
} from '../../src/lib/commissions/goal-engine.ts';

test('selecciona la trayectoria reciente cuando supera de forma sostenida la mediana de seis periodos', () => {
  const capacity = selectAdvisorGoalCapacity([
    { periodKey: '2026-05-1', value: 400 },
    { periodKey: '2026-05-2', value: 420 },
    { periodKey: '2026-06-1', value: 430 },
    { periodKey: '2026-06-2', value: 448.06 },
    { periodKey: '2026-07-1', value: 678.41 },
    { periodKey: '2026-07-2', value: 793.55 },
  ]);

  assert.equal(capacity.medianAvailable, 439.03);
  assert.equal(capacity.medianRecent, 678.41);
  assert.equal(capacity.reference, 678.41);
  assert.equal(capacity.confidence, 'high');
});

test('una sola quincena extraordinaria no eleva por sí misma la capacidad reciente', () => {
  const capacity = selectAdvisorGoalCapacity([
    { periodKey: '1', value: 100 },
    { periodKey: '2', value: 100 },
    { periodKey: '3', value: 100 },
    { periodKey: '4', value: 100 },
    { periodKey: '5', value: 100 },
    { periodKey: '6', value: 500 },
  ]);

  assert.equal(capacity.medianAvailable, 100);
  assert.equal(capacity.medianRecent, 100);
  assert.equal(capacity.reference, 100);
});

test('una caída reciente no reduce la referencia estable de seis periodos', () => {
  const capacity = selectAdvisorGoalCapacity([
    { periodKey: '1', value: 200 },
    { periodKey: '2', value: 200 },
    { periodKey: '3', value: 200 },
    { periodKey: '4', value: 200 },
    { periodKey: '5', value: 100 },
    { periodKey: '6', value: 100 },
  ]);

  assert.equal(capacity.medianAvailable, 200);
  assert.equal(capacity.medianRecent, 100);
  assert.equal(capacity.reference, 200);
});

test('exige referencia manual cuando existen menos de tres periodos válidos', () => {
  const capacity = selectAdvisorGoalCapacity([
    { periodKey: '1', value: 100 },
    { periodKey: '2', value: 150, excluded: true },
    { periodKey: '3', value: 200 },
  ]);

  assert.equal(capacity.requiresManualReference, true);
  assert.equal(capacity.reference, null);
  assert.deepEqual(capacity.excludedPeriods, ['2']);
});

test('calcula tendencia observada con mediana, rango y confianza', () => {
  const seasonality = calculateAdvisorGoalSeasonality([
    ...Array.from({ length: 4 }, (_, index) => ({
      year: 2023,
      advisorId: `a-${index}`,
      previousValue: 100,
      currentValue: 110 + index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      year: 2024,
      advisorId: `b-${index}`,
      previousValue: 100,
      currentValue: 115 + index,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      year: 2025,
      advisorId: `c-${index}`,
      previousValue: 100,
      currentValue: 120 + index,
    })),
  ]);

  assert.equal(seasonality.sampleCount, 12);
  assert.equal(seasonality.yearCount, 3);
  assert.equal(seasonality.suggestedPct, 16.5);
  assert.equal(seasonality.typicalLowPct, 12.75);
  assert.equal(seasonality.typicalHighPct, 20.25);
  assert.equal(seasonality.confidence, 'high');
});

test('separa capacidad esperada, campaña y desafío de crecimiento', () => {
  assert.deepEqual(
    buildAdvisorGoalTarget({
      personalReference: 2250,
      appliedContextPct: 20,
      campaignBoostPct: 5,
      growthChallengePct: 10,
    }),
    {
      personalReference: 2250,
      appliedContextPct: 20,
      expectedCapacity: 2700,
      campaignBoostPct: 5,
      campaignCapacity: 2835,
      growthChallengePct: 10,
      target: 3118.5,
    }
  );
  assert.equal(buildAdvisorNewClientTarget(4.5), 6);
});

test('otorga 80% de los puntos en la referencia, 100% en la meta y limita a 200%', () => {
  assert.equal(calculateAdvisorGoalMetricPoints({ key: 'billing', actual: 2000, reference: 2000, target: 2200 }).points, 80);
  assert.equal(calculateAdvisorGoalMetricPoints({ key: 'billing', actual: 2100, reference: 2000, target: 2200 }).points, 90);
  assert.equal(calculateAdvisorGoalMetricPoints({ key: 'billing', actual: 2200, reference: 2000, target: 2200 }).points, 100);
  assert.equal(calculateAdvisorGoalMetricPoints({ key: 'billing', actual: 2640, reference: 2000, target: 2200 }).points, 120);
  assert.equal(calculateAdvisorGoalMetricPoints({ key: 'billing', actual: 9999, reference: 2000, target: 2200 }).points, 200);
});

test('mantener todas las referencias da Bronce, cumplir metas da Oro y superarlas 20% da Platino', () => {
  const references = {
    billing: 2000,
    closures: 50,
    collection: 0.8,
    new_own_clients: 4,
    new_assigned_clients: 6,
  };
  const targets = {
    billing: 2200,
    closures: 55,
    collection: 1,
    new_own_clients: 5,
    new_assigned_clients: 7,
  };
  const inputs = (multiplier: number, atReference = false) => ADVISOR_GOAL_METRICS.map((metric) => ({
    key: metric.key,
    reference: references[metric.key],
    target: targets[metric.key],
    actual: (atReference ? references[metric.key] : targets[metric.key]) * multiplier,
  }));

  const maintained = calculateAdvisorGoalScore(inputs(1, true));
  const achieved = calculateAdvisorGoalScore(inputs(1));
  const outstanding = calculateAdvisorGoalScore(inputs(1.2));

  assert.equal(maintained.points, 160);
  assert.equal(maintained.band.key, 'bronze');
  assert.equal(maintained.calculatedCommissionPct, 9);
  assert.equal(achieved.points, 200);
  assert.equal(achieved.band.key, 'gold');
  assert.equal(achieved.calculatedCommissionPct, 11);
  assert.equal(outstanding.points, 240);
  assert.equal(outstanding.band.key, 'platinum');
  assert.equal(outstanding.calculatedCommissionPct, 12);
});

test('reproduce la simulación de Agosto 1 con trayectoria reciente', () => {
  const result = calculateAdvisorGoalScore([
    { key: 'billing', actual: 514.72, reference: 632.75, target: 696.03 },
    { key: 'closures', actual: 12, reference: 11.56, target: 12.72 },
    { key: 'collection', actual: 0.9667, reference: 0.8, target: 1 },
    { key: 'new_own_clients', actual: 1, reference: 1, target: 2 },
    { key: 'new_assigned_clients', actual: 2, reference: 3, target: 4 },
  ]);

  assert.equal(result.points, 148.779);
  assert.equal(result.band.key, 'bronze');
  assert.equal(result.calculatedCommissionPct, 9);
});

test('clasifica cobranza por fecha de registro y conserva crédito en curso durante cinco días', () => {
  assert.equal(calculateAdvisorCollectionOrderValue({
    deliveryDate: '2026-08-10',
    completedPaymentRegistrationDate: '2026-08-10',
    paymentValidated: true,
  }, '2026-08-20'), 1);
  assert.equal(calculateAdvisorCollectionOrderValue({
    deliveryDate: '2026-08-10',
    completedPaymentRegistrationDate: '2026-08-15',
    paymentValidated: true,
  }, '2026-08-20'), 0.8);
  assert.equal(calculateAdvisorCollectionOrderValue({
    deliveryDate: '2026-08-10',
    completedPaymentRegistrationDate: '2026-08-16',
    paymentValidated: true,
  }, '2026-08-20'), 0);
  assert.equal(calculateAdvisorCollectionOrderValue({
    deliveryDate: '2026-08-10',
    paymentValidated: false,
  }, '2026-08-14'), 0.8);
  assert.equal(calculateAdvisorCollectionOrderValue({
    deliveryDate: '2026-08-10',
    paymentValidated: false,
  }, '2026-08-16'), 0);
  assert.equal(calculateAdvisorCollectionRatio([
    { deliveryDate: '2026-08-10', completedPaymentRegistrationDate: '2026-08-10', paymentValidated: true },
    { deliveryDate: '2026-08-10', completedPaymentRegistrationDate: '2026-08-12', paymentValidated: true },
    { deliveryDate: '2026-08-10', completedPaymentRegistrationDate: '2026-08-20', paymentValidated: true },
  ], '2026-08-20'), 0.6);
});

test('rechaza configuraciones que no suman 100% o 200 puntos', () => {
  assert.doesNotThrow(() => validateAdvisorGoalConfiguration());
  assert.throws(
    () => validateAdvisorGoalConfiguration({
      metrics: ADVISOR_GOAL_METRICS.map((metric, index) => index === 0 ? { ...metric, weightPct: 49 } : metric),
      bands: ADVISOR_GOAL_BANDS,
    }),
    /sumar 100%/
  );
});
