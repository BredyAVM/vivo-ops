import {
  buildAdvisorGoalTarget,
  buildAdvisorNewClientTarget,
  calculateAdvisorGoalScore,
  calculateAdvisorGoalSeasonality,
  selectAdvisorGoalCapacity,
  type AdvisorGoalCapacity,
  type AdvisorGoalScore,
  type AdvisorGoalSeasonality,
} from './goal-engine.ts';
import type { AdvisorGoalCollectionSummary } from './goal-collection.ts';
import { advisorGoalPeriodIdentity } from './goal-period.ts';

export type AdvisorGoalCommercialMetricRow = {
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  periodYear: number;
  periodMonth: number;
  periodHalf: number;
  advisorUserId: string;
  advisorName: string;
  billingUsd: number;
  closuresCount: number;
  newOwnClientsCount: number;
  newAssignedClientsCount: number;
};

export type AdvisorGoalSimulationContext = {
  growthChallengePct: number;
  billingContextPct?: number;
  closuresContextPct?: number;
};

export type AdvisorGoalSimulatedMetric = {
  actual: number;
  history: Array<{ periodKey: string; value: number }>;
  capacity: AdvisorGoalCapacity;
  reference: number | null;
  appliedContextPct: number;
  expectedCapacity: number | null;
  growthChallengePct: number;
  target: number | null;
};

export type AdvisorGoalAdvisorSimulation = {
  advisorUserId: string;
  advisorName: string;
  metrics: {
    billing: AdvisorGoalSimulatedMetric;
    closures: AdvisorGoalSimulatedMetric;
    collection: AdvisorGoalSimulatedMetric;
    newOwnClients: AdvisorGoalSimulatedMetric;
    newAssignedClients: AdvisorGoalSimulatedMetric;
  };
  collection: AdvisorGoalCollectionSummary;
  score: AdvisorGoalScore | null;
  targetScore: AdvisorGoalScore | null;
  warning: string | null;
};

