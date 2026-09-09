import 'server-only';

import {
  ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION,
  ADMIN_FINANCE_ACCOUNT_DETAIL_PAGE_SIZE,
  resolveAccountWorkstream,
  type AdminFinanceAccountDetail,
  type AdminFinanceAccountDetailRow,
  type AdminFinanceAccountSection,
  type AdminFinanceAccountSnapshot,
  type AdminFinanceAccountsDomain,
  type AdminFinanceAccountsOverview,
} from './accounts-model';
import type { FinancialQualityCode } from './model';
import type { MoneyAccountClosureKind, MoneyAccountKind } from '../domain/finance-domain';

export type AdminFinanceAccountsRpcClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type JsonRecord = Record<string, unknown>;

const accountKinds = new Set<MoneyAccountKind>(['bank', 'cash', 'fund', 'other', 'pos', 'wallet']);
const closureKinds = new Set<MoneyAccountClosureKind>([
  'bank',
  'cash',
  'fund',
  'other',
  'pos',
  'wallet_usd',
  'retention',
]);
const qualityCodes = new Set<FinancialQualityCode>([
  'Q1_exact',
  'Q2_derived',
  'Q3_incomplete',
  'Q4_blocked',
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function records(value: unknown) {
  if (!Array.isArray(value)) throw new Error('La respuesta de cuentas no contiene el listado esperado.');
  return value.map(record);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`La respuesta de cuentas no contiene ${label}.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown, label: string) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw new Error(`La respuesta de cuentas no contiene ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`La respuesta de cuentas contiene ${label} invalido.`);
  return parsed;
}

function integerValue(value: unknown, label: string) {
  return Math.max(0, Math.trunc(numberValue(value, label)));
}

function nullableNumber(value: unknown, label: string) {
  return value === null || value === undefined || value === '' ? null : numberValue(value, label);
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`La respuesta de cuentas no contiene ${label}.`);
  return value;
}

function currencyValue(value: unknown): 'USD' | 'VES' {
  if (value !== 'USD' && value !== 'VES') throw new Error('La respuesta contiene una moneda no soportada.');
  return value;
}

function accountKindValue(value: unknown) {
  if (!accountKinds.has(value as MoneyAccountKind)) throw new Error('La respuesta contiene un tipo de cuenta invalido.');
  return value as MoneyAccountKind;
}

function closureKindValue(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  if (!closureKinds.has(value as MoneyAccountClosureKind)) {
    throw new Error('La respuesta contiene un perfil de cierre invalido.');
  }
  return value as MoneyAccountClosureKind;
}

function qualityValue(value: unknown) {
  if (!qualityCodes.has(value as FinancialQualityCode)) {
    throw new Error('La respuesta contiene una calidad financiera invalida.');
  }
  return value as FinancialQualityCode;
}

