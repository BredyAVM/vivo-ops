'use server';

import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';

export type PaymentRateReview = {
  available: boolean;
  canApprove?: boolean;
  reportId?: number;
  orderId?: number;
  amountBs?: number;
  recordedRate?: number;
  quoteRate?: number | null;
  quoteUsd?: number | null;
  quoteBs?: number | null;
  source?: string;
  quoteCandidates?: Array<{ id: number; rate: number; pendingUsd: number; pendingBs: number; createdAt: string }>;
  decision?: 'quoted' | 'reported' | null;
  applied?: boolean;
};

export async function readPaymentRateReviewAction(reportId: number): Promise<PaymentRateReview> {
  const ctx = await requireMasterOrAdminContext();
  if (!Number.isSafeInteger(reportId) || reportId <= 0) throw new Error('Reporte inválido.');
  const { data, error } = await ctx.supabase.rpc('read_payment_rate_review_v1', { p_report_id: reportId });
  if (error) throw new Error(error.message);
  return data as PaymentRateReview;
}

export async function approvePaymentRateReviewAction(input: {
  reportId: number; decision: 'quoted' | 'reported'; reason: string; quoteId?: number | null;
}): Promise<PaymentRateReview> {
  const ctx = await requireAdminContext();
  if (!Number.isSafeInteger(input.reportId) || input.reportId <= 0) throw new Error('Reporte inválido.');
  const { data, error } = await ctx.supabase.rpc('approve_payment_rate_review_v1', {
    p_report_id: input.reportId, p_decision: input.decision, p_reason: input.reason.trim(), p_quote_id: input.quoteId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as PaymentRateReview;
}
