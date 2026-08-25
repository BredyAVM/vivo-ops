import type { AdvisorGoalAdvisorSimulation, AdvisorGoalSimulatedMetric, AdvisorGoalSimulation } from './goal-simulation.ts';
import type {
  AdvisorGoalAuditEntry,
  AdvisorGoalMetricPublication,
  AdvisorGoalPeriodConfig,
  AdvisorGoalPublicationSnapshot,
  AdvisorGoalScoringConfiguration,
} from './goal-snapshot.ts';
import { resolveAdvisorGoalScoringConfiguration } from './goal-snapshot.ts';

type PublicationIntent = 'draft' | 'publish' | 'finalize';

function metricPublication(metric: AdvisorGoalSimulatedMetric): AdvisorGoalMetricPublication {
  if (
    metric.reference == null
    || metric.expectedCapacity == null
    || metric.campaignCapacity == null
    || metric.target == null
  ) {
    throw new Error('Todas las referencias deben estar completas antes de guardar la meta.');
  }
  return {
    actual: metric.actual,
    history: metric.history,
    recentContext: metric.recentContext,
    medianAvailable: metric.capacity.medianAvailable ?? metric.reference,
    medianRecent: metric.capacity.medianRecent ?? metric.capacity.medianAvailable ?? metric.reference,
    personalReference: metric.reference,
    appliedContextPct: metric.appliedContextPct,
    expectedCapacity: metric.expectedCapacity,
    campaignBoostPct: metric.campaignBoostPct,
    campaignCapacity: metric.campaignCapacity,
    growthChallengePct: metric.growthChallengePct,
    target: metric.target,
    validPeriods: metric.capacity.validPeriods,
    excludedPeriods: metric.capacity.excludedPeriods,
  };
}

function compactPeriodConfig(simulation: AdvisorGoalSimulation) {
  return {
    periodKey: simulation.periodKey,
    growthChallengePct: simulation.appliedContext.growthChallengePct,
    campaignBoostPct: simulation.appliedContext.campaignBoostPct,
    billingContextPct: simulation.appliedContext.billingPct,
    closuresContextPct: simulation.appliedContext.closuresPct,
    scoring: compactScoring(simulation),
  };
}

function compactScoring(simulation: AdvisorGoalSimulation): AdvisorGoalScoringConfiguration {
  return {
    metricBasePoints: Object.fromEntries(
      simulation.scoring.metrics.map((metric) => [metric.key, metric.basePoints])
    ) as AdvisorGoalScoringConfiguration['metricBasePoints'],
    bands: simulation.scoring.bands.map((band) => ({ ...band })),
  };
}

function compactAdvisorGoal(advisor: AdvisorGoalAdvisorSimulation) {
  return {
    advisorUserId: advisor.advisorUserId,
    points: advisor.score?.points ?? null,
    band: advisor.score?.band.label ?? null,
    calculatedCommissionPct: advisor.score?.calculatedCommissionPct ?? null,
  };
}

function nextAction(params: {
  previousRevision: number;
  intent: PublicationIntent;
  wasPublished: boolean;
}): AdvisorGoalAuditEntry['action'] {
  if (params.intent === 'finalize') return 'finalized';
  if (params.previousRevision > 0) {
    return params.intent === 'publish' && !params.wasPublished ? 'published' : 'modified';
  }
  return params.intent === 'publish' ? 'published' : 'generated';
}

