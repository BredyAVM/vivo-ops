import { calculateAdvisorGoalScore, type AdvisorGoalMetricKey } from './goal-engine.ts';
import type { AdvisorGoalAdvisorSimulation, AdvisorGoalSimulation } from './goal-simulation.ts';
import type { AdvisorGoalPublicationSnapshot } from './goal-snapshot.ts';

const metricKeys = {
  billing: 'billing',
  closures: 'closures',
  collection: 'collection',
  newOwnClients: 'new_own_clients',
  newAssignedClients: 'new_assigned_clients',
} as const;

// Applying a result must use the targets the advisor received, even if a
// historical import or correction has changed today's capacity suggestion.
export function withPublishedAdvisorGoalTargets(
  simulation: AdvisorGoalSimulation,
  publications: Map<string, AdvisorGoalPublicationSnapshot>,
  preserveFinal = true,
): AdvisorGoalSimulation {
  const points = Object.fromEntries(simulation.scoring.metrics.map((metric) => [metric.key, metric.basePoints]));
  return {
    ...simulation,
    advisors: simulation.advisors.map((advisor) => {
      const previous = publications.get(advisor.advisorUserId);
      if (!previous || previous.status === 'draft') return advisor;
      const entries = Object.entries(metricKeys).map(([name, key]) => {
        const current = advisor.metrics[name as keyof typeof metricKeys];
        const published = previous.metrics[key];
        if (!published) throw new Error(`La meta publicada de ${advisor.advisorName} está incompleta.`);
        return [name, {
          ...current,
          history: published.history,
          recentContext: published.recentContext ?? null,
          reference: published.personalReference,
          appliedContextPct: published.appliedContextPct,
          expectedCapacity: published.expectedCapacity,
          campaignBoostPct: published.campaignBoostPct ?? 0,
          campaignCapacity: published.campaignCapacity ?? published.expectedCapacity,
          growthChallengePct: published.growthChallengePct,
          target: published.target,
          actual: preserveFinal && previous.status === 'final' ? published.actual : current.actual,
        }];
      });
      const metrics = Object.fromEntries(entries) as AdvisorGoalAdvisorSimulation['metrics'];
      const score = preserveFinal && previous.status === 'final' ? previous.score : calculateAdvisorGoalScore(
        Object.entries(metricKeys).map(([name, key]) => ({
          key: key as AdvisorGoalMetricKey,
          actual: metrics[name as keyof typeof metricKeys].actual,
          reference: metrics[name as keyof typeof metricKeys].reference ?? 0,
          target: metrics[name as keyof typeof metricKeys].target ?? 0,
          basePoints: points[key],
        })), simulation.scoring.bands,
      );
      return { ...advisor, metrics, score, warning: null };
    }),
  };
}

export function advisorGoalFinalizationBlock(params: {
  advisor: AdvisorGoalAdvisorSimulation;
  periodTo: string;
  cutoffDate: string;
  today: string;
}) {
  if (params.today <= params.periodTo) return 'El período todavía está en curso.';
  if (params.advisor.collection.ordersCount !== params.advisor.metrics.closures.actual) {
    return 'Actualiza su preliminar para verificar la cobranza de todos los pedidos del período.';
  }
  if (params.advisor.collection.orders.some((order) => order.status === 'missing_registration')) {
    return 'Hay pagos cuya fecha de registro debe verificarse antes de confirmar el resultado.';
  }
  if (params.today < params.cutoffDate && params.advisor.collection.orders.some((order) => order.pendingUsd > 0.005)) {
    return `Este asesor tiene cobranza pendiente. Puedes aplicar el preliminar y confirmar desde el ${params.cutoffDate}, o antes si se completa su cobranza.`;
  }
  return null;
}

export function buildAdvisorGoalResultApplication(params: {
  advisor: AdvisorGoalAdvisorSimulation;
  previous: AdvisorGoalPublicationSnapshot;
  closureStatus: string;
  intent: 'automatic' | 'preliminary' | 'final';
  override?: { commissionPct: number; reason: string } | null;
  actorUserId: string;
  recordedAt: string;
  reason?: string;
}) {
  if (params.closureStatus !== 'preliminary') return null;
  if (params.intent === 'automatic' && params.previous.status === 'final') return params.previous;
  if (params.intent === 'preliminary' && params.previous.status === 'final') {
    throw new Error('Este asesor ya tiene resultado final. Utiliza la rectificación con su motivo.');
  }
  if (params.previous.status === 'draft' || !params.advisor.score) {
    throw new Error(`Primero publica una meta completa para ${params.advisor.advisorName}.`);
  }
  if (params.previous.status === 'final' && !params.reason?.trim()) {
    throw new Error('Indica el motivo de la rectificación del resultado final.');
  }
  const score = params.advisor.score;
  const override = params.override === undefined
    ? params.previous.rateOverrideReason
      ? { commissionPct: params.previous.appliedCommissionPct, reason: params.previous.rateOverrideReason }
      : null
    : params.override;
  if (override && (!Number.isFinite(override.commissionPct) || override.commissionPct < 0 || override.commissionPct > 100)) {
    throw new Error('El porcentaje manual debe estar entre 0 y 100.');
  }
  if (override && !override.reason.trim()) throw new Error('Indica el motivo del porcentaje manual.');
  const appliedCommissionPct = override?.commissionPct ?? score.calculatedCommissionPct;
  const rateOverrideReason = override?.reason.trim() || null;
  const status = params.intent === 'final' ? 'final' : 'provisional';
  const metrics = Object.fromEntries(Object.entries(metricKeys).map(([name, key]) => [key, {
    ...params.previous.metrics[key], actual: params.advisor.metrics[name as keyof typeof metricKeys].actual,
  }]));
  if (params.intent === 'automatic' && params.previous.status === status
    && params.previous.appliedCommissionPct === appliedCommissionPct
    && params.previous.rateOverrideReason === rateOverrideReason
    && JSON.stringify(params.previous.score) === JSON.stringify(score)
    && JSON.stringify(params.previous.metrics) === JSON.stringify(metrics)) return params.previous;
  const revision = params.previous.revision + 1;
  const publication: AdvisorGoalPublicationSnapshot = {
    ...params.previous,
    status, score, metrics, revision, calculatedCommissionPct: score.calculatedCommissionPct,
    appliedCommissionPct, rateOverrideReason,
    generatedAt: params.recordedAt, generatedByUserId: params.actorUserId,
    audit: [...params.previous.audit, {
      version: revision,
      action: params.intent === 'final' ? 'finalized' : 'result_applied',
      recordedAt: params.recordedAt, recordedByUserId: params.actorUserId,
      reason: params.reason?.trim() || rateOverrideReason || null,
      previous: { points: params.previous.score.points, appliedCommissionPct: params.previous.appliedCommissionPct },
      next: { points: score.points, calculatedCommissionPct: score.calculatedCommissionPct, appliedCommissionPct, status },
    }],
  };
  if (rateOverrideReason !== params.previous.rateOverrideReason || appliedCommissionPct !== params.previous.appliedCommissionPct && override) {
    publication.audit.push({
      version: revision, action: 'rate_overridden', recordedAt: params.recordedAt,
      recordedByUserId: params.actorUserId, reason: rateOverrideReason || 'Restablecido el porcentaje automático de la meta.',
      previous: { appliedCommissionPct: params.previous.appliedCommissionPct },
      next: { appliedCommissionPct, automatic: !override },
    });
  }
  return publication;
}
