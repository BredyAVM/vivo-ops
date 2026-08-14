import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdvisorCommissionShadowProjection,
  summarizeAdvisorCommissionShadowProjection,
  type AdvisorCommissionLegacyPeriodFact,
} from '../../src/lib/commissions/legacy-projection.ts';

const periods = [
  { id: 2, name: 'Junio 1', dateFrom: '2026-06-01' },
  { id: 1, name: 'Junio 02', dateFrom: '2026-06-16' },
  { id: 3, name: 'Julio 01', dateFrom: '2026-07-01' },
  { id: 4, name: 'Julio 02', dateFrom: '2026-07-16' },
];

const advisors = [
  { id: 'ana', name: 'Anagraciela Perozo' },
  { id: 'bredy', name: 'Bredy Velasquez' },
  { id: 'jacqueline', name: 'Jacqueline Aular' },
  { id: 'mariangela', name: 'Mariangela Montiel' },
  { id: 'martin', name: 'Martin Montiel' },
  { id: 'ramon', name: 'Ramon Viviescas' },
  { id: 'yujanir', name: 'Yujanir Aular' },
];

function fact(
  advisorId: string,
  periodId: number,
  closureId: number,
  grossCommissionUsd: number,
  giftDeductionsUsd: number,
  directDeductionsUsd: number,
  outstandingCustomerDebtUsd: number,
  legacyPayableUsd: number
): AdvisorCommissionLegacyPeriodFact {
  return {
    advisorId,
    periodId,
    closureId,
    grossCommissionUsd,
    giftDeductionsUsd,
    directDeductionsUsd,
    outstandingCustomerDebtUsd,
    legacyPayableUsd,
  };
}

const auditedFacts = [
  fact('ana', 2, 28, 56.73, 0, 0, 47.11, 56.73),
  fact('bredy', 2, 79, 3.67, 0, 0, 0, 3.67),
  fact('jacqueline', 2, 80, 114.42, 7, 0, 27.92, 107.42),
  fact('mariangela', 2, 23, 254.53, 17.5, 0, 39.01, 237.03),
  fact('martin', 2, 6, 32.71, 0.5, 20.1, 15.62, 12.11),
  fact('ramon', 2, 82, 144.44, 1.5, 0, 723.54, 142.94),
  fact('yujanir', 2, 84, 194.86, 7.5, 0, 136.95, 187.36),

  fact('ana', 1, 85, 18.1, 0, 0, 0, 18.1),
  fact('bredy', 1, 86, 32.94, 0, 0, 186.67, 32.94),
  fact('jacqueline', 1, 22, 164.3, 11.5, 0, 0, 152.8),
  fact('mariangela', 1, 1, 295.6, 11, 108.46, 0, 176.14),
  fact('martin', 1, 5, 34.68, 2, 0, 0, 32.68),
  fact('ramon', 1, 11, 203.89, 4.5, 87.47, 70.03, 111.92),
  fact('yujanir', 1, 26, 191.67, 6, 39.88, 63.6, 145.79),

  fact('jacqueline', 3, 57, 108.57, 13.5, 0, 0, 95.07),
  fact('mariangela', 3, 59, 300.45, 29, 27.7, 0, 243.75),
  fact('martin', 3, 60, 53.74, 6.5, 0, 0, 47.24),
  fact('ramon', 3, 68, 183.94, 12, 86.27, 0, 85.67),
  fact('yujanir', 3, 69, 182.65, 14, 6.02, 63.6, 168.65),

  fact('jacqueline', 4, 77, 152.43, 37, 2.63, 0, 112.8),
  fact('mariangela', 4, 89, 317.86, 45.5, 127.07, 0, 272.36),
  fact('martin', 4, 90, 76.86, 6, 0, 0, 70.86),
  fact('ramon', 4, 91, 262.33, 60, 141.47, 26.94, 202.33),
  fact('yujanir', 4, 92, 331.03, 42.5, 71.33, 0.01, 217.2),
];

