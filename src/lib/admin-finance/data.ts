import 'server-only';

import {
  ADMIN_FINANCE_DEFINITION_VERSION,
  financialChangePct,
  type AdminFinanceDomain,
  type AdminFinancialOverview,
  type CommercialSummary,
  type FinancialQualityCode,
  type PositionSummary,
  type TreasurySummary,
} from './model';
import {
  buildAdminFinancePeriod,
  listDateKeys,
  type AdminFinancePeriod,
  type AdminFinancePeriodKey,
} from './period';

export type AdminFinanceRpcClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type JsonRecord = Record<string, unknown>;

const QUALITY_CODES = new Set<FinancialQualityCode>([
  'Q1_exact',
  'Q2_derived',
  'Q3_incomplete',
  'Q4_blocked',
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function numberValue(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw new Error('La respuesta financiera no contiene un valor numerico requerido.');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('La respuesta financiera contiene un valor numerico invalido.');
  }
  return parsed;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return numberValue(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function qualityValue(value: unknown): FinancialQualityCode {
  if (!QUALITY_CODES.has(value as FinancialQualityCode)) {
    throw new Error('La respuesta financiera contiene una calidad de datos invalida.');
  }
  return value as FinancialQualityCode;
}

function rows(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('La respuesta financiera no contiene la serie requerida.');
  }
  return value.map(record);
}

function assertRpcEnvelope(data: JsonRecord, expected: { asOf: string; period?: AdminFinancePeriod }) {
  if (data.definitionVersion !== ADMIN_FINANCE_DEFINITION_VERSION) {
    throw new Error('La respuesta financiera usa una version de definicion incompatible.');
  }

  const returnedAsOf = stringValue(data.asOf);
  if (!returnedAsOf || new Date(returnedAsOf).getTime() !== new Date(expected.asOf).getTime()) {
    throw new Error('La respuesta financiera no corresponde al mismo instante de corte.');
  }

  if (
    expected.period &&
    (data.periodStart !== expected.period.startKey ||
      data.periodEndExclusive !== expected.period.endExclusiveKey)
  ) {
    throw new Error('La respuesta financiera no corresponde al periodo solicitado.');
  }
}

function assertSeriesDates(series: Array<{ dateKey: string }>, period: AdminFinancePeriod) {
  const expectedDates = listDateKeys(period.startKey, period.endExclusiveKey);
  if (
    series.length !== expectedDates.length ||
    series.some((point, index) => point.dateKey !== expectedDates[index])
  ) {
    throw new Error('La serie financiera no cubre exactamente el periodo solicitado.');
  }
}

function parseCommercial(
  value: unknown,
  expected: { asOf: string; period: AdminFinancePeriod }
): CommercialSummary {
  const data = record(value);
  assertRpcEnvelope(data, expected);
  const deliveredSalesUsd = numberValue(data.deliveredSalesUsd);
  const previousDeliveredSalesUsd = numberValue(data.previousDeliveredSalesUsd);
  const series = rows(data.series)
    .map((point) => ({
      dateKey: stringValue(point.dateKey) ?? '',
      salesUsd: numberValue(point.salesUsd),
    }))
    .filter((point) => point.dateKey.length > 0);
  assertSeriesDates(series, expected.period);
  return {
    deliveredOrders: Math.max(0, Math.trunc(numberValue(data.deliveredOrders))),
    deliveredSalesUsd,
    previousDeliveredOrders: Math.max(0, Math.trunc(numberValue(data.previousDeliveredOrders))),
    previousDeliveredSalesUsd,
    deliveredSalesChangePct: financialChangePct(deliveredSalesUsd, previousDeliveredSalesUsd),
    scheduledOrders: Math.max(0, Math.trunc(numberValue(data.scheduledOrders))),
    scheduledSalesUsd: numberValue(data.scheduledSalesUsd),
    blockedScheduledOrders: Math.max(0, Math.trunc(numberValue(data.blockedScheduledOrders))),
    scheduledQuality: qualityValue(data.scheduledQuality),
    scheduledExactPricingOrders: Math.max(
      0,
      Math.trunc(numberValue(data.scheduledExactPricingOrders))
    ),
    quality: qualityValue(data.quality),
    exactPricingOrders: Math.max(0, Math.trunc(numberValue(data.exactPricingOrders))),
    totalPricingOrders: Math.max(0, Math.trunc(numberValue(data.totalPricingOrders))),
    series,
  };
}

function parseTreasury(
  value: unknown,
  expected: { asOf: string; period: AdminFinancePeriod }
): TreasurySummary {
  const data = record(value);
  assertRpcEnvelope(data, expected);
  const confirmedCollectionsUsd = numberValue(data.confirmedCollectionsUsd);
  const previousConfirmedCollectionsUsd = numberValue(data.previousConfirmedCollectionsUsd);
  const netExternalCashFlowUsd = nullableNumber(data.netExternalCashFlowUsd);
  const previousNetExternalCashFlowUsd = nullableNumber(data.previousNetExternalCashFlowUsd);
  const series = rows(data.series)
    .map((point) => ({
      dateKey: stringValue(point.dateKey) ?? '',
      collectionsUsd: numberValue(point.collectionsUsd),
      externalOutflowsUsd: numberValue(point.externalOutflowsUsd),
    }))
    .filter((point) => point.dateKey.length > 0);
  assertSeriesDates(series, expected.period);
  return {
    confirmedCollectionsUsd,
    otherExternalIncomeUsd: numberValue(data.otherExternalIncomeUsd),
    externalOutflowsUsd: numberValue(data.externalOutflowsUsd),
    netExternalCashFlowUsd,
    previousConfirmedCollectionsUsd,
    previousExternalOutflowsUsd: numberValue(data.previousExternalOutflowsUsd),
    previousNetExternalCashFlowUsd,
    collectionsChangePct: financialChangePct(confirmedCollectionsUsd, previousConfirmedCollectionsUsd),
    netCashFlowChangePct:
      netExternalCashFlowUsd === null || previousNetExternalCashFlowUsd === null
        ? null
        : financialChangePct(netExternalCashFlowUsd, previousNetExternalCashFlowUsd),
    outflowQuality: qualityValue(data.outflowQuality),
    netCashFlowQuality: qualityValue(data.netCashFlowQuality),
    derivedWithdrawalCount: Math.max(0, Math.trunc(numberValue(data.derivedWithdrawalCount))),
    unclassifiedAdjustmentCount: Math.max(
      0,
      Math.trunc(numberValue(data.unclassifiedAdjustmentCount))
    ),
    unclassifiedAdjustmentUsd: numberValue(data.unclassifiedAdjustmentUsd),
    incompleteTransferGroups: Math.max(
      0,
      Math.trunc(numberValue(data.incompleteTransferGroups))
    ),
    previousUnclassifiedAdjustmentCount: Math.max(
      0,
      Math.trunc(numberValue(data.previousUnclassifiedAdjustmentCount))
    ),
    previousUnclassifiedAdjustmentUsd: numberValue(data.previousUnclassifiedAdjustmentUsd),
    previousIncompleteTransferGroups: Math.max(
      0,
      Math.trunc(numberValue(data.previousIncompleteTransferGroups))
    ),
    internalTransferGroupsExcluded: Math.max(
      0,
      Math.trunc(numberValue(data.internalTransferGroupsExcluded))
    ),
    pendingPaymentReports: Math.max(0, Math.trunc(numberValue(data.pendingPaymentReports))),
    pendingPaymentReportsUsd: numberValue(data.pendingPaymentReportsUsd),
    pendingMovementOperations: Math.max(0, Math.trunc(numberValue(data.pendingMovementOperations))),
    series,
  };
}

function parsePosition(value: unknown, expected: { asOf: string }): PositionSummary {
  const data = record(value);
  assertRpcEnvelope(data, expected);
  return {
    activeRateBsPerUsd: nullableNumber(data.activeRateBsPerUsd),
    activeRateEffectiveAt: stringValue(data.activeRateEffectiveAt),
    previousRateBsPerUsd: nullableNumber(data.previousRateBsPerUsd),
    activeRateCount: Math.max(0, Math.trunc(numberValue(data.activeRateCount))),
    activeAccounts: Math.max(0, Math.trunc(numberValue(data.activeAccounts))),
    anchoredAccounts: Math.max(0, Math.trunc(numberValue(data.anchoredAccounts))),
    latestClosureDate: stringValue(data.latestClosureDate),
    accountCoverageQuality: qualityValue(data.accountCoverageQuality),
    clientFundsUsd: nullableNumber(data.clientFundsUsd),
    clientFundLedgerUsd: nullableNumber(data.clientFundLedgerUsd),
    clientFundDifferenceUsd: nullableNumber(data.clientFundDifferenceUsd),
    clientFundsQuality: qualityValue(data.clientFundsQuality),
    openReconciliations: Math.max(0, Math.trunc(numberValue(data.openReconciliations))),
    openReconciliationsUsd: numberValue(data.openReconciliationsUsd),
    orphanedReconciliations: Math.max(0, Math.trunc(numberValue(data.orphanedReconciliations))),
    treasuryPositionUsd: nullableNumber(data.treasuryPositionUsd),
    treasuryAfterClientFundsUsd: nullableNumber(data.treasuryAfterClientFundsUsd),
    treasuryQuality: qualityValue(data.treasuryQuality),
    accounts: [],
  };
}

async function runOverviewRpc<T>(input: {
  supabase: AdminFinanceRpcClient;
  name: string;
  params: Record<string, unknown>;
  parse: (value: unknown) => T;
}) {
  const result = await input.supabase.rpc(input.name, input.params);
  if (result.error) throw new Error(result.error.message || `No se pudo ejecutar ${input.name}.`);
  return input.parse(result.data);
}

function settledDomain<T>(
  result: PromiseSettledResult<T>,
  publicMessage: string,
  logLabel: string
): AdminFinanceDomain<T> {
  if (result.status === 'fulfilled') return { status: 'ready', data: result.value };
  console.warn(logLabel, result.reason instanceof Error ? result.reason.message : result.reason);
  return { status: 'error', message: publicMessage };
}

export async function loadAdminFinancialOverview(input: {
  supabase: AdminFinanceRpcClient;
  periodKey: AdminFinancePeriodKey;
  asOf?: Date;
}): Promise<AdminFinancialOverview> {
  const asOf = input.asOf ?? new Date();
  const asOfIso = asOf.toISOString();
  const period = buildAdminFinancePeriod(input.periodKey, asOf);
  const [commercial, treasury, position] = await Promise.allSettled([
    runOverviewRpc({
      supabase: input.supabase,
      name: 'admin_finance_commercial_overview_v1',
      params: { p_period: period.key, p_as_of: asOfIso },
      parse: (value) => parseCommercial(value, { asOf: asOfIso, period }),
    }),
    runOverviewRpc({
      supabase: input.supabase,
      name: 'admin_finance_treasury_overview_v1',
      params: { p_period: period.key, p_as_of: asOfIso },
      parse: (value) => parseTreasury(value, { asOf: asOfIso, period }),
    }),
    runOverviewRpc({
      supabase: input.supabase,
      name: 'admin_finance_position_overview_v1',
      params: { p_as_of: asOfIso },
      parse: (value) => parsePosition(value, { asOf: asOfIso }),
    }),
  ]);

  return {
    definitionVersion: ADMIN_FINANCE_DEFINITION_VERSION,
    period,
    commercial: settledDomain(
      commercial,
      'No pudimos cargar las ventas de este periodo.',
      'admin financial commercial overview skipped'
    ),
    treasury: settledDomain(
      treasury,
      'No pudimos cargar los movimientos de tesoreria de este periodo.',
      'admin financial treasury overview skipped'
    ),
    position: settledDomain(
      position,
      'No pudimos cargar la posicion financiera actual.',
      'admin financial position overview skipped'
    ),
  };
}
