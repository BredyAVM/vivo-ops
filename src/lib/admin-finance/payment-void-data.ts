import 'server-only';
import type { requireAdminContext } from '@/lib/auth';
import { readAccountMovementDetail } from './movement-detail-data';
import { movementVoidBlock, positiveMovementId } from './movement-detail-model';
import type { PaymentReviewReport, PaymentVoidPreview } from './payment-review-model';

type Client = Awaited<ReturnType<typeof requireAdminContext>>['supabase'];
export async function readPaymentVoidPreview(client: Client, report: PaymentReviewReport): Promise<PaymentVoidPreview> {
  const movementId = positiveMovementId(report.confirmed_movement_id);
  if (report.status !== 'confirmed' || !movementId)
    throw new Error('El reporte no tiene un pago confirmado vinculado. Revisa su historial en la orden.');
  const root = await client.from('money_movements').select('money_account_id')
    .eq('id', movementId).eq('order_id', report.order_id).eq('payment_report_id', report.id).maybeSingle();
  const accountId = positiveMovementId(root.data?.money_account_id);
  if (root.error || !accountId) throw new Error('No se pudo verificar el vínculo entre el pago y esta orden.');
  const detail = await readAccountMovementDetail(client, accountId, movementId);
  if (!detail || detail.movement.orderId !== report.order_id || detail.movement.paymentReportId !== report.id)
    throw new Error('El pago cambió de vínculo. Actualiza la consulta.');
  return {
    accountId, movementId, fingerprint: detail.fingerprint,
    accountName: detail.accountNames[accountId], amount: detail.movement.amount,
    currency: detail.movement.currency, reference: detail.movement.reference,
    date: detail.movement.date,
    blocked: detail.movement.status !== 'confirmed' ? 'El movimiento ya no está confirmado. Actualiza la consulta.'
      : movementVoidBlock(detail.movements),
    movements: detail.movements.map(row => ({ id: row.id, accountName: detail.accountNames[row.accountId],
      amount: row.amount, currency: row.currency, direction: row.direction, type: row.type, orderId: row.orderId })),
  };
}
