import 'server-only';

import {
  ADMIN_FINANCE_RECEIVABLES_DEFINITION_VERSION,
  type AdminFinanceReceivableOrder,
  type AdminFinanceReceivablesDomain,
  type AdminFinanceReceivablesOverview,
} from './receivables-model';
import { addDateKeyDays, buildAdminFinancePeriod, type AdminFinancePeriodKey } from './period';

export type AdminFinanceReceivablesRpcClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown) {
  if (!Array.isArray(value)) throw new Error('La respuesta de cartera no contiene las órdenes esperadas.');
  return value.map(record);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`La respuesta de cartera no contiene ${label}.`);
  return value;
}

function numberValue(value: unknown, label: string) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw new Error(`La respuesta de cartera no contiene ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`La respuesta de cartera contiene ${label} inválido.`);
  return parsed;
}

function integerValue(value: unknown, label: string) {
  return Math.max(0, Math.trunc(numberValue(value, label)));
}

function parseOrder(value: unknown): AdminFinanceReceivableOrder {
  const row = record(value);
  if (row.collectionStatus !== 'credit_open' && row.collectionStatus !== 'overdue_open') {
    throw new Error('La respuesta de cartera contiene un estado de cobro inválido.');
  }
  return {
    id: integerValue(row.id, 'el identificador de orden'),
    orderNumber: requiredString(row.orderNumber, 'el número de orden'),
    clientName: requiredString(row.clientName, 'el cliente'),
    advisorName: requiredString(row.advisorName, 'el asesor'),
    deliveryDate: requiredString(row.deliveryDate, 'la fecha de entrega'),
    dueDate: requiredString(row.dueDate, 'la fecha de vencimiento'),
    ageDays: integerValue(row.ageDays, 'la antigüedad'),
    totalUsd: numberValue(row.totalUsd, 'el total'),
    confirmedPaidUsd: numberValue(row.confirmedPaidUsd, 'el importe abonado'),
    pendingUsd: numberValue(row.pendingUsd, 'el saldo pendiente'),
    pendingReportsUsd: numberValue(row.pendingReportsUsd, 'el importe por revisar'),
    pendingReportsCount: integerValue(row.pendingReportsCount, 'los pagos por revisar'),
    paymentStatus: requiredString(row.paymentStatus, 'el estado financiero'),
    collectionStatus: row.collectionStatus,
  };
}

export function parseAdminFinanceReceivablesOverview(
  value: unknown,
  requestedAtIso: string
): AdminFinanceReceivablesOverview {
  const data = record(value);
  if (data.definitionVersion !== ADMIN_FINANCE_RECEIVABLES_DEFINITION_VERSION) {
    throw new Error('La respuesta de cartera usa una versión incompatible.');
  }
  const asOf = requiredString(data.asOf, 'la hora de corte');
  const returnedMs = new Date(asOf).getTime();
  const requestedMs = new Date(requestedAtIso).getTime();
  if (!Number.isFinite(returnedMs) || !Number.isFinite(requestedMs) || Math.abs(returnedMs - requestedMs) > 5 * 60 * 1000) {
    throw new Error('La hora de corte de cartera no es confiable.');
  }
  if (data.cutoffMode !== 'current_statement'
    || data.balanceSource !== 'canonical_order_financial_state'
    || data.paymentTimingBasis !== 'payment_registration_date'
    || data.graceDays !== 5) {
    throw new Error('La respuesta de cartera no respeta el contrato financiero esperado.');
  }
  const period = record(data.period);
  const portfolio = record(data.portfolio);
  return {
    definitionVersion: ADMIN_FINANCE_RECEIVABLES_DEFINITION_VERSION,
    asOf,
    asOfDate: requiredString(data.asOfDate, 'la fecha de corte'),
    cutoffMode: 'current_statement',
    balanceSource: 'canonical_order_financial_state',
    paymentTimingBasis: 'payment_registration_date',
    graceDays: 5,
    period: {
      from: requiredString(period.from, 'el inicio del período'),
      to: requiredString(period.to, 'el fin del período'),
      orders: integerValue(period.orders, 'las órdenes del período'),
      billedUsd: numberValue(period.billedUsd, 'la facturación del período'),
      coveredUsd: numberValue(period.coveredUsd, 'la cobertura del período'),
      pendingUsd: numberValue(period.pendingUsd, 'el pendiente del período'),
      punctualPaid: integerValue(period.punctualPaid, 'los pagos puntuales'),
      creditPaid: integerValue(period.creditPaid, 'los pagos en crédito'),
      overduePaid: integerValue(period.overduePaid, 'los pagos tardíos'),
      creditOpen: integerValue(period.creditOpen, 'los créditos abiertos'),
      overdueOpen: integerValue(period.overdueOpen, 'los vencidos abiertos'),
      missingRegistration: integerValue(period.missingRegistration, 'los registros incompletos'),
    },
    portfolio: {
      openOrders: integerValue(portfolio.openOrders, 'las órdenes abiertas'),
      receivableUsd: numberValue(portfolio.receivableUsd, 'la cartera total'),
      graceOrders: integerValue(portfolio.graceOrders, 'las órdenes en plazo'),
      graceUsd: numberValue(portfolio.graceUsd, 'la cartera en plazo'),
      overdueOrders: integerValue(portfolio.overdueOrders, 'las órdenes vencidas'),
      overdueUsd: numberValue(portfolio.overdueUsd, 'la cartera vencida'),
      pendingReports: integerValue(portfolio.pendingReports, 'los pagos por revisar'),
      pendingReportsUsd: numberValue(portfolio.pendingReportsUsd, 'el importe por revisar'),
      oldestAgeDays: integerValue(portfolio.oldestAgeDays, 'la mayor antigüedad'),
    },
    openOrders: records(data.openOrders).map(parseOrder),
  };
}

export async function loadAdminFinanceReceivablesOverview(input: {
  supabase: AdminFinanceReceivablesRpcClient;
  periodKey: AdminFinancePeriodKey;
  asOf?: Date;
}): Promise<AdminFinanceReceivablesDomain> {
  const asOf = input.asOf ?? new Date();
  const period = buildAdminFinancePeriod(input.periodKey, asOf);
  try {
    const result = await input.supabase.rpc('admin_finance_receivables_overview_v1', {
      p_period_from: period.startKey,
      p_period_to: addDateKeyDays(period.endExclusiveKey, -1),
    });
    if (result.error) throw new Error(result.error.message || 'No se pudo consultar la cartera.');
    return {
      status: 'ready',
      data: parseAdminFinanceReceivablesOverview(result.data, asOf.toISOString()),
    };
  } catch (error) {
    console.warn('admin finance receivables skipped', error instanceof Error ? error.message : error);
    return {
      status: 'error',
      message: 'No pudimos cargar la cartera. Ningún dato financiero fue modificado.',
    };
  }
}
