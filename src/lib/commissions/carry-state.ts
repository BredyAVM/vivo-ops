import { readAdvisorCommissionSettlementSnapshot } from './closure-snapshot.ts';

export type AdvisorCommissionCarryState = {
  commissionCarryUsd: number;
  advisorDebtCarryUsd: number;
  source: 'settlement' | 'legacy-inferred';
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
