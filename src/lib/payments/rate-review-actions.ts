'use server';

import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';
import { paymentActionFailure, type PaymentActionResult } from '@/lib/payments/action-result';
import type { PaymentRateReview } from '@/lib/payments/rate-review-model';
export type { PaymentRateReview } from '@/lib/payments/rate-review-model';

export async function readPaymentRateReviewAction(reportId: number): Promise<PaymentActionResult<PaymentRateReview>> {
  try {
    const ctx = await requireMasterOrAdminContext();
    if (!Number.isSafeInteger(reportId) || reportId <= 0) throw new Error('Reporte inválido.');
    const { data, error } = await ctx.supabase.rpc('read_payment_rate_review_v1', { p_report_id: reportId });
    if (error) return paymentActionFailure(error, 'No se pudo consultar la revisión de tasa. Vuelve a consultar antes de confirmar.');
    if (!data || typeof data.available !== 'boolean') throw new Error('Invalid review response');
    return { ok: true, value: data as PaymentRateReview };
  } catch (error) {
    return paymentActionFailure(error, 'No se pudo consultar la revisión de tasa. Vuelve a consultar antes de confirmar.');
  }
}

export async function approvePaymentRateReviewAction(input: {
  reportId: number; decision: 'quoted' | 'reported'; reason: string; quoteId?: number | null;
}): Promise<PaymentActionResult<PaymentRateReview>> {
  try {
    const ctx = await requireAdminContext();
    if (!Number.isSafeInteger(input.reportId) || input.reportId <= 0) throw new Error('Reporte inválido.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!['quoted', 'reported'].includes(input.decision) || reason.length < 4 || reason.length > 1200 ||
      (input.quoteId != null && (!Number.isSafeInteger(input.quoteId) || input.quoteId <= 0)))
      throw new Error('Selecciona el tratamiento del pago e indica el acuerdo comprobado (4 a 1200 caracteres).');
    const { data, error } = await ctx.supabase.rpc('approve_payment_rate_review_v1', {
      p_report_id: input.reportId, p_decision: input.decision, p_reason: reason, p_quote_id: input.quoteId ?? null,
    });
    if (error) return paymentActionFailure(error, 'No se pudo comprobar la aprobación. Vuelve a consultar la revisión antes de reintentar.');
    if (!data || typeof data.available !== 'boolean') throw new Error('Invalid review response');
    return { ok: true, value: data as PaymentRateReview };
  } catch (error) {
    return paymentActionFailure(error, 'No se pudo comprobar la aprobación. Vuelve a consultar la revisión antes de reintentar.');
  }
}
