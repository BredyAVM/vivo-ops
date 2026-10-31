'use server';

import { requireAuthContext } from '@/lib/auth';

/** One shared, ownership-checked read. Never records or confirms a payment. */
export async function loadOrderPaymentDayQuoteAction(input: {
  orderId: number; operationDate: string; exchangeRate?: number;
}): Promise<{
  operationDate: string; pendingUsd: number; pendingBs: number; exchangeRate: number;
  snapshotRate: number; collectionMode: string; dayRates: number[];
}> {
  const ctx = await requireAuthContext();
  if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.operationDate) ||
    (input.exchangeRate != null && (!Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0))) {
    throw new Error('Revisa la orden, la fecha real del pago y la tasa.');
  }
  const { data, error } = await ctx.supabase.rpc('read_order_payment_day_quote_v1', {
    p_order_id: input.orderId, p_operation_date: input.operationDate, p_rate: input.exchangeRate ?? null,
  });
  if (error || !data) throw new Error('No se pudieron consultar las tasas de la fecha del pago. Revisa la fecha e intenta nuevamente.');
  return {
    operationDate: String(data.operationDate), pendingUsd: Number(data.pendingUsd), pendingBs: Number(data.pendingBs),
    exchangeRate: Number(data.exchangeRate), collectionMode: String(data.collectionMode),
    snapshotRate: Number(data.snapshotRate),
    dayRates: (Array.isArray(data.dayRates) ? data.dayRates : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0),
  };
}
