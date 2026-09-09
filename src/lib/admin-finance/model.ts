import { getOrderCommercialNetUsd } from '../orders/order-money.ts';
import {
  addDateKeyDays,
  ADMIN_FINANCE_TIME_ZONE,
  listDateKeys,
  type AdminFinancePeriod,
} from './period.ts';

export const ADMIN_FINANCE_DEFINITION_VERSION = 'admin-finance-v1' as const;

export type FinancialQualityCode = 'Q1_exact' | 'Q2_derived' | 'Q3_incomplete' | 'Q4_blocked';

export type FinancialSeriesPoint = {
  dateKey: string;
  salesUsd: number;
  collectionsUsd: number;
  externalOutflowsUsd: number;
};

export type CommercialSummary = {
  deliveredOrders: number;
  deliveredSalesUsd: number;
  previousDeliveredOrders: number;
  previousDeliveredSalesUsd: number;
  deliveredSalesChangePct: number | null;
  scheduledOrders: number;
  scheduledSalesUsd: number;
  blockedScheduledOrders: number;
  scheduledQuality: FinancialQualityCode;
  scheduledExactPricingOrders: number;
  quality: FinancialQualityCode;
  exactPricingOrders: number;
  totalPricingOrders: number;
  series: Array<Pick<FinancialSeriesPoint, 'dateKey' | 'salesUsd'>>;
};

export type TreasurySummary = {
  confirmedCollectionsUsd: number;
  otherExternalIncomeUsd: number;
  externalOutflowsUsd: number;
  netExternalCashFlowUsd: number | null;
  previousConfirmedCollectionsUsd: number;
  previousExternalOutflowsUsd: number;
  previousNetExternalCashFlowUsd: number | null;
  collectionsChangePct: number | null;
  netCashFlowChangePct: number | null;
  outflowQuality: FinancialQualityCode;
  netCashFlowQuality: FinancialQualityCode;
  derivedWithdrawalCount: number;
  unclassifiedAdjustmentCount: number;
  unclassifiedAdjustmentUsd: number;
  incompleteTransferGroups: number;
  previousUnclassifiedAdjustmentCount: number;
  previousUnclassifiedAdjustmentUsd: number;
  previousIncompleteTransferGroups: number;
  internalTransferGroupsExcluded: number;
  pendingPaymentReports: number;
  pendingPaymentReportsUsd: number;
  pendingMovementOperations: number;
  series: Array<Pick<FinancialSeriesPoint, 'dateKey' | 'collectionsUsd' | 'externalOutflowsUsd'>>;
};

export type FinancialAccountSnapshot = {
  moneyAccountId: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  balanceNative: number;
  currentValueUsd: number | null;
  anchorKind: 'closure' | 'baseline' | 'none';
  anchorDate: string | null;
  includedInTreasury: boolean;
};

export type PositionSummary = {
  activeRateBsPerUsd: number | null;
  activeRateEffectiveAt: string | null;
  previousRateBsPerUsd: number | null;
  activeRateCount: number;
  activeAccounts: number;
  anchoredAccounts: number;
  latestClosureDate: string | null;
  accountCoverageQuality: FinancialQualityCode;
  clientFundsUsd: number | null;
  clientFundLedgerUsd: number | null;
  clientFundDifferenceUsd: number | null;
  clientFundsQuality: FinancialQualityCode;
  openReconciliations: number;
  openReconciliationsUsd: number;
  orphanedReconciliations: number;
  treasuryPositionUsd: number | null;
  treasuryAfterClientFundsUsd: number | null;
  treasuryQuality: FinancialQualityCode;
  accounts: FinancialAccountSnapshot[];
};

export type AdminFinanceDomain<T> =
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export type AdminFinancialOverview = {
  definitionVersion: typeof ADMIN_FINANCE_DEFINITION_VERSION;
  period: AdminFinancePeriod;
  commercial: AdminFinanceDomain<CommercialSummary>;
  treasury: AdminFinanceDomain<TreasurySummary>;
  position: AdminFinanceDomain<PositionSummary>;
};

