'use server';

import * as paymentReview from '@/lib/admin-finance/payment-review-actions';
import type { PaymentReviewDecision } from '@/lib/admin-finance/payment-review-model';

export async function loadAdminPaymentReviewAction(reportId: number, orderId: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reviewAdminPaymentAction(input: PaymentReviewDecision) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function voidAdminCustomerPaymentAction(input: Parameters<typeof paymentReview.voidAdminCustomerPaymentAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