function parseAccount(value: unknown): AdminFinanceAccountSnapshot {
  const row = record(value);
  const accountKind = accountKindValue(row.accountKind);
  const closureKind = closureKindValue(row.closureKind);
  const anchorKind = row.anchorKind;
  if (anchorKind !== 'closure' && anchorKind !== 'baseline' && anchorKind !== 'none') {
    throw new Error('La respuesta contiene un ancla financiera invalida.');
  }
  const latestClosureStatus = row.latestClosureStatus;
  if (
    latestClosureStatus !== null &&
    latestClosureStatus !== undefined &&
    latestClosureStatus !== 'recorded' &&
    latestClosureStatus !== 'approved' &&
    latestClosureStatus !== 'rejected'
  ) {
    throw new Error('La respuesta contiene un estado de cierre invalido.');
  }

  return {
    id: integerValue(row.id, 'el identificador de cuenta'),
    name: requiredString(row.name, 'el nombre de cuenta'),
    currencyCode: currencyValue(row.currencyCode),
    accountKind,
    workstream: resolveAccountWorkstream({ accountKind, closureKind }),
    institutionName: optionalString(row.institutionName),
    ownerName: optionalString(row.ownerName),
    isActive: booleanValue(row.isActive, 'el estado de la cuenta'),
    closureKind,
    baselineRequired: booleanValue(row.baselineRequired, 'la regla de baseline'),
    balanceNative: numberValue(row.balanceNative, 'el saldo nativo'),
    ledgerValueUsd: numberValue(row.ledgerValueUsd, 'la equivalencia historica'),
    currentValueUsd: nullableNumber(row.currentValueUsd, 'la valoracion actual'),
    anchorKind,
    anchorDate: optionalString(row.anchorDate),
    anchorAt: optionalString(row.anchorAt),
    anchorAmount: numberValue(row.anchorAmount, 'el importe del ancla'),
    latestClosureId: nullableNumber(row.latestClosureId, 'el identificador del cierre'),
    latestClosureDate: optionalString(row.latestClosureDate),
    latestClosureAt: optionalString(row.latestClosureAt),
    latestClosureStatus: (latestClosureStatus ?? null) as AdminFinanceAccountSnapshot['latestClosureStatus'],
    latestClosureDifference: nullableNumber(row.latestClosureDifference, 'la diferencia del cierre'),
    latestClosureDifferenceUsd: nullableNumber(row.latestClosureDifferenceUsd, 'la diferencia USD del cierre'),
    openReconciliations: integerValue(row.openReconciliations, 'las conciliaciones abiertas'),
    openReconciliationNative: numberValue(row.openReconciliationNative, 'el importe por conciliar'),
    openReconciliationUsd: numberValue(row.openReconciliationUsd, 'el importe USD por conciliar'),
    orphanedReconciliations: integerValue(row.orphanedReconciliations, 'las conciliaciones huerfanas'),
    pendingMovementOperations: integerValue(row.pendingMovementOperations, 'los movimientos pendientes'),
    pendingMovementNative: numberValue(row.pendingMovementNative, 'el importe pendiente'),
    pendingMovementUsd: numberValue(row.pendingMovementUsd, 'el importe pendiente USD'),
    quality: qualityValue(row.quality),
  };
}

function assertEnvelope(data: JsonRecord, requestedAtIso: string) {
  if (data.definitionVersion !== ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION) {
    throw new Error('La respuesta de cuentas usa una version incompatible.');
  }
  const returnedAsOf = requiredString(data.asOf, 'el instante de corte');
  const returnedAsOfMs = new Date(returnedAsOf).getTime();
  const requestedAtMs = new Date(requestedAtIso).getTime();
  if (
    !Number.isFinite(returnedAsOfMs) ||
    !Number.isFinite(requestedAtMs) ||
    Math.abs(returnedAsOfMs - requestedAtMs) > 5 * 60 * 1000
  ) {
    throw new Error('La hora de corte del servidor no es confiable.');
  }
}

function parseCurrentCutoff(data: JsonRecord) {
  if (data.cutoffMode !== 'current_statement') {
    throw new Error('La respuesta de cuentas no usa un corte actual del servidor.');
  }
  if (data.rateBasis !== 'single_active_at_current_statement') {
    throw new Error('La respuesta de cuentas no usa la regla de tasa esperada.');
  }
  return {
    cutoffMode: 'current_statement' as const,
    rateBasis: 'single_active_at_current_statement' as const,
    activeRateCount: integerValue(data.activeRateCount, 'la cantidad de tasas activas'),
    rateQuality: qualityValue(data.rateQuality),
  };
}