export type FinancialOrderRow = {
  id: number | string;
  total_usd: number | string | null;
  total_bs_snapshot?: number | string | null;
  queued_needs_reapproval?: boolean | null;
  extra_fields?: {
    pricing?: Record<string, unknown> | null;
  } | null;
};

export type DeliveredEventRow = {
  order_id: number | string;
  created_at: string;
};

export type FinancialMovementRow = {
  id: number | string;
  movement_date: string;
  direction: string;
  movement_type: string;
  amount_usd_equivalent: number | string | null;
  movement_group_id: string | null;
  description?: string | null;
  order_id?: number | string | null;
};

export type PendingPaymentReportRow = {
  id: number | string;
  reported_amount_usd_equivalent: number | string | null;
};

export type PendingMovementRow = {
  id: number | string;
  movement_group_id: string | null;
};

type AccountRow = {
  id: number | string;
  name: string | null;
  currency_code: string | null;
  is_active: boolean | null;
};

type AccountProfileRow = {
  money_account_id: number | string;
  closure_kind: string | null;
};

type AccountAnchorRow = {
  money_account_id: number | string;
  date: string | null;
};

type ReconciliationRow = {
  amount_usd_equivalent: number | string | null;
};

type ClientFundBalanceRow = {
  fund_balance_usd: number | string | null;
};

type ClientFundMovementRow = {
  movement_type: string | null;
  amount_usd: number | string | null;
};

type ActiveRateRow = {
  rate_bs_per_usd: number | string | null;
  effective_at: string | null;
  previous_rate_bs_per_usd: number | string | null;
};

type BalanceSnapshotRow = {
  moneyAccountId: number;
  currencyCode: 'USD' | 'VES';
  balanceNative: number;
  anchorKind: 'closure' | 'baseline' | 'none';
  anchorDate: string | null;
};

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundFinancialAmount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function financialChangePct(current: number, previous: number) {
  if (Math.abs(previous) < 0.005) return null;
  return Math.round((((current - previous) / Math.abs(previous)) * 100 + Number.EPSILON) * 10) / 10;
}

function isWithin(dateKey: string, startKey: string, endExclusiveKey: string) {
  return dateKey >= startKey && dateKey < endExclusiveKey;
}

function caracasDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ADMIN_FINANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hasExactCommercialPricing(order: FinancialOrderRow) {
  const value = order.extra_fields?.pricing?.subtotal_after_discount_usd;
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

export function buildCommercialSummary(input: {
  period: AdminFinancePeriod;
  deliveredEvents: DeliveredEventRow[];
  deliveredOrders: FinancialOrderRow[];
  scheduledOrders: FinancialOrderRow[];
}): CommercialSummary {
  const orderById = new Map(input.deliveredOrders.map((order) => [Number(order.id), order]));
  const latestDeliveredEventByOrderId = new Map<number, DeliveredEventRow>();
  const salesByDate = new Map<string, number>();
  let deliveredOrders = 0;
  let deliveredSalesUsd = 0;
  let previousDeliveredOrders = 0;
  let previousDeliveredSalesUsd = 0;
  let exactPricingOrders = 0;
  let totalPricingOrders = 0;

  for (const event of input.deliveredEvents) {
    const orderId = Number(event.order_id);
    const previousEvent = latestDeliveredEventByOrderId.get(orderId);
    if (!previousEvent || event.created_at > previousEvent.created_at) {
      latestDeliveredEventByOrderId.set(orderId, event);
    }
  }

  for (const event of latestDeliveredEventByOrderId.values()) {
    const order = orderById.get(Number(event.order_id));
    if (!order) continue;
    const dateKey = caracasDateKey(event.created_at);
    if (!dateKey) continue;
    const amount = getOrderCommercialNetUsd(order);

    if (isWithin(dateKey, input.period.startKey, input.period.endExclusiveKey)) {
      deliveredOrders += 1;
      deliveredSalesUsd += amount;
      totalPricingOrders += 1;
      if (hasExactCommercialPricing(order)) exactPricingOrders += 1;
      salesByDate.set(dateKey, (salesByDate.get(dateKey) ?? 0) + amount);
    } else if (isWithin(dateKey, input.period.previousStartKey, input.period.previousEndExclusiveKey)) {
      previousDeliveredOrders += 1;
      previousDeliveredSalesUsd += amount;
    }
  }

  const eligibleScheduledOrders = input.scheduledOrders.filter(
    (order) => !order.queued_needs_reapproval
  );
  const blockedScheduledOrders = input.scheduledOrders.length - eligibleScheduledOrders.length;
  const scheduledSalesUsd = eligibleScheduledOrders.reduce(
    (total, order) => total + getOrderCommercialNetUsd(order),
    0
  );
  const scheduledExactPricingOrders = eligibleScheduledOrders.filter(hasExactCommercialPricing).length;
  const currentSales = roundFinancialAmount(deliveredSalesUsd);
  const previousSales = roundFinancialAmount(previousDeliveredSalesUsd);

  return {
    deliveredOrders,
    deliveredSalesUsd: currentSales,
    previousDeliveredOrders,
    previousDeliveredSalesUsd: previousSales,
    deliveredSalesChangePct: financialChangePct(currentSales, previousSales),
    scheduledOrders: eligibleScheduledOrders.length,
    scheduledSalesUsd: roundFinancialAmount(scheduledSalesUsd),
    blockedScheduledOrders,
    scheduledQuality:
      eligibleScheduledOrders.length === scheduledExactPricingOrders ? 'Q1_exact' : 'Q2_derived',
    scheduledExactPricingOrders,
    quality: totalPricingOrders === exactPricingOrders ? 'Q1_exact' : 'Q2_derived',
    exactPricingOrders,
    totalPricingOrders,
    series: listDateKeys(input.period.startKey, input.period.endExclusiveKey).map((dateKey) => ({
      dateKey,
      salesUsd: roundFinancialAmount(salesByDate.get(dateKey) ?? 0),
    })),
  };
}

function buildMovementGroups(rows: FinancialMovementRow[]) {
  const groups = new Map<string, FinancialMovementRow[]>();
  for (const row of rows) {
    if (!row.movement_group_id) continue;
    const group = groups.get(row.movement_group_id) ?? [];
    group.push(row);
    groups.set(row.movement_group_id, group);
  }
  return groups;
}

function requiredFinancialAmount(value: number | string | null, context: string) {
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`${context} no tiene equivalente USD.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${context} tiene un equivalente USD invalido.`);
  return parsed;
}

function isTransferMarker(row: FinancialMovementRow) {
  const description = row.description?.trim().toLocaleLowerCase('es-VE') ?? '';
  return description.startsWith('traspaso salida') || description.startsWith('traspaso entrada');
}

function classifyTransferGroups(rows: FinancialMovementRow[]) {
  const internal = new Set<string>();
  const incomplete = new Set<string>();
  for (const [groupId, group] of buildMovementGroups(rows)) {
    const origins = group.filter(
      (movement) => movement.direction === 'outflow' && movement.movement_type === 'withdrawal'
    );
    const destinations = group.filter(
      (movement) => movement.direction === 'inflow' && movement.movement_type === 'other_income'
    );
    const hasTransferEvidence =
      (origins.length > 0 && destinations.length > 0) || group.some(isTransferMarker);
    const isPairedTransfer = origins.length === 1 && destinations.length === 1;

    if (isPairedTransfer) internal.add(groupId);
    if (!hasTransferEvidence) continue;

    const hasUnclassifiedFxDifference =
      isPairedTransfer &&
      Math.abs(
        requiredFinancialAmount(origins[0].amount_usd_equivalent, `Traspaso ${groupId}`) -
          requiredFinancialAmount(destinations[0].amount_usd_equivalent, `Traspaso ${groupId}`)
      ) > 0.005;
    if (!isPairedTransfer || hasUnclassifiedFxDifference) incomplete.add(groupId);
  }
  return { internal, incomplete };
}

