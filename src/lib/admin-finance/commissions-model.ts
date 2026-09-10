import { getAdvisorCommissionCarryState } from '../commissions/carry-state.ts';
import { readAdvisorCommissionWorkflowSnapshot } from '../commissions/workflow-snapshot.ts';
import { getAdvisorCommissionClosureIdFromPaymentDescription } from '../commissions/payment-ledger.ts';
import { getCaracasDateKey } from './period';

type Json = Record<string, unknown>;
export type CommissionPeriod = { id: number; name: string; from: string; to: string; status: string };
export type CommissionRow = {
  id: number; periodId: number; advisorId: string; advisorName: string;
  status: 'preliminary' | 'closed' | 'paid'; eligibleNow: boolean;
  grossUsd: number; payableUsd: number; retainedUsd: number | null;
  retainedBasis: 'snapshot' | 'legacy' | 'unavailable';
  calculationAt: string; calculationBeforePeriod: boolean; conformed: boolean; referencedPaidUsd: number;
  pendingUsd: number | null; issues: string[];
};
export type CommissionsOverview = {
  asOf: string; periods: CommissionPeriod[]; rows: CommissionRow[]; eligibleAdvisorIds: string[];
  unmatchedPayments: number;
};
export const COMMISSIONS_VERSION = 'admin-finance-commissions-v1';
export function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing commission text');
  return value;
}
function money(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw new Error('Missing commission amount');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid commission amount');
  return parsed;
}
function id(value: unknown): number {
  const parsed = money(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Invalid commission id');
  return parsed;
}
function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error('Invalid commission timestamp');
  return parsed;
}
function date(value: unknown): string {
  const parsed = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || !Number.isFinite(Date.parse(`${parsed}T12:00:00Z`))
    || new Date(`${parsed}T12:00:00Z`).toISOString().slice(0, 10) !== parsed) throw new Error('Invalid commission date');
  return parsed;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing commission collection');
  return value;
}
function unique(values: Array<string | number>) {
  if (new Set(values).size !== values.length) throw new Error('Duplicate commission records');
}
function rounded(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }

export function parseCommissionsOverview(value: unknown, requestedAt: Date): CommissionsOverview {
  const data = object(value);
  if (data.definitionVersion !== COMMISSIONS_VERSION || data.paymentLinkBasis !== 'legacy_description') throw new Error('Incompatible commission contract');
  const asOf = timestamp(data.asOf);
  if (!Number.isFinite(requestedAt.getTime()) || Math.abs(Date.parse(asOf) - requestedAt.getTime()) > 300_000) throw new Error('Stale commission read');
  const periods = array(data.periods).map(value => {
    const row = object(value);
    const period = { id: id(row.id), name: text(row.name), from: date(row.date_from), to: date(row.date_to), status: text(row.status) };
    if (period.from > period.to) throw new Error('Invalid commission period');
    return period;
  });
  unique(periods.map(p => p.id));
  const eligibleAdvisorIds = array(data.eligibleAdvisorIds).map(text);
  unique(eligibleAdvisorIds);
  const rows = array(data.closures).map(value => {
    const c = object(value);
    if (!['preliminary', 'closed', 'paid'].includes(String(c.status)) || typeof c.eligible_now !== 'boolean') throw new Error('Invalid commission status');
    const snapshot = object(c.snapshot);
    const settlement = object(snapshot.settlement);
    const totals = object(snapshot.totals);
    const grossUsd = money(c.gross_commission_usd), payableUsd = money(c.payable_usd);
    const giftUsd = money(c.gift_deductions_usd), manualUsd = money(c.manual_deductions_usd), customerDebt = money(c.pending_collection_usd);
    let retainedUsd: number | null = null;
    let retainedBasis: CommissionRow['retainedBasis'] = 'unavailable';
    const issues: string[] = [];
    let calculationAt = timestamp(c.generated_at);
    if (Number(snapshot.version ?? 1) === 2 && settlement.formulaVersion === 'advisor-settlement-v1') {
      try {
        money(settlement.retainedCommissionUsd);
        calculationAt = timestamp(settlement.calculationCutoffAt);
        if (Math.abs(money(totals.grossCommissionUsd) - grossUsd) > 0.000001
          || Math.abs(money(totals.payableUsd) - payableUsd) > 0.000001) throw new Error('Snapshot mismatch');
        retainedUsd = getAdvisorCommissionCarryState({ snapshot, grossCommissionUsd: grossUsd, giftDeductionsUsd: giftUsd,
          directDeductionsUsd: manualUsd, pendingCollectionUsd: customerDebt }).commissionCarryUsd;
        retainedBasis = 'snapshot';
      } catch { issues.push('Cálculo guardado incompleto o inconsistente'); }
    } else if (Number(snapshot.version ?? 1) === 1 && !settlement.formulaVersion) {
      retainedUsd = getAdvisorCommissionCarryState({ snapshot, grossCommissionUsd: grossUsd, giftDeductionsUsd: giftUsd,
        directDeductionsUsd: manualUsd, pendingCollectionUsd: customerDebt }).commissionCarryUsd;
      retainedBasis = 'legacy';
      issues.push('Retención histórica estimada');
    } else issues.push('Versión de cálculo no reconocida');
    const period = periods.find(p => p.id === id(c.period_id));
    if (!period) throw new Error('Unknown commission period');
    const calculationBeforePeriod = getCaracasDateKey(new Date(calculationAt)) < period.from;
    if (calculationBeforePeriod) issues.push('Cálculo anterior al inicio del período: actualizar');
    const conformity = readAdvisorCommissionWorkflowSnapshot(snapshot).conformity;
    const conformed = !calculationBeforePeriod && conformity.status === 'confirmed' && retainedBasis === 'snapshot'
      && Number.isFinite(Date.parse(conformity.confirmedAt)) && Boolean(conformity.recordedByUserId.trim())
      && c.closed_at !== null && Number.isFinite(Date.parse(String(c.closed_at)))
      && (c.status === 'closed' || c.status === 'paid');
    if ((c.status === 'closed' || c.status === 'paid') && !conformed) issues.push('Conformidad no verificable');
    if (conformity.status === 'requires_reconfirmation') issues.push('Requiere nueva conformidad');
    const row: CommissionRow = {
      id: id(c.id), periodId: id(c.period_id), advisorId: text(c.advisor_user_id), advisorName: text(c.advisor_name),
      status: c.status as CommissionRow['status'], eligibleNow: c.eligible_now,
      grossUsd, payableUsd, retainedUsd, retainedBasis, calculationAt, calculationBeforePeriod, conformed, referencedPaidUsd: 0,
      pendingUsd: !conformed || payableUsd > 0 ? null : 0, issues,
    };
    if (!periods.some(p => p.id === row.periodId) || row.eligibleNow !== eligibleAdvisorIds.includes(row.advisorId)) throw new Error('Inconsistent commission scope');
    return row;
  });
  unique(rows.map(r => r.id));
  unique(rows.map(r => `${r.periodId}:${r.advisorId}`));
  const byId = new Map(rows.map(row => [row.id, row]));
  const payments = array(data.payments);
  const paymentIds: number[] = [];
  let unmatchedPayments = 0;
  for (const value of payments) {
    const payment = object(value);
    paymentIds.push(id(payment.id));
    const amount = money(payment.amount_usd_equivalent);
    date(payment.movement_date);
    const closureId = getAdvisorCommissionClosureIdFromPaymentDescription(payment.description);
    const row = closureId === null ? undefined : byId.get(closureId);
    if (!row) { unmatchedPayments++; continue; }
    row.referencedPaidUsd = rounded(row.referencedPaidUsd + amount);
  }
  unique(paymentIds);
  for (const row of rows) {
    if (row.status === 'paid' && row.payableUsd - row.referencedPaidUsd > 0.005) row.issues.push('Marcada pagada sin abonos suficientes identificados');
    if (row.referencedPaidUsd - row.payableUsd > 0.005) row.issues.push('Abonos identificados superiores a liquidación');
    if (row.referencedPaidUsd > 0) row.issues.push('Abonos vinculados solo por descripción');
    if (row.referencedPaidUsd > row.payableUsd) row.pendingUsd = null;
  }
  if (money(data.periodCount) !== periods.length || money(data.closureCount) !== rows.length || money(data.paymentCount) !== payments.length) throw new Error('Incomplete commission read');
  return { asOf, periods, rows, eligibleAdvisorIds, unmatchedPayments };
}