export function parseAdminFinanceAccountsOverview(value: unknown, asOfIso: string): AdminFinanceAccountsOverview {
  const data = record(value);
  assertEnvelope(data, asOfIso);
  const cutoff = parseCurrentCutoff(data);
  const summary = record(data.summary);
  return {
    definitionVersion: ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION,
    asOf: requiredString(data.asOf, 'el instante de corte'),
    ...cutoff,
    activeRateBsPerUsd: nullableNumber(data.activeRateBsPerUsd, 'la tasa activa'),
    activeRateEffectiveAt: optionalString(data.activeRateEffectiveAt),
    summary: {
      activeAccounts: integerValue(summary.activeAccounts, 'las cuentas activas'),
      inactiveAccounts: integerValue(summary.inactiveAccounts, 'las cuentas inactivas'),
      anchoredAccounts: integerValue(summary.anchoredAccounts, 'las cuentas con ancla'),
      attentionAccounts: integerValue(summary.attentionAccounts, 'las cuentas con atencion'),
      nativeUsdTotal: numberValue(summary.nativeUsdTotal, 'el total nativo USD'),
      nativeVesTotal: numberValue(summary.nativeVesTotal, 'el total nativo VES'),
      nativeUsdCoveredTotal: numberValue(summary.nativeUsdCoveredTotal, 'el total cubierto USD'),
      nativeUsdUncoveredTotal: numberValue(summary.nativeUsdUncoveredTotal, 'el total no cubierto USD'),
      nativeUsdCoveredAccounts: integerValue(summary.nativeUsdCoveredAccounts, 'las cuentas cubiertas USD'),
      nativeUsdTotalAccounts: integerValue(summary.nativeUsdTotalAccounts, 'las cuentas totales USD'),
      nativeUsdCoveragePct: nullableNumber(summary.nativeUsdCoveragePct, 'la cobertura USD'),
      nativeUsdQuality: qualityValue(summary.nativeUsdQuality),
      nativeVesCoveredTotal: numberValue(summary.nativeVesCoveredTotal, 'el total cubierto VES'),
      nativeVesUncoveredTotal: numberValue(summary.nativeVesUncoveredTotal, 'el total no cubierto VES'),
      nativeVesCoveredAccounts: integerValue(summary.nativeVesCoveredAccounts, 'las cuentas cubiertas VES'),
      nativeVesTotalAccounts: integerValue(summary.nativeVesTotalAccounts, 'las cuentas totales VES'),
      nativeVesCoveragePct: nullableNumber(summary.nativeVesCoveragePct, 'la cobertura VES'),
      nativeVesQuality: qualityValue(summary.nativeVesQuality),
      nativeTotalsQuality: qualityValue(summary.nativeTotalsQuality),
      openReconciliations: integerValue(summary.openReconciliations, 'las conciliaciones abiertas'),
      pendingMovementOperations: integerValue(summary.pendingMovementOperations, 'las operaciones pendientes'),
    },
    accounts: records(data.accounts).map(parseAccount),
  };
}

function movementStatus(value: unknown) {
  if (value !== 'pending' && value !== 'confirmed' && value !== 'rejected' && value !== 'voided') {
    throw new Error('La respuesta contiene un estado de movimiento invalido.');
  }
  return value;
}