function summarizeTreasuryRange(
  rows: FinancialMovementRow[],
  startKey: string,
  endExclusiveKey: string,
  transferGroups: ReturnType<typeof classifyTransferGroups>
) {
  let collections = 0;
  let otherIncome = 0;
  let outflows = 0;
  let derivedWithdrawalCount = 0;
  let unclassifiedAdjustmentCount = 0;
  let unclassifiedAdjustmentUsd = 0;
  const incompleteTransferGroups = new Set<string>();
  const internalTransferGroups = new Set<string>();

  for (const row of rows) {
    if (!isWithin(row.movement_date, startKey, endExclusiveKey)) continue;
    const amount = requiredFinancialAmount(row.amount_usd_equivalent, `Movimiento ${row.id}`);
    const isInternalTransfer = Boolean(
      row.movement_group_id && transferGroups.internal.has(row.movement_group_id)
    );
    if (row.movement_group_id && transferGroups.incomplete.has(row.movement_group_id)) {
      incompleteTransferGroups.add(row.movement_group_id);
    }
    if (row.movement_group_id && transferGroups.internal.has(row.movement_group_id)) {
      internalTransferGroups.add(row.movement_group_id);
    }

    if (row.direction === 'inflow' && row.movement_type === 'order_payment') {
      collections += amount;
      continue;
    }

    if (row.direction === 'inflow' && row.movement_type === 'other_income' && !isInternalTransfer) {
      otherIncome += amount;
      continue;
    }

    if (
      row.direction === 'outflow' &&
      ['expense_payment', 'change_given', 'fee_charge'].includes(row.movement_type)
    ) {
      outflows += amount;
      continue;
    }

    if (row.direction === 'outflow' && row.movement_type === 'withdrawal' && !isInternalTransfer) {
      outflows += amount;
      derivedWithdrawalCount += 1;
      continue;
    }

    if (['adjustment', 'cash_count_adjustment'].includes(row.movement_type)) {
      unclassifiedAdjustmentCount += 1;
      unclassifiedAdjustmentUsd += amount;
    }
  }

  const roundedCollections = roundFinancialAmount(collections);
  const roundedOtherIncome = roundFinancialAmount(otherIncome);
  const roundedOutflows = roundFinancialAmount(outflows);
  return {
    collectionsUsd: roundedCollections,
    otherIncomeUsd: roundedOtherIncome,
    externalOutflowsUsd: roundedOutflows,
    netExternalUsd: roundFinancialAmount(roundedCollections + roundedOtherIncome - roundedOutflows),
    derivedWithdrawalCount,
    unclassifiedAdjustmentCount,
    unclassifiedAdjustmentUsd: roundFinancialAmount(unclassifiedAdjustmentUsd),
    incompleteTransferGroups: incompleteTransferGroups.size,
    internalTransferGroupsExcluded: internalTransferGroups.size,
  };
}

