import { indexKpiFinancialStates, kpiAmount } from '../orders/operational-kpis.ts';

export type OrderSearchPayment = {
  orderId: number;
  pendingUsd: number;
  overpaidUsd: number;
  pendingReports: number;
};

export function searchPaymentOrderIds(values: unknown, limit = 20): number[] {
  if (!Array.isArray(values) || values.length > limit) throw new Error('Selección de búsqueda inválida.');
  if (values.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) throw new Error('Orden de búsqueda inválida.');
  const ids = values as number[];
  return [...new Set(ids)];
}

type FinancialSearchRow = {
  order_id: number | string;
  total_usd: unknown;
  confirmed_paid_usd: unknown;
  pending_usd: unknown;
  overpaid_usd: unknown;
  pending_reports_count: unknown;
};

/** One bounded canonical read; never infer a balance from the order total. */
export async function readOrderSearchPayments(
  values: number[],
  read: (ids: number[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<OrderSearchPayment[]> {
  const ids = searchPaymentOrderIds(values);
  if (!ids.length) return [];
  const { data, error } = await read(ids);
  if (error || !Array.isArray(data)) throw new Error('No se pudieron consultar los saldos.');
  const states = indexKpiFinancialStates(data as FinancialSearchRow[], ids);
  return ids.map(orderId => {
    const state = states.get(orderId)!;
    const overpaidUsd = kpiAmount(state.overpaid_usd);
    const pendingReports = kpiAmount(state.pending_reports_count);
    if (overpaidUsd === null || pendingReports === null || !Number.isSafeInteger(pendingReports)) {
      throw new Error('Respuesta de pagos incompleta.');
    }
    return { orderId, pendingUsd: Number(state.pending_usd), overpaidUsd, pendingReports };
  });
}

export function orderSearchPaymentPresentation(payment: OrderSearchPayment | undefined, cancelled: boolean, loading: boolean) {
  if (cancelled) return { label: 'Cancelada · revisar pagos en el detalle', amountUsd: null, tone: 'neutral' as const, review: false };
  if (!payment) return { label: loading ? 'Consultando saldo…' : 'Saldo no disponible · abrir detalle', amountUsd: null, tone: 'neutral' as const, review: false };
  const review = payment.pendingReports > 0;
  if (payment.pendingUsd > 0.005) return { label: 'Pendiente por pagar', amountUsd: payment.pendingUsd, tone: 'pending' as const, review };
  if (payment.overpaidUsd > 0.005) return { label: 'Saldo a favor', amountUsd: payment.overpaidUsd, tone: 'paid' as const, review };
  return { label: review ? 'Sin saldo pendiente' : 'Pagado', amountUsd: null, tone: 'paid' as const, review };
}
