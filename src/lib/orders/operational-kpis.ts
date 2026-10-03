import type { OrderMoneySource } from './order-money.ts';
import { isRecognizedBillingOrder, isScheduledClosingOrder } from './order-sales.ts';

export type OperationalKpiAmounts = {
  totalUsd: number;
  commercialNetUsd: number;
  confirmedPaidUsd: number | null;
  pendingUsd: number | null;
};

export type KpiFinancialState = {
  total_usd: unknown;
  confirmed_paid_usd: unknown;
  pending_usd: unknown;
};

/** Read-model precision only: never use these values to create payments or commissions. */
export function kpiAmount(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function hasValidKpiFinancialState(state: KpiFinancialState | null | undefined): state is KpiFinancialState {
  return Boolean(state && kpiAmount(state.total_usd) !== null &&
    kpiAmount(state.confirmed_paid_usd) !== null && kpiAmount(state.pending_usd) !== null);
}

export function indexKpiFinancialStates<T extends KpiFinancialState & { order_id: number | string }>(rows: T[], orderIds: number[]) {
  const selected = new Set(orderIds);
  const states = new Map<number, T>();
  for (const row of rows) {
    const id = Number(row?.order_id);
    if (!selected.has(id) || states.has(id)) throw new Error('Respuesta de saldos fuera de la selección o duplicada.');
    if (!hasValidKpiFinancialState(row)) throw new Error('Respuesta de saldos con importes incompletos o inválidos.');
    states.set(id, row);
  }
  if (states.size !== selected.size) throw new Error('No se pudieron completar todos los saldos de la selección.');
  return states;
}

export function getOrderOperationalKpiAmounts(order: OrderMoneySource, state?: KpiFinancialState | null): OperationalKpiAmounts {
  const pricing = order.extra_fields?.pricing;
  const storedTotal = kpiAmount(pricing?.total_usd) ?? kpiAmount(order.total_usd) ?? 0;
  const totalUsd = kpiAmount(state?.total_usd) ?? storedTotal;
  const tax = kpiAmount(pricing?.invoice_tax_amount_usd) ?? 0;
  // Commercial reporting uses the price snapshot, not today's catalog or exchange rate.
  const commercialNetUsd = kpiAmount(pricing?.subtotal_after_discount_usd) ?? Math.max(0, storedTotal - tax);
  const complete = hasValidKpiFinancialState(state);
  return {
    totalUsd, commercialNetUsd,
    confirmedPaidUsd: complete ? kpiAmount(state.confirmed_paid_usd) : null,
    // The canonical balance already applies rounding closures. A historical flag
    // must never hide a new balance after an authorized price adjustment.
    pendingUsd: complete ? kpiAmount(state.pending_usd) : null,
  };
}

export type OperationalKpiOrder = { status: string | null } & OperationalKpiAmounts;

/** Keep raw amounts through every intermediate subtotal; round only at the display boundary. */
export function sumOperationalKpis(orders: OperationalKpiOrder[]) {
  let cierres = 0, fact = 0, factNeta = 0, abonadoConfirmado = 0, pendiente = 0;
  let complete = true;
  for (const order of orders) {
    if (isScheduledClosingOrder(order)) cierres += 1;
    if (!isRecognizedBillingOrder(order)) continue;
    fact += order.totalUsd;
    factNeta += order.commercialNetUsd;
    if (order.confirmedPaidUsd === null || order.pendingUsd === null) complete = false;
    else { abonadoConfirmado += order.confirmedPaidUsd; pendiente += order.pendingUsd; }
  }
  return { cierres, fact, factNeta, abonadoConfirmado: complete ? abonadoConfirmado : null,
    pendiente: complete ? pendiente : null, financialStatesComplete: complete };
}

export function roundKpiAmount(amount: number) {
  return Math.round((amount + Number.EPSILON * Math.max(1, Math.abs(amount))) * 100) / 100;
}

type WorkspaceKpiOrder = {
  status: string | null;
  totalUsd: number;
  confirmedPaidUsd: number;
  balanceUsd: number;
  subtotalAfterDiscountUsd?: number | null;
  invoiceTaxAmountUsd?: number | null;
  kpiAmounts?: OperationalKpiAmounts;
};

export function buildOperationStats(orders: WorkspaceKpiOrder[]) {
  const totals = sumOperationalKpis(orders.map(order => ({ status: order.status,
    ...(order.kpiAmounts ?? { totalUsd: order.totalUsd,
      commercialNetUsd: order.subtotalAfterDiscountUsd ?? Math.max(0, order.totalUsd - (order.invoiceTaxAmountUsd ?? 0)),
      confirmedPaidUsd: order.confirmedPaidUsd, pendingUsd: order.balanceUsd }),
  })));
  return { cierres: totals.cierres, fact: roundKpiAmount(totals.fact), factNeta: roundKpiAmount(totals.factNeta),
    abonadoConfirmado: totals.abonadoConfirmado === null ? null : roundKpiAmount(totals.abonadoConfirmado),
    pendiente: totals.pendiente === null ? null : roundKpiAmount(totals.pendiente) };
}
