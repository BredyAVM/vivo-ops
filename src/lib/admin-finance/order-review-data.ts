import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { sendPushToAdvisorDevices, sendPushToRoleDevices } from '@/lib/push';
import { parseOrderReview, parseOrderReviewReceipt, type OrderReviewAction, type OrderReviewResult } from './order-review-model';

export async function loadAdminOrderReview(orderId: number) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('admin_order_review_v1', { p_order_id: orderId });
  if (error) throw new Error('No se pudo cargar la revisión de la orden.');
  return parseOrderReview(data);
}
export async function approveAdminOrderReview(input: { orderId: number; snapshot: string; action: OrderReviewAction; notes: string }): Promise<OrderReviewResult> {
  const { supabase } = await requireAdminContext();
  if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0 || !/^[a-f0-9]{32}$/.test(input.snapshot)
    || !['approve', 'reapprove'].includes(input.action) || typeof input.notes !== 'string' || input.notes.length > 800) return { status: 'error', message: 'Revisión inválida.' };
  let result: OrderReviewResult;
  let receipt: Record<string, unknown>;
  try {
    const { data, error } = await supabase.rpc('approve_admin_order_review_v1', { p_order_id: input.orderId,
      p_snapshot: input.snapshot, p_action: input.action, p_notes: input.notes.trim() || null });
    if (error) {
      if (/^(22|23)|^42501$|^P0001$/.test(error.code ?? '')) return { status: 'error', message: error.message };
      throw new Error('Resultado no confirmado.');
    }
    result = parseOrderReviewReceipt(data, input.orderId, input.action);
    receipt = data as Record<string, unknown>;
  } catch { return { status: 'uncertain', message: 'No se confirmó el resultado. Actualiza la revisión antes de volver a decidir.' }; }
  if (result.status === 'approved') {
    // Only trusted committed receipts trigger the existing notification services.
    // Their failure must never hide an already committed approval.
    try {
      const title = input.action === 'approve' ? 'Orden aprobada' : 'Orden re-aprobada';
      const body = String(receipt.message || 'Revisión confirmada desde Administración.');
      await Promise.all([
        sendPushToRoleDevices({ roles: ['master'], title, body, url: `/app/master/ops?openOrder=${input.orderId}`, tag: `order-review-${result.eventId}` }),
        typeof receipt.advisorId === 'string' ? sendPushToAdvisorDevices({ advisorUserId: receipt.advisorId, orderId: input.orderId,
          eventType: input.action === 'approve' ? 'order_approved' : 'order_reapproved', title, body,
          orderNumber: String(receipt.orderNumber ?? ''), clientName: String(receipt.clientName ?? ''), tag: `order-review-${result.eventId}` }) : Promise.resolve(),
      ]);
    } catch { console.warn('Order review saved; device notification unavailable.'); }
  }
  return result;
}
