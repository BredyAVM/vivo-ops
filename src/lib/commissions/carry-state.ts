import { readAdvisorCommissionSettlementSnapshot } from './closure-snapshot.ts';

export type AdvisorCommissionCarryState = {
  commissionCarryUsd: number;
  advisorDebtCarryUsd: number;
  source: 'settlement' | 'legacy-inferred';
};

export type AdvisorCommissionCarryOverride = {
  commissionCarryUsd: number;
  advisorDebtCarryUsd: number;
  note: string;
  recordedAt: string;
  recordedByUserId: string;
};

type LegacyClosureMoney = {
  snapshot: unknown;
  grossCommissionUsd: number;
  giftDeductionsUsd: number;
  directDeductionsUsd: number;
  pendingCollectionUsd: number;
};

function cents(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round((value + Number.EPSILON) * 100));
}

function dollars(value: number) {
  return value / 100;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readAdvisorCommissionCarryOverride(
  snapshot: unknown
): AdvisorCommissionCarryOverride | null {
  const bootstrap = record(record(snapshot).commissionBootstrap);
  if (bootstrap.version !== 1) return null;
  if (
    typeof bootstrap.note !== 'string' ||
    typeof bootstrap.recordedAt !== 'string' ||
    typeof bootstrap.recordedByUserId !== 'string'
  ) {
    return null;
  }

  const commissionCarryUsd = Number(bootstrap.commissionCarryUsd ?? 0);
  const advisorDebtCarryUsd = Number(bootstrap.advisorDebtCarryUsd ?? 0);
  if (
    !Number.isFinite(commissionCarryUsd) ||
    commissionCarryUsd < 0 ||
    !Number.isFinite(advisorDebtCarryUsd) ||
    advisorDebtCarryUsd < 0
  ) {
    return null;
  }

  return {
    commissionCarryUsd: dollars(cents(commissionCarryUsd)),
    advisorDebtCarryUsd: dollars(cents(advisorDebtCarryUsd)),
    note: bootstrap.note,
    recordedAt: bootstrap.recordedAt,
    recordedByUserId: bootstrap.recordedByUserId,
  };
}

export function writeAdvisorCommissionCarryOverride(input: {
  snapshot: unknown;
  commissionCarryUsd: number;
  advisorDebtCarryUsd: number;
  note: string;
  recordedAt: string;
  recordedByUserId: string;
}) {
  const snapshot = record(input.snapshot);
  const note = input.note.trim();
  const recordedByUserId = input.recordedByUserId.trim();
  if (!note) throw new Error('La nota del saldo inicial es obligatoria.');
  if (note.length > 500) throw new Error('La nota no puede superar 500 caracteres.');
  if (!recordedByUserId) throw new Error('recordedByUserId es obligatorio.');
  if (!input.recordedAt || !Number.isFinite(Date.parse(input.recordedAt))) {
    throw new Error('recordedAt debe ser una fecha y hora válida.');
  }
  if (
    !Number.isFinite(input.commissionCarryUsd) ||
    input.commissionCarryUsd < 0 ||
    !Number.isFinite(input.advisorDebtCarryUsd) ||
    input.advisorDebtCarryUsd < 0
  ) {
    throw new Error('Los saldos iniciales deben ser montos válidos mayores o iguales a cero.');
  }

  return {
    ...snapshot,
    commissionBootstrap: {
      version: 1,
      commissionCarryUsd: dollars(cents(input.commissionCarryUsd)),
      advisorDebtCarryUsd: dollars(cents(input.advisorDebtCarryUsd)),
      note,
      recordedAt: new Date(input.recordedAt).toISOString(),
      recordedByUserId,
    },
  };
}

export function getAdvisorCommissionCarryState(
  closure: LegacyClosureMoney
): AdvisorCommissionCarryState {
  const settlement = readAdvisorCommissionSettlementSnapshot(closure.snapshot);

  if (settlement.formulaVersion !== 'legacy') {
    return {
      commissionCarryUsd: settlement.retainedCommissionUsd,
      advisorDebtCarryUsd: settlement.advisorDebtOutUsd,
      source: 'settlement',
    };
  }

  const grossCommission = cents(closure.grossCommissionUsd);
  const deductions =
    cents(closure.giftDeductionsUsd) + cents(closure.directDeductionsUsd);
  const creditAfterDeductions = Math.max(0, grossCommission - deductions);
  const pendingCollection = cents(closure.pendingCollectionUsd);

  return {
    commissionCarryUsd: dollars(Math.min(creditAfterDeductions, pendingCollection)),
    advisorDebtCarryUsd: dollars(Math.max(0, deductions - grossCommission)),
    source: 'legacy-inferred',
  };
}
