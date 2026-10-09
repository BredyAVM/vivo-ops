import { readAdvisorCommissionSettlementSnapshot } from './closure-snapshot.ts';

export type CommissionCalculationReading = {
  advisor_user_id: string;
  status: string;
  generated_at?: string | null;
  snapshot: unknown;
  base_commission_pct?: number | string | null;
  delivered_orders_count?: number | string | null;
  billed_usd?: number | string | null;
  gross_commission_usd?: number | string | null;
  gift_deductions_usd?: number | string | null;
  manual_deductions_usd?: number | string | null;
  pending_collection_usd?: number | string | null;
  payable_usd?: number | string | null;
};

function cents(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) : 0;
}

function validTimestamp(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function commissionCalculationTimestamp(row: CommissionCalculationReading) {
  // updated_at also changes on payments and edits; it is not a calculation date.
  return validTimestamp(readAdvisorCommissionSettlementSnapshot(row.snapshot).calculationCutoffAt)
    ?? validTimestamp(row.generated_at);
}

export function commissionCalculationTimeLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin cálculo registrado';
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

export function latestPreliminaryCalculation(rows: CommissionCalculationReading[]) {
  return rows.filter((row) => row.status === 'preliminary')
    .map(commissionCalculationTimestamp).filter((value): value is string => value !== null)
    .sort().at(-1) ?? null;
}

const MONEY_FIELDS = [
  'base_commission_pct', 'delivered_orders_count', 'billed_usd', 'gross_commission_usd',
  'gift_deductions_usd', 'manual_deductions_usd', 'pending_collection_usd', 'payable_usd',
] as const;
const SETTLEMENT_FIELDS = [
  'carriedCommissionUsd', 'priorAdvisorDebtUsd', 'positiveAdjustmentsUsd', 'negativeAdjustmentsUsd',
  'retainedCommissionUsd', 'advisorDebtOutUsd', 'uncoveredCustomerDebtUsd',
] as const;

export function commissionCalculationFeedback(before: CommissionCalculationReading[], after: CommissionCalculationReading[]) {
  const previous = new Map(before.map((row) => [row.advisor_user_id, row]));
  // Only compare rows actually recalculated, not a protected or ineligible row read back unchanged.
  const recalculated = after.filter((row) => {
    const old = previous.get(row.advisor_user_id);
    return row.status === 'preliminary' && (!old || (old.status === 'preliminary'
      && commissionCalculationTimestamp(row) !== commissionCalculationTimestamp(old)));
  });
  let changed = 0;
  let payableBefore = 0;
  let payableAfter = 0;
  let debtBefore = 0;
  let debtAfter = 0;
  for (const row of recalculated) {
    const old = previous.get(row.advisor_user_id);
    const oldSettlement = readAdvisorCommissionSettlementSnapshot(old?.snapshot);
    const settlement = readAdvisorCommissionSettlementSnapshot(row.snapshot);
    if (!old || MONEY_FIELDS.some((field) => cents(row[field]) !== cents(old[field]))
      || SETTLEMENT_FIELDS.some((field) => cents(settlement[field]) !== cents(oldSettlement[field]))) changed++;
    payableBefore += cents(old?.payable_usd);
    payableAfter += cents(row.payable_usd);
    debtBefore += cents(old?.pending_collection_usd);
    debtAfter += cents(row.pending_collection_usd);
  }
  return { recalculated: recalculated.length, changed, payableBefore: payableBefore / 100,
    payableAfter: payableAfter / 100, debtBefore: debtBefore / 100, debtAfter: debtAfter / 100 };
}
