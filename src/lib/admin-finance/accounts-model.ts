import {
  getFinanceAccountWorkstream,
  type FinanceAccountWorkstream,
  type MoneyAccountClosureKind,
  type MoneyAccountKind,
} from '../domain/finance-domain.ts';
import type { FinancialQualityCode } from './model.ts';

export const ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION = 'admin-finance-accounts-v2' as const;
export const ADMIN_FINANCE_ACCOUNT_PAGE_SIZE = 25;
export const ADMIN_FINANCE_ACCOUNT_DETAIL_PAGE_SIZE = 40;

export type AdminFinanceAccountSnapshot = {
  id: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: MoneyAccountKind;
  workstream: FinanceAccountWorkstream;
  institutionName: string | null;
  ownerName: string | null;
  isActive: boolean;
  closureKind: MoneyAccountClosureKind | null;
  baselineRequired: boolean;
  balanceNative: number;
  ledgerValueUsd: number;
  currentValueUsd: number | null;
  anchorKind: 'closure' | 'baseline' | 'none';
  anchorDate: string | null;
  anchorAt: string | null;
  anchorAmount: number;
  latestClosureId: number | null;
  latestClosureDate: string | null;
  latestClosureAt: string | null;
  latestClosureStatus: 'recorded' | 'approved' | 'rejected' | null;
  latestClosureDifference: number | null;
  latestClosureDifferenceUsd: number | null;
  openReconciliations: number;
  openReconciliationNative: number;
  openReconciliationUsd: number;
  orphanedReconciliations: number;
  pendingMovementOperations: number;
  pendingMovementNative: number;
  pendingMovementUsd: number;
  quality: FinancialQualityCode;
};

export type AdminFinanceAccountsOverview = {
  definitionVersion: typeof ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION;
  asOf: string;
  cutoffMode: 'current_statement';
  rateBasis: 'single_active_at_current_statement';
  activeRateCount: number;
  rateQuality: FinancialQualityCode;
  activeRateBsPerUsd: number | null;
  activeRateEffectiveAt: string | null;
  summary: {
    activeAccounts: number;
    inactiveAccounts: number;
    anchoredAccounts: number;
    attentionAccounts: number;
    nativeUsdTotal: number;
    nativeVesTotal: number;
    nativeUsdCoveredTotal: number;
    nativeUsdUncoveredTotal: number;
    nativeUsdCoveredAccounts: number;
    nativeUsdTotalAccounts: number;
    nativeUsdCoveragePct: number | null;
    nativeUsdQuality: FinancialQualityCode;
    nativeVesCoveredTotal: number;
    nativeVesUncoveredTotal: number;
    nativeVesCoveredAccounts: number;
    nativeVesTotalAccounts: number;
    nativeVesCoveragePct: number | null;
    nativeVesQuality: FinancialQualityCode;
    nativeTotalsQuality: FinancialQualityCode;
    openReconciliations: number;
    pendingMovementOperations: number;
  };
  accounts: AdminFinanceAccountSnapshot[];
};

export type AdminFinanceAccountSection =
  | 'movements'
  | 'closures'
  | 'reconciliation'
  | 'configuration';

export type AdminFinanceMovementRow = {
  kind: 'movement';
  id: number;
  movementDate: string;
  createdAt: string;
  direction: 'inflow' | 'outflow';
  movementType: string;
  currencyCode: 'USD' | 'VES';
  amount: number;
  amountUsdEquivalent: number;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  orderId: number | null;
  status: 'pending' | 'confirmed' | 'rejected' | 'voided';
  approvalRequired: boolean;
};

export type AdminFinanceClosureRow = {
  kind: 'closure';
  id: number;
  closureDate: string;
  closureAt: string;
  currencyCode: 'USD' | 'VES';
  expectedAmount: number;
  countedAmount: number;
  differenceAmount: number;
  expectedAmountUsd: number;
  countedAmountUsd: number;
  differenceAmountUsd: number;
  exchangeRateVesPerUsd: number | null;
  status: 'recorded' | 'approved' | 'rejected';
  reason: string | null;
};

export type AdminFinanceReconciliationRow = {
  kind: 'reconciliation';
  id: number;
  operationDate: string | null;
  createdAt: string;
  sourceKind: 'baseline' | 'closure' | 'manual';
  sourceId: number | null;
  itemType: string;
  direction: 'surplus' | 'shortage';
  currencyCode: 'USD' | 'VES';
  amount: number;
  amountUsdEquivalent: number;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string;
  status: 'open' | 'resolved' | 'voided';
  orphanedSource: boolean;
};

export type AdminFinanceAccountDetailRow =
  | AdminFinanceMovementRow
  | AdminFinanceClosureRow
  | AdminFinanceReconciliationRow;

export type AdminFinanceAccountDetail = {
  definitionVersion: typeof ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION;
  asOf: string;
  cutoffMode: 'current_statement';
  rateBasis: 'single_active_at_current_statement';
  activeRateCount: number;
  rateQuality: FinancialQualityCode;
  account: AdminFinanceAccountSnapshot;
  section: AdminFinanceAccountSection;
  fromDate: string;
  toDate: string;
  status: string;
  page: number;
  pageSize: number;
  totalRows: number;
  period: {
    inflowNative: number;
    outflowNative: number;
    netNative: number;
    pendingNative: number;
  };
  rows: AdminFinanceAccountDetailRow[];
};

export type AdminFinanceAccountsDomain<T> =
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export type AdminFinanceAccountsFilters = {
  q: string;
  group: FinanceAccountWorkstream | 'all';
  currency: 'USD' | 'VES' | 'all';
  state: 'active' | 'inactive' | 'all';
  quality: 'exact' | 'derived' | 'incomplete' | 'blocked' | 'all';
  attention: 'pending_movements' | 'open_reconciliation' | 'no_anchor' | 'orphaned_reconciliation' | 'all';
  sort: 'attention' | 'balance_desc' | 'name';
  page: number;
};

