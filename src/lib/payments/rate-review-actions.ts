'use server';

import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';
import { paymentActionFailure, type PaymentActionResult } from '@/lib/payments/action-result';
import type { PaymentRateReview } from '@/lib/payments/rate-review-model';
export type { PaymentRateReview } from '@/lib/payments/rate-review-model';

export async function readPaymentRateReviewAction(reportId: number): Promise<PaymentActionResult<PaymentRateReview>> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function approvePaymentRateReviewAction(input: {
  reportId: number; decision: 'quoted' | 'reported'; reason: string; quoteId?: number | null;
}): Promise<PaymentActionResult<PaymentRateReview>> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
