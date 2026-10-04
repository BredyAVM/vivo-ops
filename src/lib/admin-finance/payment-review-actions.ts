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
> {
  try {
    const { supabase, report } = await readReport(reportId, orderId);
    const { data: account, error: accountError } = await supabase.from('money_accounts')
      .select('name').eq('id', report.reported_money_account_id).maybeSingle();
    if (accountError || !account) throw new Error('No se pudo identificar la cuenta del pago.');
    // Read only this order, only after expanding the report. No history preload.
    let pendingUsd: number | null = null;
    if (report.status === 'pending') {
      const { data, error } = await supabase.rpc('get_order_financial_state', {
        p_order_id: orderId, p_operation_date: report.operation_date,
        p_active_bs_rate: report.reported_exchange_rate_ves_per_usd,
      });
      const row = Array.isArray(data) ? data[0] : null;
      const pending = row?.pending_usd;
      if (!error && pending != null && String(pending).trim() && Number.isFinite(Number(pending)))
        pendingUsd = Number(pending);
    }
    let voidPreview = null, voidUnavailable = null;
    if (report.status === 'confirmed') {
      try { voidPreview = await readPaymentVoidPreview(supabase, report); }
      catch (error) { voidUnavailable = error instanceof Error ? error.message : 'No se pudo verificar el pago confirmado.'; }
    }
    return { ok: true, context: { report, pendingUsd, accountName: account.name, voidPreview, voidUnavailable } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No se pudo revisar el pago.' };
  }
}

export async function voidAdminCustomerPaymentAction(input: {
  reportId: number; orderId: number; reportSnapshot: string; fingerprint: string; reason: string;
}) {
  try {
    const { supabase, report } = await readReport(input.reportId, input.orderId);
    if (report.status !== 'confirmed') throw new Error('El pago ya no está confirmado. Actualiza la consulta.');
    if (paymentReviewSnapshot(report) !== input.reportSnapshot)
      throw new Error('El reporte cambió. Cierra y vuelve a abrir el detalle.');
    const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 6 || reason.length > 500) throw new Error('Describe el motivo de anulación (6 a 500 caracteres).');
    const preview = await readPaymentVoidPreview(supabase, report);
    if (preview.blocked) throw new Error(preview.blocked);
    if (preview.fingerprint !== input.fingerprint)
      throw new Error('La operación vinculada cambió. Vuelve a revisar todos sus movimientos antes de anular.');
    // Derive account and movement from the persisted report, never from browser IDs.
    const result = await voidAccountMovementAction({ accountId: preview.accountId,
      movementId: preview.movementId, fingerprint: preview.fingerprint, reason });
    if (!result.ok) return result;
    // Money is already committed. Cache invalidation must not turn this into a retryable failure.
    try { revalidatePath('/app/admin', 'layout'); } catch { /* Receipt remains authoritative. */ }
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo comprobar la anulación. Actualiza la consulta.' };
  }
}

export async function reviewAdminPaymentAction(input: PaymentReviewDecision) {
  try {
    const { supabase, report } = await readReport(input.reportId, input.orderId);
    if (report.status !== 'pending') throw new Error('Este reporte ya fue revisado. Actualiza la consulta.');
    if (input.reportSnapshot !== paymentReviewSnapshot(report))
      throw new Error('El reporte cambió desde que lo abriste. Cierra y vuelve a abrir el detalle.');
    if (input.decision === 'reject') {
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (!reason) throw new Error('Debes indicar el motivo del rechazo.');
      if (reason.length > 2000) throw new Error('El motivo debe tener hasta 2000 caracteres.');
      await rejectPaymentReportAction({ reportId: report.id, reviewNotes: reason });
    } else if (input.decision === 'confirm') {
      const { data: account, error } = await supabase.from('money_accounts')
        .select('name,currency_code,is_active').eq('id', report.reported_money_account_id).maybeSingle();
      if (error || !account) throw new Error('No se pudo verificar la cuenta del reporte.');
      // The canonical transaction rechecks permissions, status and current balance
      // under locks; no parallel ledger/status writes from this new surface.
      await confirmPaymentReportAction(paymentReviewConfirmation(report, input, account));
    } else throw new Error('Acción de revisión inválida.');
    revalidatePath('/app/admin', 'layout');
    revalidatePath('/app/master/ops');
    return { ok: true as const, status: input.decision === 'confirm' ? 'confirmed' : 'rejected' };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo guardar la revisión.' };
  }
}
