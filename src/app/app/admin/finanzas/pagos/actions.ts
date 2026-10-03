'use server';

import * as paymentReview from '@/lib/admin-finance/payment-review-actions';
import type { PaymentReviewDecision } from '@/lib/admin-finance/payment-review-model';

export async function loadAdminPaymentReviewAction(reportId: number, orderId: number) {
  return paymentReview.loadAdminPaymentReviewAction(reportId, orderId);
}

export async function reviewAdminPaymentAction(input: PaymentReviewDecision) {
  return paymentReview.reviewAdminPaymentAction(input);
}