function parseDetailRow(value: unknown): AdminFinanceAccountDetailRow {
  const row = record(value);
  if (row.kind === 'movement') {
    const direction = row.direction;
    if (direction !== 'inflow' && direction !== 'outflow') {
      throw new Error('La respuesta contiene una direccion de movimiento invalida.');
    }
    return {
      kind: 'movement',
      id: integerValue(row.id, 'el movimiento'),
      movementDate: requiredString(row.movementDate, 'la fecha del movimiento'),
      createdAt: requiredString(row.createdAt, 'la fecha de registro'),
      direction,
      movementType: requiredString(row.movementType, 'el tipo de movimiento'),
      currencyCode: currencyValue(row.currencyCode),
      amount: numberValue(row.amount, 'el importe del movimiento'),
      amountUsdEquivalent: numberValue(row.amountUsdEquivalent, 'la equivalencia del movimiento'),
      exchangeRateVesPerUsd: nullableNumber(row.exchangeRateVesPerUsd, 'la tasa del movimiento'),
      referenceCode: optionalString(row.referenceCode),
      counterpartyName: optionalString(row.counterpartyName),
      description: optionalString(row.description),
      orderId: nullableNumber(row.orderId, 'la orden del movimiento'),
      status: movementStatus(row.status),
      approvalRequired: booleanValue(row.approvalRequired, 'la regla de aprobacion'),
    };
  }

  if (row.kind === 'closure') {
    if (row.status !== 'recorded' && row.status !== 'approved' && row.status !== 'rejected') {
      throw new Error('La respuesta contiene un estado de cierre invalido.');
    }
    return {
      kind: 'closure',
      id: integerValue(row.id, 'el cierre'),
      closureDate: requiredString(row.closureDate, 'la fecha del cierre'),
      closureAt: requiredString(row.closureAt, 'la hora del cierre'),
      currencyCode: currencyValue(row.currencyCode),
      expectedAmount: numberValue(row.expectedAmount, 'el esperado del cierre'),
      countedAmount: numberValue(row.countedAmount, 'el contado del cierre'),
      differenceAmount: numberValue(row.differenceAmount, 'la diferencia del cierre'),
      expectedAmountUsd: numberValue(row.expectedAmountUsd, 'el esperado USD del cierre'),
      countedAmountUsd: numberValue(row.countedAmountUsd, 'el contado USD del cierre'),
      differenceAmountUsd: numberValue(row.differenceAmountUsd, 'la diferencia USD del cierre'),
      exchangeRateVesPerUsd: nullableNumber(row.exchangeRateVesPerUsd, 'la tasa del cierre'),
      status: row.status,
      reason: optionalString(row.reason),
    };
  }

  if (row.kind === 'reconciliation') {
    if (row.sourceKind !== 'baseline' && row.sourceKind !== 'closure' && row.sourceKind !== 'manual') {
      throw new Error('La respuesta contiene una fuente de conciliacion invalida.');
    }
    if (row.direction !== 'surplus' && row.direction !== 'shortage') {
      throw new Error('La respuesta contiene una direccion de conciliacion invalida.');
    }
    if (row.status !== 'open' && row.status !== 'resolved' && row.status !== 'voided') {
      throw new Error('La respuesta contiene un estado de conciliacion invalido.');
    }
    return {
      kind: 'reconciliation',
      id: integerValue(row.id, 'la conciliacion'),
      operationDate: optionalString(row.operationDate),
      createdAt: requiredString(row.createdAt, 'la fecha de conciliacion'),
      sourceKind: row.sourceKind,
      sourceId: nullableNumber(row.sourceId, 'la fuente de conciliacion'),
      itemType: requiredString(row.itemType, 'el tipo de conciliacion'),
      direction: row.direction,
      currencyCode: currencyValue(row.currencyCode),
      amount: numberValue(row.amount, 'el importe de conciliacion'),
      amountUsdEquivalent: numberValue(row.amountUsdEquivalent, 'la equivalencia de conciliacion'),
      referenceCode: optionalString(row.referenceCode),
      counterpartyName: optionalString(row.counterpartyName),
      description: requiredString(row.description, 'la descripcion de conciliacion'),
      status: row.status,
      orphanedSource: booleanValue(row.orphanedSource, 'la vigencia de la fuente'),
    };
  }

  throw new Error('La respuesta contiene una fila financiera desconocida.');
}

