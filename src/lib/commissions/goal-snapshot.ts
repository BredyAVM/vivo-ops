import type { AdvisorGoalScore, AdvisorGoalSeasonality } from './goal-engine.ts';

type JsonRecord = Record<string, unknown>;

export type AdvisorGoalPeriodStatus = 'draft' | 'published' | 'closed';
export type AdvisorGoalPublicationStatus = 'draft' | 'published' | 'provisional' | 'final';

export type AdvisorGoalContextConfiguration = {
  observed: AdvisorGoalSeasonality;
  appliedPct: number;
  reason: string;
};

export type AdvisorGoalAuditEntry = {
  version: number;
  action: 'generated' | 'published' | 'modified' | 'finalized' | 'rate_overridden';
  recordedAt: string;
  recordedByUserId: string;
  reason: string | null;
  previous?: JsonRecord | null;
  next?: JsonRecord | null;
};

export type AdvisorGoalPeriodConfig = {
  version: 1;
  status: AdvisorGoalPeriodStatus;
  growthChallengePct: number;
  billing: AdvisorGoalContextConfiguration;
  closures: AdvisorGoalContextConfiguration;
  publicationMessage: string | null;
  generatedAt: string;
  generatedByUserId: string;
  publishedAt: string | null;
  publishedByUserId: string | null;
  revision: number;
  audit: AdvisorGoalAuditEntry[];
};

export type AdvisorGoalMetricPublication = {
  actual: number;
  medianAvailable: number;
  medianRecent: number;
  personalReference: number;
  appliedContextPct: number;
  expectedCapacity: number;
  growthChallengePct: number;
  target: number;
  validPeriods: string[];
  excludedPeriods: string[];
};

export type AdvisorGoalPublicationSnapshot = {
  version: 1;
  status: AdvisorGoalPublicationStatus;
  periodId: number;
  advisorUserId: string;
  advisorName: string;
  generatedAt: string;
  generatedByUserId: string;
  publishedAt: string | null;
  publishedByUserId: string | null;
  revision: number;
  explanation: string;
  calculatedCommissionPct: number;
  appliedCommissionPct: number;
  rateOverrideReason: string | null;
  score: AdvisorGoalScore;
  metrics: Record<string, AdvisorGoalMetricPublication>;
  audit: AdvisorGoalAuditEntry[];
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIsoTimestamp(value: unknown) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isPeriodStatus(value: unknown): value is AdvisorGoalPeriodStatus {
  return value === 'draft' || value === 'published' || value === 'closed';
}

function isPublicationStatus(value: unknown): value is AdvisorGoalPublicationStatus {
  return value === 'draft' || value === 'published' || value === 'provisional' || value === 'final';
}

export function readAdvisorGoalPeriodConfig(value: unknown): AdvisorGoalPeriodConfig | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 || !isPeriodStatus(value.status)) return null;
  if (!isFiniteNumber(value.growthChallengePct) || value.growthChallengePct < 0) return null;
  if (!isRecord(value.billing) || !isRecord(value.closures)) return null;
  if (!isIsoTimestamp(value.generatedAt) || typeof value.generatedByUserId !== 'string') return null;
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) return null;
  if (!Array.isArray(value.audit)) return null;
  return value as AdvisorGoalPeriodConfig;
}

export function readAdvisorGoalPublicationSnapshot(
  commissionSnapshot: unknown
): AdvisorGoalPublicationSnapshot | null {
  if (!isRecord(commissionSnapshot) || !isRecord(commissionSnapshot.advisorGoal)) return null;
  const goal = commissionSnapshot.advisorGoal;
  if (goal.version !== 1 || !isPublicationStatus(goal.status)) return null;
  if (!Number.isInteger(goal.periodId) || Number(goal.periodId) <= 0) return null;
  if (typeof goal.advisorUserId !== 'string' || !goal.advisorUserId) return null;
  if (!isIsoTimestamp(goal.generatedAt) || !isRecord(goal.score) || !isRecord(goal.metrics)) return null;
  if (!isFiniteNumber(goal.calculatedCommissionPct) || !isFiniteNumber(goal.appliedCommissionPct)) return null;
  if (!Array.isArray(goal.audit)) return null;
  return goal as AdvisorGoalPublicationSnapshot;
}

export function withAdvisorGoalPublicationSnapshot(
  commissionSnapshot: unknown,
  advisorGoal: AdvisorGoalPublicationSnapshot
) {
  const snapshot = isRecord(commissionSnapshot) ? { ...commissionSnapshot } : {};
  return {
    ...snapshot,
    advisorGoal,
  };
}

export function preserveAdvisorGoalPublicationSnapshot(params: {
  generatedSnapshot: unknown;
  previousSnapshot: unknown;
}) {
  const previousGoal = readAdvisorGoalPublicationSnapshot(params.previousSnapshot);
  if (!previousGoal) {
    return isRecord(params.generatedSnapshot) ? { ...params.generatedSnapshot } : {};
  }
  return withAdvisorGoalPublicationSnapshot(params.generatedSnapshot, previousGoal);
}