const workstreams = new Set<FinanceAccountWorkstream>([
  'bank',
  'pos',
  'cash',
  'wallet',
  'retention',
  'fund',
  'other',
]);

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizePage(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

export function normalizeAdminFinanceAccountsFilters(
  values: Record<string, string | string[] | undefined>
): AdminFinanceAccountsFilters {
  const rawGroup = firstValue(values.grupo);
  const rawCurrency = firstValue(values.moneda)?.toUpperCase();
  const rawState = firstValue(values.estado);
  const rawQuality = firstValue(values.calidad);
  const rawSort = firstValue(values.orden);
  const rawAttention = firstValue(values.state);

  return {
    q: String(firstValue(values.q) ?? '').trim().slice(0, 80),
    group: workstreams.has(rawGroup as FinanceAccountWorkstream)
      ? (rawGroup as FinanceAccountWorkstream)
      : 'all',
    currency: rawCurrency === 'USD' || rawCurrency === 'VES' ? rawCurrency : 'all',
    state: rawState === 'inactive' || rawState === 'all' ? rawState : 'active',
    quality:
      rawQuality === 'exact' ||
      rawQuality === 'derived' ||
      rawQuality === 'incomplete' ||
      rawQuality === 'blocked'
        ? rawQuality
        : 'all',
    attention:
      rawAttention === 'pending_movements' ||
      rawAttention === 'open_reconciliation' ||
      rawAttention === 'no_anchor' ||
      rawAttention === 'orphaned_reconciliation'
        ? rawAttention
        : 'all',
    sort: rawSort === 'balance_desc' || rawSort === 'name' ? rawSort : 'attention',
    page: normalizePage(firstValue(values.page)),
  };
}

const qualityFilterCode: Record<Exclude<AdminFinanceAccountsFilters['quality'], 'all'>, FinancialQualityCode> = {
  exact: 'Q1_exact',
  derived: 'Q2_derived',
  incomplete: 'Q3_incomplete',
  blocked: 'Q4_blocked',
};

function hasAttention(account: AdminFinanceAccountSnapshot) {
  return (
    account.anchorKind === 'none' ||
    account.openReconciliations > 0 ||
    account.pendingMovementOperations > 0 ||
    account.orphanedReconciliations > 0
  );
}

export function filterAdminFinanceAccounts(
  accounts: AdminFinanceAccountSnapshot[],
  filters: AdminFinanceAccountsFilters
) {
  const query = filters.q.toLocaleLowerCase('es');
  const filtered = accounts.filter((account) => {
    if (filters.state === 'active' && !account.isActive) return false;
    if (filters.state === 'inactive' && account.isActive) return false;
    if (filters.group !== 'all' && account.workstream !== filters.group) return false;
    if (filters.currency !== 'all' && account.currencyCode !== filters.currency) return false;
    if (filters.quality !== 'all' && account.quality !== qualityFilterCode[filters.quality]) return false;
    if (filters.attention === 'pending_movements' && account.pendingMovementOperations === 0) return false;
    if (filters.attention === 'open_reconciliation' && account.openReconciliations === 0) return false;
    if (filters.attention === 'no_anchor' && account.anchorKind !== 'none') return false;
    if (filters.attention === 'orphaned_reconciliation' && account.orphanedReconciliations === 0) return false;
    if (!query) return true;
    return [account.name, account.institutionName, account.ownerName]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase('es').includes(query));
  });

  filtered.sort((left, right) => {
    if (filters.sort === 'name') return left.name.localeCompare(right.name, 'es');
    if (filters.sort === 'balance_desc') {
      return Math.abs(right.balanceNative) - Math.abs(left.balanceNative) || left.name.localeCompare(right.name, 'es');
    }
    const attentionDifference = Number(hasAttention(right)) - Number(hasAttention(left));
    if (attentionDifference !== 0) return attentionDifference;
    const issueDifference =
      right.openReconciliations + right.pendingMovementOperations -
      (left.openReconciliations + left.pendingMovementOperations);
    return issueDifference || left.name.localeCompare(right.name, 'es');
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_FINANCE_ACCOUNT_PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const start = (page - 1) * ADMIN_FINANCE_ACCOUNT_PAGE_SIZE;

  return {
    accounts: filtered.slice(start, start + ADMIN_FINANCE_ACCOUNT_PAGE_SIZE),
    total,
    totalPages,
    page,
  };
}

export function resolveAccountWorkstream(input: {
  accountKind: MoneyAccountKind;
  closureKind: MoneyAccountClosureKind | null;
}) {
  return getFinanceAccountWorkstream(input);
}

export function normalizeAdminFinanceAccountSection(value: unknown): AdminFinanceAccountSection {
  return value === 'closures' || value === 'reconciliation' || value === 'configuration'
    ? value
    : 'movements';
}

const detailStatuses: Record<AdminFinanceAccountSection, ReadonlySet<string>> = {
  movements: new Set(['all', 'pending', 'confirmed', 'rejected', 'voided']),
  closures: new Set(['all', 'recorded', 'approved', 'rejected']),
  reconciliation: new Set(['all', 'open', 'resolved', 'voided']),
  configuration: new Set(['all']),
};

export function normalizeAdminFinanceDetailStatus(
  section: AdminFinanceAccountSection,
  value: unknown
) {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  return detailStatuses[section].has(normalized) ? normalized : 'all';
}

export function normalizeAdminFinanceDate(value: unknown, fallback: string) {
  const normalized = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : fallback;
}