export function parseAdminFinanceAccountDetail(
  value: unknown,
  asOfIso: string
): AdminFinanceAccountDetail | null {
  const data = record(value);
  assertEnvelope(data, asOfIso);
  const cutoff = parseCurrentCutoff(data);
  if (data.found === false) return null;
  if (data.found !== true) throw new Error('La respuesta no confirma la cuenta solicitada.');
  const section = data.section;
  if (
    section !== 'movements' &&
    section !== 'closures' &&
    section !== 'reconciliation' &&
    section !== 'configuration'
  ) {
    throw new Error('La respuesta contiene una seccion financiera invalida.');
  }
  const period = record(data.period);
  return {
    definitionVersion: ADMIN_FINANCE_ACCOUNTS_DEFINITION_VERSION,
    asOf: requiredString(data.asOf, 'el instante de corte'),
    ...cutoff,
    account: parseAccount(data.account),
    section,
    fromDate: requiredString(data.fromDate, 'la fecha inicial'),
    toDate: requiredString(data.toDate, 'la fecha final'),
    status: requiredString(data.status, 'el filtro de estado'),
    page: Math.max(1, integerValue(data.page, 'la pagina')),
    pageSize: Math.max(1, integerValue(data.pageSize, 'el tamano de pagina')),
    totalRows: integerValue(data.totalRows, 'el total de filas'),
    period: {
      inflowNative: numberValue(period.inflowNative, 'las entradas del periodo'),
      outflowNative: numberValue(period.outflowNative, 'las salidas del periodo'),
      netNative: numberValue(period.netNative, 'el neto del periodo'),
      pendingNative: numberValue(period.pendingNative, 'el pendiente del periodo'),
    },
    rows: records(data.rows).map(parseDetailRow),
  };
}

async function runRpc<T>(input: {
  supabase: AdminFinanceAccountsRpcClient;
  name: string;
  params: Record<string, unknown>;
  parse: (value: unknown) => T;
}) {
  const result = await input.supabase.rpc(input.name, input.params);
  if (result.error) throw new Error(result.error.message || `No se pudo ejecutar ${input.name}.`);
  return input.parse(result.data);
}

export async function loadAdminFinanceAccountsOverview(input: {
  supabase: AdminFinanceAccountsRpcClient;
  asOf?: Date;
}): Promise<AdminFinanceAccountsDomain<AdminFinanceAccountsOverview>> {
  const asOfIso = (input.asOf ?? new Date()).toISOString();
  try {
    const data = await runRpc({
      supabase: input.supabase,
      name: 'admin_finance_accounts_overview_v2',
      params: { p_include_inactive: true },
      parse: (value) => parseAdminFinanceAccountsOverview(value, asOfIso),
    });
    return { status: 'ready', data };
  } catch (error) {
    console.warn('admin finance accounts overview skipped', error instanceof Error ? error.message : error);
    return {
      status: 'error',
      message: 'No pudimos cargar las cuentas financieras. Las herramientas vigentes siguen disponibles.',
    };
  }
}

export async function loadAdminFinanceAccountDetail(input: {
  supabase: AdminFinanceAccountsRpcClient;
  accountId: number;
  section: AdminFinanceAccountSection;
  fromDate: string;
  toDate: string;
  status: string;
  page: number;
  asOf?: Date;
}): Promise<AdminFinanceAccountsDomain<AdminFinanceAccountDetail | null>> {
  const asOfIso = (input.asOf ?? new Date()).toISOString();
  const page = Math.min(251, Math.max(1, Math.trunc(input.page)));
  try {
    const data = await runRpc({
      supabase: input.supabase,
      name: 'admin_finance_account_detail_v2',
      params: {
        p_account_id: input.accountId,
        p_section: input.section,
        p_from_date: input.fromDate,
        p_to_date: input.toDate,
        p_status: input.status,
        p_limit: ADMIN_FINANCE_ACCOUNT_DETAIL_PAGE_SIZE,
        p_offset: (page - 1) * ADMIN_FINANCE_ACCOUNT_DETAIL_PAGE_SIZE,
      },
      parse: (value) => parseAdminFinanceAccountDetail(value, asOfIso),
    });
    return { status: 'ready', data };
  } catch (error) {
    console.warn('admin finance account detail skipped', error instanceof Error ? error.message : error);
    return {
      status: 'error',
      message: 'No pudimos cargar el detalle de esta cuenta. Ninguna operación fue modificada.',
    };
  }
}