export function buildTreasurySummary(input: {
  period: AdminFinancePeriod;
  confirmedMovements: FinancialMovementRow[];
  pendingPaymentReports: PendingPaymentReportRow[];
  pendingMovements: PendingMovementRow[];
}): TreasurySummary {
  const transferGroups = classifyTransferGroups(input.confirmedMovements);
  const current = summarizeTreasuryRange(
    input.confirmedMovements,
    input.period.startKey,
    input.period.endExclusiveKey,
    transferGroups
  );
  const previous = summarizeTreasuryRange(
    input.confirmedMovements,
    input.period.previousStartKey,
    input.period.previousEndExclusiveKey,
    transferGroups
  );
  const pendingMovementOperationIds = new Set(
    input.pendingMovements.map((movement) => movement.movement_group_id || `movement:${movement.id}`)
  );
  const currentNetIsPublishable =
    current.unclassifiedAdjustmentCount === 0 && current.incompleteTransferGroups === 0;
  const previousNetIsPublishable =
    previous.unclassifiedAdjustmentCount === 0 && previous.incompleteTransferGroups === 0;
  const currentNet = currentNetIsPublishable ? current.netExternalUsd : null;
  const previousNet = previousNetIsPublishable ? previous.netExternalUsd : null;

  return {
    confirmedCollectionsUsd: current.collectionsUsd,
    otherExternalIncomeUsd: current.otherIncomeUsd,
    externalOutflowsUsd: current.externalOutflowsUsd,
    netExternalCashFlowUsd: currentNet,
    previousConfirmedCollectionsUsd: previous.collectionsUsd,
    previousExternalOutflowsUsd: previous.externalOutflowsUsd,
    previousNetExternalCashFlowUsd: previousNet,
    collectionsChangePct: financialChangePct(current.collectionsUsd, previous.collectionsUsd),
    netCashFlowChangePct:
      currentNet === null || previousNet === null ? null : financialChangePct(currentNet, previousNet),
    outflowQuality:
      current.unclassifiedAdjustmentCount > 0 || current.incompleteTransferGroups > 0
        ? 'Q3_incomplete'
        : current.derivedWithdrawalCount > 0
          ? 'Q2_derived'
          : 'Q1_exact',
    netCashFlowQuality:
      currentNet === null
        ? 'Q4_blocked'
        : current.derivedWithdrawalCount > 0
          ? 'Q2_derived'
          : 'Q1_exact',
    derivedWithdrawalCount: current.derivedWithdrawalCount,
    unclassifiedAdjustmentCount: current.unclassifiedAdjustmentCount,
    unclassifiedAdjustmentUsd: current.unclassifiedAdjustmentUsd,
    incompleteTransferGroups: current.incompleteTransferGroups,
    previousUnclassifiedAdjustmentCount: previous.unclassifiedAdjustmentCount,
    previousUnclassifiedAdjustmentUsd: previous.unclassifiedAdjustmentUsd,
    previousIncompleteTransferGroups: previous.incompleteTransferGroups,
    internalTransferGroupsExcluded: current.internalTransferGroupsExcluded,
    pendingPaymentReports: input.pendingPaymentReports.length,
    pendingPaymentReportsUsd: roundFinancialAmount(
      input.pendingPaymentReports.reduce(
        (total, report) =>
          total + requiredFinancialAmount(report.reported_amount_usd_equivalent, `Reporte ${report.id}`),
        0
      )
    ),
    pendingMovementOperations: pendingMovementOperationIds.size,
    series: listDateKeys(input.period.startKey, input.period.endExclusiveKey).map((dateKey) => {
      const day = summarizeTreasuryRange(
        input.confirmedMovements,
        dateKey,
        addDateKeyDays(dateKey, 1),
        transferGroups
      );
      return {
        dateKey,
        collectionsUsd: day.collectionsUsd,
        externalOutflowsUsd: day.externalOutflowsUsd,
      };
    }),
  };
}

