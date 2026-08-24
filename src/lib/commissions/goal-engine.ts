export const ADVISOR_GOAL_TOTAL_BASE_POINTS = 200;
export const ADVISOR_GOAL_CAP_MULTIPLIER = 2;
export const ADVISOR_GOAL_REFERENCE_PROGRESS = 0.8;

export type AdvisorGoalMetricKey =
  | 'billing'
  | 'closures'
  | 'collection'
  | 'new_own_clients'
  | 'new_assigned_clients';

export type AdvisorGoalMetricDefinition = {
  key: AdvisorGoalMetricKey;
  label: string;
  weightPct: number;
  basePoints: number;
};

export const ADVISOR_GOAL_METRICS: readonly AdvisorGoalMetricDefinition[] = [
  { key: 'billing', label: 'Facturación', weightPct: 50, basePoints: 100 },
  { key: 'closures', label: 'Cierres', weightPct: 20, basePoints: 40 },
  { key: 'collection', label: 'Cobranza', weightPct: 10, basePoints: 20 },
  { key: 'new_own_clients', label: 'Clientes nuevos propios', weightPct: 15, basePoints: 30 },
  { key: 'new_assigned_clients', label: 'Clientes nuevos asignados', weightPct: 5, basePoints: 10 },
] as const;

export type AdvisorGoalBandKey = 'yuca' | 'bronze' | 'silver' | 'gold' | 'platinum';

export type AdvisorGoalBand = {
  key: AdvisorGoalBandKey;
  label: string;
  minPoints: number;
  commissionPct: number;
};

export const ADVISOR_GOAL_BANDS: readonly AdvisorGoalBand[] = [
  { key: 'yuca', label: 'Yuca', minPoints: 0, commissionPct: 8 },
  { key: 'bronze', label: 'Bronce', minPoints: 140, commissionPct: 9 },
  { key: 'silver', label: 'Plata', minPoints: 170, commissionPct: 10 },
  { key: 'gold', label: 'Oro', minPoints: 200, commissionPct: 11 },
  { key: 'platinum', label: 'Platino', minPoints: 240, commissionPct: 12 },
] as const;

export type AdvisorGoalObservation = {
  periodKey: string;
  value: number;
  excluded?: boolean;
};

export type AdvisorGoalCapacity = {
  reference: number | null;
  medianAvailable: number | null;
  medianRecent: number | null;
  validPeriods: string[];
  excludedPeriods: string[];
  confidence: 'high' | 'medium' | 'manual';
  requiresManualReference: boolean;
};

export type AdvisorGoalSeasonalSample = {
  year: number;
  advisorId: string;
  previousValue: number;
  currentValue: number;
};

export type AdvisorGoalSeasonality = {
  suggestedPct: number;
  typicalLowPct: number;
  typicalHighPct: number;
  sampleCount: number;
  yearCount: number;
  confidence: 'high' | 'medium' | 'low';
};

export type AdvisorGoalTarget = {
  personalReference: number;
  appliedContextPct: number;
  expectedCapacity: number;
  growthChallengePct: number;
  target: number;
};

export type AdvisorGoalMetricInput = {
  key: AdvisorGoalMetricKey;
  actual: number;
  reference: number;
  target: number;
  basePoints?: number;
};

export type AdvisorGoalMetricResult = AdvisorGoalMetricInput & {
  basePoints: number;
  points: number;
  progressToReference: number;
  progressToTarget: number;
};

export type AdvisorGoalScore = {
  points: number;
  calculatedCommissionPct: number;
  band: AdvisorGoalBand;
  metrics: AdvisorGoalMetricResult[];
};

export type AdvisorGoalCollectionOrder = {
  deliveryDate: string;
  completedPaymentRegistrationDate?: string | null;
  paymentValidated: boolean;
};

function finiteNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} debe ser un número mayor o igual a cero.`);
  }
  return value;
}

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values: number[], position: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(1, position)) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function dateOnlyToUtc(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`La fecha ${value} debe usar el formato AAAA-MM-DD.`);
  }
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`La fecha ${value} no es válida.`);
  return parsed;
}

function metricDefinition(key: AdvisorGoalMetricKey) {
  const definition = ADVISOR_GOAL_METRICS.find((metric) => metric.key === key);
  if (!definition) throw new Error(`El indicador ${key} no está configurado.`);
  return definition;
}

export function validateAdvisorGoalConfiguration(params?: {
  metrics?: readonly AdvisorGoalMetricDefinition[];
  bands?: readonly AdvisorGoalBand[];
}) {
  const metrics = params?.metrics ?? ADVISOR_GOAL_METRICS;
  const bands = params?.bands ?? ADVISOR_GOAL_BANDS;
  const metricKeys = new Set<AdvisorGoalMetricKey>();
  const totalWeight = metrics.reduce((sum, metric) => {
    if (metricKeys.has(metric.key)) throw new Error(`El indicador ${metric.key} está duplicado.`);
    metricKeys.add(metric.key);
    finiteNonNegative(metric.weightPct, `El peso de ${metric.key}`);
    finiteNonNegative(metric.basePoints, `Los puntos de ${metric.key}`);
    return sum + metric.weightPct;
  }, 0);
  const totalPoints = metrics.reduce((sum, metric) => sum + metric.basePoints, 0);

  if (round(totalWeight, 6) !== 100) throw new Error('Los pesos de las metas deben sumar 100%.');
  if (round(totalPoints, 6) !== ADVISOR_GOAL_TOTAL_BASE_POINTS) {
    throw new Error(`Los puntos base deben sumar ${ADVISOR_GOAL_TOTAL_BASE_POINTS}.`);
  }
  if (metricKeys.size !== ADVISOR_GOAL_METRICS.length) {
    throw new Error('La configuración debe contener los cinco indicadores canónicos.');
  }

  const orderedBands = [...bands].sort((left, right) => left.minPoints - right.minPoints);
  if (orderedBands.length === 0 || orderedBands[0].minPoints !== 0) {
    throw new Error('Las bandas deben comenzar en cero puntos.');
  }
  for (let index = 1; index < orderedBands.length; index += 1) {
    if (orderedBands[index].minPoints <= orderedBands[index - 1].minPoints) {
      throw new Error('Los mínimos de las bandas deben crecer sin duplicados.');
    }
  }
}

export function selectAdvisorGoalCapacity(observations: AdvisorGoalObservation[]): AdvisorGoalCapacity {
  const excludedPeriods = observations
    .filter((observation) => observation.excluded)
    .map((observation) => observation.periodKey);
  const valid = observations
    .filter((observation) => !observation.excluded)
    .map((observation) => ({
      ...observation,
      value: finiteNonNegative(observation.value, `El valor de ${observation.periodKey}`),
    }))
    .slice(-6);

  if (valid.length < 3) {
    return {
      reference: null,
      medianAvailable: median(valid.map((observation) => observation.value)),
      medianRecent: null,
      validPeriods: valid.map((observation) => observation.periodKey),
      excludedPeriods,
      confidence: 'manual',
      requiresManualReference: true,
    };
  }

  const medianAvailable = median(valid.map((observation) => observation.value)) ?? 0;
  const medianRecent = median(valid.slice(-3).map((observation) => observation.value)) ?? 0;

  return {
    reference: round(Math.max(medianAvailable, medianRecent)),
    medianAvailable: round(medianAvailable),
    medianRecent: round(medianRecent),
    validPeriods: valid.map((observation) => observation.periodKey),
    excludedPeriods,
    confidence: valid.length >= 6 ? 'high' : 'medium',
    requiresManualReference: false,
  };
}

export function calculateAdvisorGoalSeasonality(
  samples: AdvisorGoalSeasonalSample[]
): AdvisorGoalSeasonality {
  const validSamples = samples.filter((sample) => {
    finiteNonNegative(sample.previousValue, `El valor anterior de ${sample.year}`);
    finiteNonNegative(sample.currentValue, `El valor actual de ${sample.year}`);
    return Number.isInteger(sample.year) && sample.previousValue > 0;
  });
  const changes = validSamples.map(
    (sample) => (sample.currentValue / sample.previousValue - 1) * 100
  );
  const years = new Set(validSamples.map((sample) => sample.year));
  const sampleCount = changes.length;
  const yearCount = years.size;
  const confidence = sampleCount >= 10 && yearCount >= 3
    ? 'high'
    : sampleCount >= 6 && yearCount >= 2
      ? 'medium'
      : 'low';

  return {
    suggestedPct: round(median(changes) ?? 0),
    typicalLowPct: round(quantile(changes, 0.25)),
    typicalHighPct: round(quantile(changes, 0.75)),
    sampleCount,
    yearCount,
    confidence,
  };
}

export function buildAdvisorGoalTarget(params: {
  personalReference: number;
  appliedContextPct?: number;
  growthChallengePct?: number;
  targetRounding?: 'none' | 'ceil';
}): AdvisorGoalTarget {
  const personalReference = finiteNonNegative(params.personalReference, 'La referencia personal');
  const appliedContextPct = params.appliedContextPct ?? 0;
  const growthChallengePct = params.growthChallengePct ?? 10;
  if (!Number.isFinite(appliedContextPct) || appliedContextPct <= -100) {
    throw new Error('El ajuste de contexto debe ser mayor a -100%.');
  }
  finiteNonNegative(growthChallengePct, 'El desafío de crecimiento');

  const expectedCapacity = personalReference * (1 + appliedContextPct / 100);
  const rawTarget = expectedCapacity * (1 + growthChallengePct / 100);
  const target = params.targetRounding === 'ceil' ? Math.ceil(rawTarget) : round(rawTarget);

  return {
    personalReference: round(personalReference),
    appliedContextPct: round(appliedContextPct),
    expectedCapacity: round(expectedCapacity),
    growthChallengePct: round(growthChallengePct),
    target,
  };
}

export function buildAdvisorNewClientTarget(personalReference: number) {
  const reference = finiteNonNegative(personalReference, 'La referencia de clientes nuevos');
  return Math.ceil(reference) + 1;
}

export function calculateAdvisorGoalMetricPoints(input: AdvisorGoalMetricInput): AdvisorGoalMetricResult {
  const actual = finiteNonNegative(input.actual, `El resultado de ${input.key}`);
  const reference = finiteNonNegative(input.reference, `La referencia de ${input.key}`);
  const target = finiteNonNegative(input.target, `La meta de ${input.key}`);
  const basePoints = finiteNonNegative(
    input.basePoints ?? metricDefinition(input.key).basePoints,
    `Los puntos de ${input.key}`
  );

  let points = 0;
  if (target > 0 && actual > 0) {
    if (reference <= 0 || target <= reference) {
      points = Math.min(ADVISOR_GOAL_CAP_MULTIPLIER, actual / target) * basePoints;
    } else if (actual <= reference) {
      points = (actual / reference) * ADVISOR_GOAL_REFERENCE_PROGRESS * basePoints;
    } else if (actual <= target) {
      const progressBetweenReferenceAndTarget = (actual - reference) / (target - reference);
      points = (
        ADVISOR_GOAL_REFERENCE_PROGRESS
        + progressBetweenReferenceAndTarget * (1 - ADVISOR_GOAL_REFERENCE_PROGRESS)
      ) * basePoints;
    } else {
      points = Math.min(ADVISOR_GOAL_CAP_MULTIPLIER, actual / target) * basePoints;
    }
  }

  return {
    ...input,
    actual: round(actual),
    reference: round(reference),
    target: round(target),
    basePoints: round(basePoints),
    points: round(Math.min(basePoints * ADVISOR_GOAL_CAP_MULTIPLIER, points)),
    progressToReference: reference > 0 ? round(actual / reference) : 0,
    progressToTarget: target > 0 ? round(actual / target) : 0,
  };
}

export function resolveAdvisorGoalBand(
  points: number,
  bands: readonly AdvisorGoalBand[] = ADVISOR_GOAL_BANDS
) {
  finiteNonNegative(points, 'Los puntos');
  const ordered = [...bands].sort((left, right) => left.minPoints - right.minPoints);
  const resolved = [...ordered].reverse().find((band) => points >= band.minPoints);
  if (!resolved) throw new Error('No existe una banda aplicable para el puntaje.');
  return resolved;
}

export function calculateAdvisorGoalScore(
  inputs: AdvisorGoalMetricInput[],
  bands: readonly AdvisorGoalBand[] = ADVISOR_GOAL_BANDS
): AdvisorGoalScore {
  const inputKeys = new Set(inputs.map((input) => input.key));
  if (inputKeys.size !== inputs.length) throw new Error('No se puede repetir un indicador en el cálculo.');
  if (ADVISOR_GOAL_METRICS.some((metric) => !inputKeys.has(metric.key))) {
    throw new Error('El cálculo debe contener los cinco indicadores canónicos.');
  }

  const metrics = inputs.map(calculateAdvisorGoalMetricPoints);
  const points = round(metrics.reduce((sum, metric) => sum + metric.points, 0));
  const band = resolveAdvisorGoalBand(points, bands);

  return {
    points,
    calculatedCommissionPct: band.commissionPct,
    band,
    metrics,
  };
}

export function calculateAdvisorCollectionOrderValue(
  order: AdvisorGoalCollectionOrder,
  asOfDate: string
) {
  const deliveryAt = dateOnlyToUtc(order.deliveryDate);
  const asOfAt = dateOnlyToUtc(asOfDate);
  const completedDate = order.completedPaymentRegistrationDate ?? null;

  if (order.paymentValidated && completedDate) {
    const completedAt = dateOnlyToUtc(completedDate);
    const elapsedDays = Math.round((completedAt - deliveryAt) / 86_400_000);
    if (elapsedDays <= 0) return 1;
    if (elapsedDays <= 5) return 0.8;
    return 0;
  }

  const elapsedAtCutoff = Math.round((asOfAt - deliveryAt) / 86_400_000);
  return elapsedAtCutoff >= 0 && elapsedAtCutoff <= 5 ? 0.8 : 0;
}

export function calculateAdvisorCollectionRatio(
  orders: AdvisorGoalCollectionOrder[],
  asOfDate: string
) {
  if (orders.length === 0) return 0;
  return round(
    orders.reduce(
      (sum, order) => sum + calculateAdvisorCollectionOrderValue(order, asOfDate),
      0
    ) / orders.length
  );
}

validateAdvisorGoalConfiguration();