export type CommissionFilters = { periodId: number | null; status: 'all' | 'preliminary' | 'closed' | 'paid' | 'issues'; q: string; page: number };
export function normalizeCommissionFilters(values: Record<string, string | string[] | undefined>): CommissionFilters {
  const first = (key: string) => Array.isArray(values[key]) ? values[key][0] : values[key];
  const period = Number(first('period')), page = Number(first('page')), status = first('estado');
  return { periodId: Number.isSafeInteger(period) && period > 0 ? period : null,
    status: status === 'preliminary' || status === 'closed' || status === 'paid' || status === 'issues' ? status : 'all',
    q: (first('q') ?? '').trim().slice(0, 80), page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}
export function selectCommissionPeriod(data: CommissionsOverview, requestedId: number | null) {
  if (requestedId !== null) return data.periods.find(p => p.id === requestedId) ?? null;
  const today = getCaracasDateKey(new Date(data.asOf));
  const ordered = [...data.periods].sort((a, b) => b.from.localeCompare(a.from) || b.id - a.id);
  return ordered.find(p => p.from <= today && p.to >= today) ?? ordered.find(p => p.from <= today) ?? ordered.at(-1) ?? null;
}
export function commissionPeriodView(data: CommissionsOverview, filters: CommissionFilters) {
  const period = selectCommissionPeriod(data, filters.periodId);
  const stored = data.rows.filter(row => row.periodId === period?.id);
  const included = stored.filter(row => row.eligibleNow || row.status !== 'preliminary');
  const q = filters.q.toLocaleLowerCase('es');
  const rows = included.filter(row => (filters.status === 'all' || (filters.status === 'issues' ? row.issues.length > 0 : row.status === filters.status))
    && (!q || row.advisorName.toLocaleLowerCase('es').includes(q) || String(row.id).includes(q)));
  const sum = (key: 'grossUsd' | 'payableUsd' | 'retainedUsd', selection = rows) => rounded(selection.reduce((s, r) => s + (r[key] ?? 0), 0));
  const finalized = rows.filter(r => r.status !== 'preliminary');
  const pages = Math.max(1, Math.ceil(rows.length / 30)), page = Math.min(filters.page, pages);
  const today = getCaracasDateKey(new Date(data.asOf));
  return { period, rows: rows.slice((page - 1) * 30, page * 30), count: rows.length, pages, page,
    excluded: stored.length - included.length,
    missingCurrentAdvisors: period && period.from <= today && period.to >= today
      ? data.eligibleAdvisorIds.filter(id => !stored.some(r => r.advisorId === id && !r.calculationBeforePeriod)).length : null,
    summary: { grossUsd: rows.length && rows.every(r => !r.calculationBeforePeriod) ? sum('grossUsd') : null,
      retainedUsd: rows.length && rows.every(r => r.retainedUsd !== null && !r.calculationBeforePeriod) ? sum('retainedUsd') : null,
      estimatedRetentions: rows.filter(r => r.retainedBasis === 'legacy').length,
      conformedUsd: !rows.length || finalized.some(r => r.status === 'closed' && !r.conformed) ? null : sum('payableUsd', finalized.filter(r => r.status === 'closed')),
      pendingUsd: !rows.length || finalized.some(r => r.pendingUsd === null) ? null : 0,
      preliminary: rows.filter(r => r.status === 'preliminary').length, closed: rows.filter(r => r.status === 'closed').length,
      paid: rows.filter(r => r.status === 'paid').length, issues: rows.filter(r => r.issues.length > 0).length,
    } };
}
