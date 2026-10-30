import type { AdminFinancePeriodKey } from './period';

export const ADMIN_FINANCE_RECEIVABLES_DEFINITION_VERSION = 'admin-finance-receivables-v1' as const;
export const ADMIN_FINANCE_RECEIVABLES_PAGE_SIZE = 30;

export type AdminFinanceReceivableStatus = 'credit_open' | 'overdue_open';

export type AdminFinanceReceivableOrder = {
  id: number;
  orderNumber: string;
  clientName: string;
  advisorName: string;
  deliveryDate: string;
  dueDate: string;
  ageDays: number;
  totalUsd: number;
  confirmedPaidUsd: number;
  pendingUsd: number;
  pendingReportsUsd: number;
  pendingReportsCount: number;
  paymentStatus: string;
  collectionStatus: AdminFinanceReceivableStatus;
};

export type AdminFinanceReceivablesOverview = {
  definitionVersion: typeof ADMIN_FINANCE_RECEIVABLES_DEFINITION_VERSION;
  asOf: string;
  asOfDate: string;
  cutoffMode: 'current_statement';
  balanceSource: 'canonical_order_financial_state';
  paymentTimingBasis: 'payment_registration_date';
  graceDays: 5;
  period: {
    from: string;
    to: string;
    orders: number;
    billedUsd: number;
    coveredUsd: number;
    pendingUsd: number;
    punctualPaid: number;
    creditPaid: number;
    overduePaid: number;
    creditOpen: number;
    overdueOpen: number;
    missingRegistration: number;
  };
  portfolio: {
    openOrders: number;
    receivableUsd: number;
    graceOrders: number;
    graceUsd: number;
    overdueOrders: number;
    overdueUsd: number;
    pendingReports: number;
    pendingReportsUsd: number;
    oldestAgeDays: number;
  };
  openOrders: AdminFinanceReceivableOrder[];
};

export type AdminFinanceReceivablesDomain =
  | { status: 'ready'; data: AdminFinanceReceivablesOverview }
  | { status: 'error'; message: string };

export type AdminFinanceReceivablesFilters = {
  period: AdminFinancePeriodKey;
  q: string;
  status: AdminFinanceReceivableStatus | 'all';
  sort: 'age_desc' | 'pending_desc' | 'client';
  page: number;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizePage(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

export function normalizeAdminFinanceReceivablesFilters(
  values: Record<string, string | string[] | undefined>
): AdminFinanceReceivablesFilters {
  const rawPeriod = firstValue(values.period);
  const rawStatus = firstValue(values.estado);
  const rawSort = firstValue(values.orden);
  return {
    period: rawPeriod === 'today' || rawPeriod === 'week' ? rawPeriod : 'month',
    q: String(firstValue(values.q) ?? '').trim().slice(0, 80),
    status: rawStatus === 'credit_open' || rawStatus === 'overdue_open' ? rawStatus : 'all',
    sort: rawSort === 'pending_desc' || rawSort === 'client' ? rawSort : 'age_desc',
    page: normalizePage(firstValue(values.page)),
  };
}

export function filterAdminFinanceReceivables(
  orders: AdminFinanceReceivableOrder[],
  filters: AdminFinanceReceivablesFilters
) {
  const query = filters.q.toLocaleLowerCase('es');
  const filtered = orders.filter((order) => {
    if (filters.status !== 'all' && order.collectionStatus !== filters.status) return false;
    if (!query) return true;
    return [order.orderNumber, order.clientName, order.advisorName]
      .some((value) => value.toLocaleLowerCase('es').includes(query));
  });

  filtered.sort((left, right) => {
    if (filters.sort === 'client') {
      return left.clientName.localeCompare(right.clientName, 'es') || right.ageDays - left.ageDays;
    }
    if (filters.sort === 'pending_desc') {
      return right.pendingUsd - left.pendingUsd || right.ageDays - left.ageDays;
    }
    return (
      Number(right.collectionStatus === 'overdue_open') - Number(left.collectionStatus === 'overdue_open')
      || right.ageDays - left.ageDays
      || right.pendingUsd - left.pendingUsd
    );
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_FINANCE_RECEIVABLES_PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const start = (page - 1) * ADMIN_FINANCE_RECEIVABLES_PAGE_SIZE;
  return {
    orders: filtered.slice(start, start + ADMIN_FINANCE_RECEIVABLES_PAGE_SIZE),
    total,
    totalPages,
    page,
  };
}