export function buildAdvisorGoalPublicationBundle(params: {
  simulation: AdvisorGoalSimulation;
  periodId: number;
  intent: PublicationIntent;
  reason: string;
  publicationMessage: string | null;
  actorUserId: string;
  recordedAt: string;
  previousConfig: AdvisorGoalPeriodConfig | null;
  previousByAdvisorId: Map<string, AdvisorGoalPublicationSnapshot>;
  commissionOverrideByAdvisorId?: Map<string, { commissionPct: number; reason: string }>;
}) {
  const reason = params.reason.trim();
  const nextScoring = compactScoring(params.simulation);
  const previousScoring = resolveAdvisorGoalScoringConfiguration(params.previousConfig);
  const configurationChanged = Boolean(params.previousConfig) && (
    params.previousConfig?.growthChallengePct !== params.simulation.appliedContext.growthChallengePct
    || (params.previousConfig?.campaignBoostPct ?? 0) !== params.simulation.appliedContext.campaignBoostPct
    || params.previousConfig?.billing.appliedPct !== params.simulation.appliedContext.billingPct
    || params.previousConfig?.closures.appliedPct !== params.simulation.appliedContext.closuresPct
    || JSON.stringify(previousScoring) !== JSON.stringify(nextScoring)
    || params.previousConfig?.publicationMessage !== params.publicationMessage
  );
  if (configurationChanged && !reason) {
    throw new Error('Indica el motivo de la modificación para conservar la trazabilidad.');
  }
  if (params.simulation.advisors.some((advisor) => advisor.score == null)) {
    throw new Error('No se puede guardar mientras un asesor requiera una referencia manual.');
  }

  const previousRevision = params.previousConfig?.revision ?? 0;
  const revision = previousRevision + 1;
  const wasPublished = params.previousConfig?.status === 'published' || params.previousConfig?.status === 'closed';
  const published = params.intent === 'publish' || params.intent === 'finalize' || wasPublished;
  const action = nextAction({ previousRevision, intent: params.intent, wasPublished });
  const periodAudit: AdvisorGoalAuditEntry = {
    version: revision,
    action,
    recordedAt: params.recordedAt,
    recordedByUserId: params.actorUserId,
    reason: reason || null,
    previous: params.previousConfig ? {
      growthChallengePct: params.previousConfig.growthChallengePct,
      campaignBoostPct: params.previousConfig.campaignBoostPct ?? 0,
      billingContextPct: params.previousConfig.billing.appliedPct,
      closuresContextPct: params.previousConfig.closures.appliedPct,
      scoring: previousScoring,
    } : null,
    next: compactPeriodConfig(params.simulation),
  };
  const config: AdvisorGoalPeriodConfig = {
    version: 1,
    status: params.intent === 'finalize' ? 'closed' : published ? 'published' : 'draft',
    growthChallengePct: params.simulation.appliedContext.growthChallengePct,
    campaignBoostPct: params.simulation.appliedContext.campaignBoostPct,
    scoring: nextScoring,
    billing: {
      observed: params.simulation.seasonality.billing,
      appliedPct: params.simulation.appliedContext.billingPct,
      reason: reason || params.previousConfig?.billing.reason || 'Sugerencia histórica aceptada para la simulación inicial.',
    },
    closures: {
      observed: params.simulation.seasonality.closures,
      appliedPct: params.simulation.appliedContext.closuresPct,
      reason: reason || params.previousConfig?.closures.reason || 'Sugerencia histórica aceptada para la simulación inicial.',
    },
    publicationMessage: params.publicationMessage,
    generatedAt: params.recordedAt,
    generatedByUserId: params.actorUserId,
    publishedAt: published ? params.previousConfig?.publishedAt ?? params.recordedAt : null,
    publishedByUserId: published ? params.previousConfig?.publishedByUserId ?? params.actorUserId : null,
    revision,
    audit: [...(params.previousConfig?.audit ?? []), periodAudit],
  };

  const publications = params.simulation.advisors.map((advisor) => {
    const score = advisor.score;
    if (!score) throw new Error(`La meta de ${advisor.advisorName} no está completa.`);
    const previous = params.previousByAdvisorId.get(advisor.advisorUserId) ?? null;
    const advisorRevision = (previous?.revision ?? 0) + 1;
    const advisorWasPublished = previous?.status === 'published' || previous?.status === 'final';
    const advisorPublished = params.intent === 'publish' || params.intent === 'finalize' || advisorWasPublished;
    const advisorAction = nextAction({
      previousRevision: previous?.revision ?? 0,
      intent: params.intent,
      wasPublished: advisorWasPublished,
    });
    const audit: AdvisorGoalAuditEntry = {
      version: advisorRevision,
      action: advisorAction,
      recordedAt: params.recordedAt,
      recordedByUserId: params.actorUserId,
      reason: reason || null,
      previous: previous ? {
        points: previous.score.points,
        band: previous.score.band.label,
        calculatedCommissionPct: previous.calculatedCommissionPct,
        appliedCommissionPct: previous.appliedCommissionPct,
      } : null,
      next: compactAdvisorGoal(advisor),
    };
    const override = params.commissionOverrideByAdvisorId?.get(advisor.advisorUserId) ?? null;
    if (override && (!Number.isFinite(override.commissionPct) || override.commissionPct < 0 || override.commissionPct > 100)) {
      throw new Error(`El porcentaje aplicado a ${advisor.advisorName} no es válido.`);
    }
    const overrideDiffers = Boolean(override) && Math.abs((override?.commissionPct ?? 0) - score.calculatedCommissionPct) > 0.0001;
    if (overrideDiffers && !override?.reason.trim()) {
      throw new Error(`Indica el motivo para sustituir el porcentaje de ${advisor.advisorName}.`);
    }
    const appliedCommissionPct = override?.commissionPct
      ?? (previous?.rateOverrideReason ? previous.appliedCommissionPct : score.calculatedCommissionPct);
    const rateOverrideReason = overrideDiffers
      ? override?.reason.trim() || null
      : override
        ? null
        : previous?.rateOverrideReason ?? null;
    const auditEntries = [...(previous?.audit ?? []), audit];
    if (overrideDiffers) {
      auditEntries.push({
        version: advisorRevision,
        action: 'rate_overridden',
        recordedAt: params.recordedAt,
        recordedByUserId: params.actorUserId,
        reason: rateOverrideReason,
        previous: { calculatedCommissionPct: score.calculatedCommissionPct },
        next: { appliedCommissionPct },
      });
    }
    const publication: AdvisorGoalPublicationSnapshot = {
      version: 1,
      status: params.intent === 'finalize' ? 'final' : advisorPublished ? 'published' : 'draft',
      periodId: params.periodId,
      advisorUserId: advisor.advisorUserId,
      advisorName: advisor.advisorName,
      generatedAt: params.recordedAt,
      generatedByUserId: params.actorUserId,
      publishedAt: advisorPublished ? previous?.publishedAt ?? params.recordedAt : null,
      publishedByUserId: advisorPublished ? previous?.publishedByUserId ?? params.actorUserId : null,
      revision: advisorRevision,
      explanation: params.simulation.referenceLagPeriods === 1
        ? `Referencia personal estable con desfase de una quincena; el periodo inmediatamente anterior se muestra como contexto y no altera la meta. Temporada ${params.simulation.appliedContext.billingPct}% en facturación y ${params.simulation.appliedContext.closuresPct}% en cierres, campaña ${params.simulation.appliedContext.campaignBoostPct}% y desafío ${params.simulation.appliedContext.growthChallengePct}%.`
        : `Referencia personal estable, temporada ${params.simulation.appliedContext.billingPct}% en facturación y ${params.simulation.appliedContext.closuresPct}% en cierres, campaña ${params.simulation.appliedContext.campaignBoostPct}% y desafío ${params.simulation.appliedContext.growthChallengePct}%.`,
      publicationMessage: params.publicationMessage,
      calculatedCommissionPct: score.calculatedCommissionPct,
      appliedCommissionPct,
      rateOverrideReason,
      score,
      metrics: {
        billing: metricPublication(advisor.metrics.billing),
        closures: metricPublication(advisor.metrics.closures),
        collection: metricPublication(advisor.metrics.collection),
        new_own_clients: metricPublication(advisor.metrics.newOwnClients),
        new_assigned_clients: metricPublication(advisor.metrics.newAssignedClients),
      },
      audit: auditEntries,
    };
    return { advisorUserId: advisor.advisorUserId, publication };
  });

  return { config, publications };
}