export type AdvisorGoalSimulation = {
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  cutoffDate: string;
  mode: 'projection' | 'active';
  seasonality: {
    billing: AdvisorGoalSeasonality;
    closures: AdvisorGoalSeasonality;
  };
  appliedContext: {
    growthChallengePct: number;
    billingPct: number;
    closuresPct: number;
  };
  advisors: AdvisorGoalAdvisorSimulation[];
};

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function datePlusDays(value: string, days: number) {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`La fecha ${value} no es válida.`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function previousHalfPeriod(year: number, month: number, half: number) {
  if (half === 2) return { year, month, half: 1 };
  if (month > 1) return { year, month: month - 1, half: 2 };
  return { year: year - 1, month: 12, half: 2 };
}

function key(year: number, month: number, half: number) {
  return `${year}-${String(month).padStart(2, '0')}-${half}`;
}

function safeContext(value: number | undefined, suggested: number) {
  const candidate = value ?? suggested;
  if (!Number.isFinite(candidate) || candidate <= -100) return 0;
  return round(candidate);
}

function seasonalSamples(params: {
  rows: AdvisorGoalCommercialMetricRow[];
  targetYear: number;
  targetMonth: number;
  targetHalf: number;
  metric: 'billingUsd' | 'closuresCount';
}) {
  const rowsByPeriodAdvisor = new Map(
    params.rows.map((row) => [`${row.periodKey}:${row.advisorUserId}`, row])
  );
  const advisorIds = new Set(params.rows.map((row) => row.advisorUserId));
  const samples = [];
  for (let year = params.targetYear - 1; year >= params.targetYear - 5; year -= 1) {
    const targetKey = key(year, params.targetMonth, params.targetHalf);
    const previous = previousHalfPeriod(year, params.targetMonth, params.targetHalf);
    const previousKey = key(previous.year, previous.month, previous.half);
    for (const advisorId of advisorIds) {
      const current = rowsByPeriodAdvisor.get(`${targetKey}:${advisorId}`);
      const prior = rowsByPeriodAdvisor.get(`${previousKey}:${advisorId}`);
      if (!current || !prior || prior[params.metric] <= 0) continue;
      samples.push({
        year,
        advisorId,
        previousValue: prior[params.metric],
        currentValue: current[params.metric],
      });
    }
  }
  return samples;
}

function observations(
  rows: AdvisorGoalCommercialMetricRow[],
  advisorUserId: string,
  targetFrom: string,
  metric: 'billingUsd' | 'closuresCount' | 'newOwnClientsCount' | 'newAssignedClientsCount'
) {
  return rows
    .filter((row) => row.advisorUserId === advisorUserId && row.periodFrom < targetFrom)
    .sort((left, right) => left.periodFrom.localeCompare(right.periodFrom))
    .slice(-6)
    .map((row) => ({ periodKey: row.periodKey, value: row[metric] }));
}

function commercialMetric(params: {
  actual: number;
  history: Array<{ periodKey: string; value: number }>;
  capacity: AdvisorGoalCapacity;
  contextPct: number;
  growthChallengePct: number;
  rounding?: 'none' | 'ceil';
}): AdvisorGoalSimulatedMetric {
  if (params.capacity.reference == null) {
    return {
      actual: params.actual,
      history: params.history,
      capacity: params.capacity,
      reference: null,
      appliedContextPct: params.contextPct,
      expectedCapacity: null,
      growthChallengePct: params.growthChallengePct,
      target: null,
    };
  }
  const target = buildAdvisorGoalTarget({
    personalReference: params.capacity.reference,
    appliedContextPct: params.contextPct,
    growthChallengePct: params.growthChallengePct,
    targetRounding: params.rounding,
  });
  return {
    actual: params.actual,
    history: params.history,
    capacity: params.capacity,
    reference: target.personalReference,
    appliedContextPct: target.appliedContextPct,
    expectedCapacity: target.expectedCapacity,
    growthChallengePct: target.growthChallengePct,
    target: target.target,
  };
}

function newClientMetric(params: {
  actual: number;
  history: Array<{ periodKey: string; value: number }>;
  capacity: AdvisorGoalCapacity;
}): AdvisorGoalSimulatedMetric {
  const reference = params.capacity.reference;
  return {
    actual: params.actual,
    history: params.history,
    capacity: params.capacity,
    reference,
    appliedContextPct: 0,
    expectedCapacity: reference,
    growthChallengePct: 0,
    target: reference == null ? null : buildAdvisorNewClientTarget(reference),
  };
}

const emptyCollection: AdvisorGoalCollectionSummary = {
  ratio: 0,
  ordersCount: 0,
  punctualCount: 0,
  creditCount: 0,
  overdueCount: 0,
  orders: [],
};

export function buildAdvisorGoalSimulation(params: {
  periodFrom: string;
  periodTo: string;
  metrics: AdvisorGoalCommercialMetricRow[];
  projectionAdvisors?: Array<{ advisorUserId: string; advisorName: string }>;
  collectionByAdvisorId?: Map<string, AdvisorGoalCollectionSummary>;
  context?: Partial<AdvisorGoalSimulationContext>;
  mode?: 'projection' | 'active';
}): AdvisorGoalSimulation {
  const actualTargetRows = params.metrics.filter((row) => row.periodFrom === params.periodFrom);
  const actualTargetByAdvisorId = new Map(
    actualTargetRows.map((row) => [row.advisorUserId, row])
  );
  const identity = advisorGoalPeriodIdentity(params.periodFrom);
  const targetRows = params.projectionAdvisors && params.projectionAdvisors.length > 0
    ? params.projectionAdvisors.map((advisor) => actualTargetByAdvisorId.get(advisor.advisorUserId) ?? {
        periodKey: identity.key,
        periodFrom: params.periodFrom,
        periodTo: params.periodTo,
        periodYear: identity.year,
        periodMonth: identity.month,
        periodHalf: identity.half,
        advisorUserId: advisor.advisorUserId,
        advisorName: advisor.advisorName,
        billingUsd: 0,
        closuresCount: 0,
        newOwnClientsCount: 0,
        newAssignedClientsCount: 0,
      })
    : actualTargetRows;
  if (targetRows.length === 0) {
    throw new Error('No hay asesores activos disponibles para proyectar este periodo.');
  }
  const target = targetRows[0];
  const billingSeasonality = calculateAdvisorGoalSeasonality(seasonalSamples({
    rows: params.metrics,
    targetYear: target.periodYear,
    targetMonth: target.periodMonth,
    targetHalf: target.periodHalf,
    metric: 'billingUsd',
  }));
  const closuresSeasonality = calculateAdvisorGoalSeasonality(seasonalSamples({
    rows: params.metrics,
    targetYear: target.periodYear,
    targetMonth: target.periodMonth,
    targetHalf: target.periodHalf,
    metric: 'closuresCount',
  }));
  const growthChallengePct = params.context?.growthChallengePct ?? 10;
  const billingContextPct = safeContext(params.context?.billingContextPct, billingSeasonality.suggestedPct);
  const closuresContextPct = safeContext(params.context?.closuresContextPct, closuresSeasonality.suggestedPct);

  const advisors = targetRows.map((row) => {
    const billingHistory = observations(params.metrics, row.advisorUserId, params.periodFrom, 'billingUsd');
    const closuresHistory = observations(params.metrics, row.advisorUserId, params.periodFrom, 'closuresCount');
    const newOwnHistory = observations(params.metrics, row.advisorUserId, params.periodFrom, 'newOwnClientsCount');
    const newAssignedHistory = observations(params.metrics, row.advisorUserId, params.periodFrom, 'newAssignedClientsCount');
    const billingCapacity = selectAdvisorGoalCapacity(billingHistory);
    const closuresCapacity = selectAdvisorGoalCapacity(closuresHistory);
    const newOwnCapacity = selectAdvisorGoalCapacity(newOwnHistory);
    const newAssignedCapacity = selectAdvisorGoalCapacity(newAssignedHistory);
    const billing = commercialMetric({
      actual: row.billingUsd,
      history: billingHistory,
      capacity: billingCapacity,
      contextPct: billingContextPct,
      growthChallengePct,
    });
    const closures = commercialMetric({
      actual: row.closuresCount,
      history: closuresHistory,
      capacity: closuresCapacity,
      contextPct: closuresContextPct,
      growthChallengePct,
      rounding: 'ceil',
    });
    const collection = params.collectionByAdvisorId?.get(row.advisorUserId) ?? emptyCollection;
    const newOwnClients = newClientMetric({ actual: row.newOwnClientsCount, history: newOwnHistory, capacity: newOwnCapacity });
    const newAssignedClients = newClientMetric({
      actual: row.newAssignedClientsCount,
      history: newAssignedHistory,
      capacity: newAssignedCapacity,
    });
    const missing = [billing, closures, newOwnClients, newAssignedClients].filter(
      (metric) => metric.reference == null || metric.target == null
    ).length;
    const score = missing > 0
      ? null
      : calculateAdvisorGoalScore([
          { key: 'billing', actual: billing.actual, reference: billing.reference ?? 0, target: billing.target ?? 0 },
          { key: 'closures', actual: closures.actual, reference: closures.reference ?? 0, target: closures.target ?? 0 },
          { key: 'collection', actual: collection.ratio, reference: 0.8, target: 1 },
          { key: 'new_own_clients', actual: newOwnClients.actual, reference: newOwnClients.reference ?? 0, target: newOwnClients.target ?? 0 },
          { key: 'new_assigned_clients', actual: newAssignedClients.actual, reference: newAssignedClients.reference ?? 0, target: newAssignedClients.target ?? 0 },
        ]);
    const targetScore = missing > 0
      ? null
      : calculateAdvisorGoalScore([
          { key: 'billing', actual: billing.target ?? 0, reference: billing.reference ?? 0, target: billing.target ?? 0 },
          { key: 'closures', actual: closures.target ?? 0, reference: closures.reference ?? 0, target: closures.target ?? 0 },
          { key: 'collection', actual: 1, reference: 0.8, target: 1 },
          { key: 'new_own_clients', actual: newOwnClients.target ?? 0, reference: newOwnClients.reference ?? 0, target: newOwnClients.target ?? 0 },
          { key: 'new_assigned_clients', actual: newAssignedClients.target ?? 0, reference: newAssignedClients.reference ?? 0, target: newAssignedClients.target ?? 0 },
        ]);

    return {
      advisorUserId: row.advisorUserId,
      advisorName: row.advisorName,
      metrics: {
        billing,
        closures,
        collection: {
          actual: collection.ratio,
          history: [],
          capacity: {
            reference: 0.8,
            medianAvailable: null,
            medianRecent: null,
            validPeriods: [],
            excludedPeriods: [],
            confidence: 'high' as const,
            requiresManualReference: false,
          },
          reference: 0.8,
          appliedContextPct: 0,
          expectedCapacity: 0.8,
          growthChallengePct: 0,
          target: 1,
        },
        newOwnClients,
        newAssignedClients,
      },
      collection,
      score,
      targetScore,
      warning: missing > 0 ? 'Faltan referencias históricas; administración debe completarlas antes de publicar.' : null,
    };
  }).sort((left, right) => left.advisorName.localeCompare(right.advisorName, 'es'));

  return {
    periodKey: target.periodKey,
    periodFrom: params.periodFrom,
    periodTo: params.periodTo,
    cutoffDate: datePlusDays(params.periodTo, 5),
    mode: params.mode ?? (actualTargetRows.length === 0 ? 'projection' : 'active'),
    seasonality: { billing: billingSeasonality, closures: closuresSeasonality },
    appliedContext: {
      growthChallengePct: round(growthChallengePct),
      billingPct: billingContextPct,
      closuresPct: closuresContextPct,
    },
    advisors,
  };
}
