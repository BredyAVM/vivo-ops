'use server';

import { requireAuthContext } from '@/lib/auth';
import { buildOrderPaymentQuote, readOrderPaymentQuote, type PaymentQuoteState } from '@/lib/orders/payment-quote';

export async function loadOrderPaymentQuoteAction(input: { orderId: number }) {
  const ctx = await requireAuthContext();
  const quote = await readOrderPaymentQuote({
    orderId: input.orderId, actor: { userId: ctx.user.id, roles: ctx.roles }, now: new Date(),
    reader: {
      async readOrder(orderId) {
        const { data, error } = await ctx.supabase.from('orders')
          .select('id,status,attributed_advisor_id').eq('id', orderId).maybeSingle();
        if (error) throw new Error('No se pudo consultar la orden.');
        return data ? { id: Number(data.id), status: String(data.status), attributed_advisor_id: data.attributed_advisor_id } : null;
      },
      async readActiveRate() {
        const { data, error } = await ctx.supabase.from('exchange_rates').select('rate_bs_per_usd')
          .eq('is_active', true).order('effective_at', { ascending: false }).limit(1).maybeSingle();
        if (error) throw new Error('No se pudo consultar la tasa vigente.');
        return data?.rate_bs_per_usd == null ? null : Number(data.rate_bs_per_usd);
      },
      async readState(orderId, operationDate, activeRate) {
        const { data, error } = await ctx.supabase.rpc('get_order_financial_state', {
          p_order_id: orderId, p_operation_date: operationDate, p_active_bs_rate: activeRate,
        });
        if (error) throw new Error('No se pudo consultar el saldo financiero.');
        return ((Array.isArray(data) ? data : []) as PaymentQuoteState[])[0] ?? null;
      },
    },
  });
  if (quote.pendingUsd <= 0 || quote.pendingBs <= 0) return quote;
  // The database recomputes the balance/rate itself; no browser-supplied totals
  // become evidence. This snapshot does not create a payment or freeze the rate.
  const { data, error } = await ctx.supabase.rpc('record_order_payment_quote_v1', { p_order_id: input.orderId });
  if (error) throw new Error(error.message);
  if (!data?.certificateId) throw new Error('El saldo cambió durante la consulta. Vuelve a cotizar para ver el importe actual.');
  const certified = buildOrderPaymentQuote({ orderId: input.orderId, activeRate: Number(data.activeRate), now: new Date(data.generatedAt),
    state: { order_id: input.orderId, pending_usd: data.pendingUsd, pending_bs: data.pendingBs,
      snapshot_rate_bs_per_usd: data.exchangeRate, collection_mode: data.collectionMode,
      pending_reports_count: data.pendingReportsCount, effective_operation_date: data.operationDate } });
  return { ...certified, text: `${certified.text}\nCotización registrada: Q${data.certificateId}` };
}