test('reconstruye los cuatro periodos auditados sin perder valor economico', () => {
  const rows = buildAdvisorCommissionShadowProjection({
    periods,
    advisors,
    facts: auditedFacts,
  });
  const summaries = summarizeAdvisorCommissionShadowProjection(rows);

  assert.equal(rows.length, 28);
  assert.deepEqual(
    summaries.map((summary) => ({
      period: summary.periodName,
      legacy: summary.legacyPayableUsd,
      economic: summary.currentPeriodEconomicCreditUsd,
      projected: summary.projectedPayableUsd,
      retained: summary.retainedCommissionUsd,
    })),
    [
      { period: 'Junio 1', legacy: 747.26, economic: 747.26, projected: 341.22, retained: 406.04 },
      { period: 'Junio 02', legacy: 670.37, economic: 670.37, projected: 909.84, retained: 166.57 },
      { period: 'Julio 01', legacy: 640.38, economic: 634.36, projected: 737.33, retained: 63.6 },
      { period: 'Julio 02', legacy: 875.55, economic: 607.01, projected: 643.66, retained: 26.95 },
    ]
  );

  const economicTotal = Math.round(
    summaries.reduce(
      (sum, summary) => sum + summary.currentPeriodEconomicCreditUsd,
      0
    ) * 100
  ) / 100;
  const projectedTotal = Math.round(
    summaries.reduce(
      (sum, summary) => sum + summary.projectedPayableUsd,
      0
    ) * 100
  ) / 100;
  const finalRetained = summaries.at(-1)?.retainedCommissionUsd ?? 0;

  assert.equal(economicTotal, 2659);
  assert.equal(projectedTotal, 2632.05);
  assert.equal(Math.round((projectedTotal + finalRetained) * 100) / 100, economicTotal);
});

test('crea liquidacion con ventas en cero para liberar un arrastre', () => {
  const rows = buildAdvisorCommissionShadowProjection({
    periods,
    advisors,
    facts: auditedFacts,
  });
  const bredyJulyOne = rows.find(
    (row) => row.advisorId === 'bredy' && row.periodId === 3
  );

  assert.ok(bredyJulyOne);
  assert.equal(bredyJulyOne.isSynthetic, true);
  assert.equal(bredyJulyOne.calculation.grossCommissionUsd, 0);
  assert.equal(bredyJulyOne.calculation.carriedCommissionUsd, 32.94);
  assert.equal(bredyJulyOne.calculation.payableUsd, 32.94);
});

test('reproduce las diferencias relevantes de Julio 2', () => {
  const rows = buildAdvisorCommissionShadowProjection({
    periods,
    advisors,
    facts: auditedFacts,
  });
  const julyTwo = rows.filter((row) => row.periodId === 4);
  const byAdvisor = new Map(julyTwo.map((row) => [row.advisorId, row]));

  assert.equal(byAdvisor.get('mariangela')?.calculation.payableUsd, 145.29);
  assert.equal(byAdvisor.get('ramon')?.calculation.payableUsd, 33.92);
  assert.equal(byAdvisor.get('ramon')?.calculation.retainedCommissionUsd, 26.94);
  assert.equal(byAdvisor.get('yujanir')?.calculation.payableUsd, 280.79);
  assert.equal(byAdvisor.get('yujanir')?.calculation.retainedCommissionUsd, 0.01);
});

test('rechaza hechos duplicados o referencias desconocidas', () => {
  assert.throws(
    () =>
      buildAdvisorCommissionShadowProjection({
        periods,
        advisors,
        facts: [auditedFacts[0], auditedFacts[0]],
      }),
    /mas de un hecho/
  );

  assert.throws(
    () =>
      buildAdvisorCommissionShadowProjection({
        periods,
        advisors,
        facts: [{ advisorId: 'desconocido', periodId: 2 }],
      }),
    /asesor desconocido/
  );
});
