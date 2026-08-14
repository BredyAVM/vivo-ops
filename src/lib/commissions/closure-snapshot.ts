import type { AdvisorCommissionSettlementCalculation } from './settlement-engine.ts';

export const ADVISOR_COMMISSION_SNAPSHOT_VERSION = 2;
export const ADVISOR_COMMISSION_FORMULA_VERSION = 'advisor-settlement-v1';

type JsonRecord = Record<string, unknown>;

export type AdvisorCommissionClosureSnapshotV2 = JsonRecord & {
  version: typeof ADVISOR_COMMISSION_SNAPSHOT_VERSION;
  totals: JsonRecord & {
    grossCommissionUsd: number;
    giftDeductionsUsd: number;
    manualDeductionsUsd: number;
    pendingCollectionUsd: number;
    payableUsd: number;
  };
  settlement: JsonRecord & {
    formulaVersion: typeof ADVISOR_COMMISSION_FORMULA_VERSION;
    carrySource: 'none' | 'settlement' | 'legacy-inferred';
    calculationCutoffAt: string;
    scheduledLiquidationDate: string | null;
    carriedCommissionUsd: number;
    priorAdvisorDebtUsd: number;
    positiveAdjustmentsUsd: number;
    negativeAdjustmentsUsd: number;
    retainedCommissionUsd: number;
    advisorDebtOutUsd: number;
    uncoveredCustomerDebtUsd: number;
  };
};

export type AdvisorCommissionSettlementSnapshotState = {
  snapshotVersion: number;
  formulaVersion: string;
  carrySource: 'none' | 'settlement' | 'legacy-inferred' | 'unknown';
  calculationCutoffAt: string | null;
  scheduledLiquidationDate: string | null;
  carriedCommissionUsd: number;
  priorAdvisorDebtUsd: number;
  positiveAdjustmentsUsd: number;
  negativeAdjustmentsUsd: number;
  retainedCommissionUsd: number;
  advisorDebtOutUsd: number;
  uncoveredCustomerDebtUsd: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function money(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function validateIsoTimestamp(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error('calculationCutoffAt debe ser una fecha y hora valida.');
  }
  return new Date(value).toISOString();
}

function validateOptionalDate(value: string | null | undefined) {
  if (value == null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('scheduledLiquidationDate debe usar el formato YYYY-MM-DD.');
  }
  return value;
}

export function writeAdvisorCommissionSettlementSnapshot(params: {
  currentSnapshot: unknown;
  calculation: AdvisorCommissionSettlementCalculation;
  calculationCutoffAt: string;
  scheduledLiquidationDate?: string | null;
  carrySource?: 'none' | 'settlement' | 'legacy-inferred';
}): AdvisorCommissionClosureSnapshotV2 {
  const currentSnapshot = asRecord(params.currentSnapshot);
  const currentTotals = asRecord(currentSnapshot.totals);
  const currentSettlement = asRecord(currentSnapshot.settlement);
  const calculationCutoffAt = validateIsoTimestamp(params.calculationCutoffAt);
  const scheduledLiquidationDate = validateOptionalDate(
    params.scheduledLiquidationDate
  );
  const calculation = params.calculation;

  return {
    ...currentSnapshot,
    version: ADVISOR_COMMISSION_SNAPSHOT_VERSION,
    totals: {
      ...currentTotals,
      grossCommissionUsd: calculation.grossCommissionUsd,
      giftDeductionsUsd: calculation.giftDeductionsUsd,
      manualDeductionsUsd: calculation.directDeductionsUsd,
      pendingCollectionUsd: calculation.outstandingCustomerDebtUsd,
      payableUsd: calculation.payableUsd,
    },
    settlement: {
      ...currentSettlement,
      formulaVersion: ADVISOR_COMMISSION_FORMULA_VERSION,
      carrySource: params.carrySource ?? 'none',
      calculationCutoffAt,
      scheduledLiquidationDate,
      carriedCommissionUsd: calculation.carriedCommissionUsd,
      priorAdvisorDebtUsd: calculation.priorAdvisorDebtUsd,
      positiveAdjustmentsUsd: calculation.positiveAdjustmentsUsd,
      negativeAdjustmentsUsd: calculation.negativeAdjustmentsUsd,
      retainedCommissionUsd: calculation.retainedCommissionUsd,
      advisorDebtOutUsd: calculation.advisorDebtOutUsd,
      uncoveredCustomerDebtUsd: calculation.uncoveredCustomerDebtUsd,
    },
  } as AdvisorCommissionClosureSnapshotV2;
}

export function readAdvisorCommissionSettlementSnapshot(
  snapshot: unknown
): AdvisorCommissionSettlementSnapshotState {
  const snapshotRecord = asRecord(snapshot);
  const settlement = asRecord(snapshotRecord.settlement);
  const calculationCutoffAt =
    typeof settlement.calculationCutoffAt === 'string'
      ? settlement.calculationCutoffAt
      : null;
  const scheduledLiquidationDate =
    typeof settlement.scheduledLiquidationDate === 'string'
      ? settlement.scheduledLiquidationDate
      : null;

  return {
    snapshotVersion: Number(snapshotRecord.version ?? 1),
    formulaVersion:
      typeof settlement.formulaVersion === 'string'
        ? settlement.formulaVersion
        : 'legacy',
    carrySource:
      settlement.carrySource === 'none' ||
      settlement.carrySource === 'settlement' ||
      settlement.carrySource === 'legacy-inferred'
        ? settlement.carrySource
        : 'unknown',
    calculationCutoffAt,
    scheduledLiquidationDate,
    carriedCommissionUsd: money(settlement.carriedCommissionUsd),
    priorAdvisorDebtUsd: money(settlement.priorAdvisorDebtUsd),
    positiveAdjustmentsUsd: money(settlement.positiveAdjustmentsUsd),
    negativeAdjustmentsUsd: money(settlement.negativeAdjustmentsUsd),
    retainedCommissionUsd: money(settlement.retainedCommissionUsd),
    advisorDebtOutUsd: money(settlement.advisorDebtOutUsd),
    uncoveredCustomerDebtUsd: money(settlement.uncoveredCustomerDebtUsd),
  };
}
