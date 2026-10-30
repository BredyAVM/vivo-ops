'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { readPaymentVoidPreview } from './payment-void-data';
import { voidAccountMovementAction } from './movement-detail-actions';
import { confirmPaymentReportAction, rejectPaymentReportAction } from '@/app/app/master/dashboard/actions';
import { paymentReviewConfirmation, paymentReviewSnapshot, validatePaymentReviewIdentity,
  type PaymentReviewContext, type PaymentReviewDecision, type PaymentReviewReport,
} from '@/lib/admin-finance/payment-review-model';

async function readReport(reportId: number, orderId: number) {
  const { supabase } = await requireAdminContext();
  validatePaymentReviewIdentity(reportId, orderId);
  const { data, error } = await supabase.from('payment_reports')
    .select('id,order_id,status,created_at,operation_date,reported_money_account_id,reported_currency_code,reported_amount,reported_exchange_rate_ves_per_usd,reference_code,payer_name,notes,review_notes,confirmed_movement_id')
    .eq('id', reportId).eq('order_id', orderId).maybeSingle();
  if (error) throw new Error('No se pudo consultar el reporte. Intenta de nuevo.');
  if (!data) throw new Error('No se encontró el reporte de esta orden.');
  return { supabase, report: data as PaymentReviewReport };
}

export async function loadAdminPaymentReviewAction(reportId: number, orderId: number): Promise<
  { ok: true; context: PaymentReviewContext } | { ok: false; message: string }
> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function voidAdminCustomerPaymentAction(input: {
  reportId: number; orderId: number; reportSnapshot: string; fingerprint: string; reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reviewAdminPaymentAction(input: PaymentReviewDecision) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