export function buildPositionSummary(input: {
  activeRate: ActiveRateRow | null;
  accounts: AccountRow[];
  profiles: AccountProfileRow[];
  baselines: AccountAnchorRow[];
  closures: AccountAnchorRow[];
  reconciliations: ReconciliationRow[];
  clientBalances: ClientFundBalanceRow[];
  clientFundMovements: ClientFundMovementRow[];
  balances?: BalanceSnapshotRow[];
  dataWasTruncated?: boolean;
}): PositionSummary {
  const activeAccounts = input.accounts.filter((account) => account.is_active !== false);
  const anchorIds = new Set([
    ...input.baselines.map((anchor) => Number(anchor.money_account_id)),
    ...input.closures.map((anchor) => Number(anchor.money_account_id)),
  ]);
  const profileByAccountId = new Map(
    input.profiles.map((profile) => [Number(profile.money_account_id), profile])
  );
  const rate = toNumber(input.activeRate?.rate_bs_per_usd);
  const clientFundsUsd = roundFinancialAmount(
    input.clientBalances.reduce((total, client) => total + toNumber(client.fund_balance_usd), 0)
  );
  const clientFundLedgerUsd = roundFinancialAmount(
    input.clientFundMovements.reduce((total, movement) => {
      const amount = toNumber(movement.amount_usd);
      if (movement.movement_type === 'credit') return total + amount;
      if (movement.movement_type === 'debit') return total - amount;
      return total;
    }, 0)
  );
  const clientFundDifferenceUsd = roundFinancialAmount(clientFundsUsd - clientFundLedgerUsd);
  const balanceByAccountId = new Map((input.balances ?? []).map((balance) => [balance.moneyAccountId, balance]));
  const accounts: FinancialAccountSnapshot[] = activeAccounts.map((account) => {
    const accountId = Number(account.id);
    const balance = balanceByAccountId.get(accountId) ?? null;
    const profile = profileByAccountId.get(accountId) ?? null;
    const includedInTreasury = Boolean(profile?.closure_kind && profile.closure_kind !== 'retention');
    const currentValueUsd = balance
      ? balance.currencyCode === 'VES'
        ? rate > 0
          ? roundFinancialAmount(balance.balanceNative / rate)
          : null
        : roundFinancialAmount(balance.balanceNative)
      : null;
    return {
      moneyAccountId: accountId,
      name: account.name?.trim() || `Cuenta #${accountId}`,
      currencyCode: String(account.currency_code || '').toUpperCase() === 'VES' ? 'VES' : 'USD',
      balanceNative: roundFinancialAmount(balance?.balanceNative ?? 0),
      currentValueUsd,
      anchorKind: balance?.anchorKind ?? 'none',
      anchorDate: balance?.anchorDate ?? null,
      includedInTreasury,
    };
  });
  const closureDates = input.closures
    .map((closure) => closure.date)
    .filter((date): date is string => Boolean(date));

  return {
    activeRateBsPerUsd: rate > 0 ? rate : null,
    activeRateEffectiveAt: input.activeRate?.effective_at ?? null,
    previousRateBsPerUsd:
      toNumber(input.activeRate?.previous_rate_bs_per_usd) > 0
        ? toNumber(input.activeRate?.previous_rate_bs_per_usd)
        : null,
    activeRateCount: rate > 0 ? 1 : 0,
    activeAccounts: activeAccounts.length,
    anchoredAccounts: activeAccounts.filter((account) => anchorIds.has(Number(account.id))).length,
    latestClosureDate: closureDates.length > 0 ? closureDates.reduce((latest, date) => (date > latest ? date : latest)) : null,
    accountCoverageQuality:
      activeAccounts.length > 0 && activeAccounts.every((account) => anchorIds.has(Number(account.id)))
        ? 'Q1_exact'
        : 'Q3_incomplete',
    clientFundsUsd: input.dataWasTruncated ? null : clientFundsUsd,
    clientFundLedgerUsd: input.dataWasTruncated ? null : clientFundLedgerUsd,
    clientFundDifferenceUsd: input.dataWasTruncated ? null : clientFundDifferenceUsd,
    clientFundsQuality: input.dataWasTruncated
      ? 'Q4_blocked'
      : Math.abs(clientFundDifferenceUsd) <= 0.01
        ? 'Q1_exact'
        : 'Q3_incomplete',
    openReconciliations: input.reconciliations.length,
    openReconciliationsUsd: roundFinancialAmount(
      input.reconciliations.reduce(
        (total, reconciliation) => total + Math.abs(toNumber(reconciliation.amount_usd_equivalent)),
        0
      )
    ),
    orphanedReconciliations: 0,
    treasuryPositionUsd: null,
    treasuryAfterClientFundsUsd: null,
    treasuryQuality: 'Q4_blocked',
    accounts,
  };
}

export function compressFinancialSeries<T extends { dateKey: string }>(points: T[], maximum = 12) {
  if (points.length <= maximum) return points.map((point) => ({ label: point.dateKey, points: [point] }));
  const result: Array<{ label: string; points: T[] }> = [];
  const bucketSize = Math.ceil(points.length / maximum);
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const first = bucket[0]?.dateKey ?? '';
    const last = bucket[bucket.length - 1]?.dateKey ?? first;
    result.push({ label: first === last ? first : `${first}/${last.slice(8)}`, points: bucket });
  }
  return result;
}
