import {
  calculateAdvisorCommissionSettlement,
  type AdvisorCommissionSettlementCalculation,
} from './settlement-engine.ts';

export type AdvisorCommissionProjectionPeriod = {
  id: number;
  name: string;
  dateFrom: string;
};

export type AdvisorCommissionProjectionAdvisor = {
  id: string;
  name: string;
};

export type AdvisorCommissionLegacyPeriodFact = {
  advisorId: string;
  periodId: number;
  closureId?: number | null;
  legacyPayableUsd?: number;
  grossCommissionUsd?: number;
  positiveAdjustmentsUsd?: number;
  giftDeductionsUsd?: number;
  directDeductionsUsd?: number;
  negativeAdjustmentsUsd?: number;
  outstandingCustomerDebtUsd?: number;
};

export type AdvisorCommissionProjectionRow = {
  advisorId: string;
  advisorName: string;
  periodId: number;
  periodName: string;
  dateFrom: string;
  closureId: number | null;
  isSynthetic: boolean;
  legacyPayableUsd: number;
  currentPeriodEconomicCreditUsd: number;
  calculation: AdvisorCommissionSettlementCalculation;
};

export type AdvisorCommissionProjectionPeriodSummary = {
  periodId: number;
  periodName: string;
  dateFrom: string;
  legacyPayableUsd: number;
  currentPeriodEconomicCreditUsd: number;
  projectedPayableUsd: number;
  retainedCommissionUsd: number;
};

function roundUsd(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function projectionKey(advisorId: string, periodId: number) {
  return `${advisorId}:${periodId}`;
}

function validateProjectionInputs(params: {
  periods: AdvisorCommissionProjectionPeriod[];
  advisors: AdvisorCommissionProjectionAdvisor[];
  facts: AdvisorCommissionLegacyPeriodFact[];
}) {
  const periodIds = new Set<number>();
  for (const period of params.periods) {
    if (!Number.isInteger(period.id) || period.id <= 0 || !period.name || !period.dateFrom) {
      throw new Error('Cada periodo de la proyeccion debe tener id, nombre y fecha validos.');
    }
    if (periodIds.has(period.id)) {
      throw new Error(`El periodo ${period.id} esta duplicado en la proyeccion.`);
    }
    periodIds.add(period.id);
  }

  const advisorIds = new Set<string>();
  for (const advisor of params.advisors) {
    if (!advisor.id || !advisor.name) {
      throw new Error('Cada asesor de la proyeccion debe tener id y nombre.');
    }
    if (advisorIds.has(advisor.id)) {
      throw new Error(`El asesor ${advisor.id} esta duplicado en la proyeccion.`);
    }
    advisorIds.add(advisor.id);
  }

  const factKeys = new Set<string>();
  for (const fact of params.facts) {
    if (!advisorIds.has(fact.advisorId)) {
      throw new Error(`El hecho referencia al asesor desconocido ${fact.advisorId}.`);
    }
    if (!periodIds.has(fact.periodId)) {
      throw new Error(`El hecho referencia al periodo desconocido ${fact.periodId}.`);
    }

    const key = projectionKey(fact.advisorId, fact.periodId);
    if (factKeys.has(key)) {
      throw new Error(`Existe mas de un hecho para ${key}.`);
    }
    factKeys.add(key);
  }
}

export function buildAdvisorCommissionShadowProjection(params: {
  periods: AdvisorCommissionProjectionPeriod[];
  advisors: AdvisorCommissionProjectionAdvisor[];
  facts: AdvisorCommissionLegacyPeriodFact[];
}): AdvisorCommissionProjectionRow[] {
  validateProjectionInputs(params);

  const periods = [...params.periods].sort((left, right) =>
    left.dateFrom.localeCompare(right.dateFrom)
  );
  const factsByKey = new Map(
    params.facts.map((fact) => [projectionKey(fact.advisorId, fact.periodId), fact])
  );
  const rows: AdvisorCommissionProjectionRow[] = [];

  for (const advisor of params.advisors) {
    let carriedCommissionUsd = 0;
    let priorAdvisorDebtUsd = 0;

    for (const period of periods) {
      const fact = factsByKey.get(projectionKey(advisor.id, period.id));
      const currentPeriodCalculation = calculateAdvisorCommissionSettlement({
        grossCommissionUsd: fact?.grossCommissionUsd ?? 0,
        positiveAdjustmentsUsd: fact?.positiveAdjustmentsUsd,
        giftDeductionsUsd: fact?.giftDeductionsUsd,
        directDeductionsUsd: fact?.directDeductionsUsd,
        negativeAdjustmentsUsd: fact?.negativeAdjustmentsUsd,
      });
      const calculation = calculateAdvisorCommissionSettlement({
        carriedCommissionUsd,
        priorAdvisorDebtUsd,
        grossCommissionUsd: fact?.grossCommissionUsd ?? 0,
        positiveAdjustmentsUsd: fact?.positiveAdjustmentsUsd,
        giftDeductionsUsd: fact?.giftDeductionsUsd,
        directDeductionsUsd: fact?.directDeductionsUsd,
        negativeAdjustmentsUsd: fact?.negativeAdjustmentsUsd,
        outstandingCustomerDebtUsd: fact?.outstandingCustomerDebtUsd,
      });

      rows.push({
        advisorId: advisor.id,
        advisorName: advisor.name,
        periodId: period.id,
        periodName: period.name,
        dateFrom: period.dateFrom,
        closureId: fact?.closureId ?? null,
        isSynthetic: !fact?.closureId,
        legacyPayableUsd: roundUsd(fact?.legacyPayableUsd ?? 0),
        currentPeriodEconomicCreditUsd: roundUsd(
          currentPeriodCalculation.creditBeforeDeductionsUsd
            - currentPeriodCalculation.requestedDeductionsUsd
        ),
        calculation,
      });

      carriedCommissionUsd = calculation.retainedCommissionUsd;
      priorAdvisorDebtUsd = calculation.advisorDebtOutUsd;
    }
  }

  return rows.sort((left, right) => {
    const dateOrder = left.dateFrom.localeCompare(right.dateFrom);
    if (dateOrder !== 0) return dateOrder;
    return left.advisorName.localeCompare(right.advisorName, 'es');
  });
}

export function summarizeAdvisorCommissionShadowProjection(
  rows: AdvisorCommissionProjectionRow[]
): AdvisorCommissionProjectionPeriodSummary[] {
  const summaries = new Map<number, AdvisorCommissionProjectionPeriodSummary>();

  for (const row of rows) {
    const summary = summaries.get(row.periodId) ?? {
      periodId: row.periodId,
      periodName: row.periodName,
      dateFrom: row.dateFrom,
      legacyPayableUsd: 0,
      currentPeriodEconomicCreditUsd: 0,
      projectedPayableUsd: 0,
      retainedCommissionUsd: 0,
    };

    summary.legacyPayableUsd = roundUsd(
      summary.legacyPayableUsd + row.legacyPayableUsd
    );
    summary.currentPeriodEconomicCreditUsd = roundUsd(
      summary.currentPeriodEconomicCreditUsd + row.currentPeriodEconomicCreditUsd
    );
    summary.projectedPayableUsd = roundUsd(
      summary.projectedPayableUsd + row.calculation.payableUsd
    );
    summary.retainedCommissionUsd = roundUsd(
      summary.retainedCommissionUsd + row.calculation.retainedCommissionUsd
    );

    summaries.set(row.periodId, summary);
  }

  return Array.from(summaries.values()).sort((left, right) =>
    left.dateFrom.localeCompare(right.dateFrom)
  );
}
