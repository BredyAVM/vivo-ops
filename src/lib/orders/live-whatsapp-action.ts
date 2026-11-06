'use server';

import { requireAuthContext } from '@/lib/auth';
import { buildLiveOrderWhatsAppSummary } from './live-whatsapp-summary';

export async function loadLiveOrderWhatsAppAction(orderId: number) {
  try {
    const ctx = await requireAuthContext();
    if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
      !ctx.roles.some(role => ['admin', 'master', 'advisor'].includes(role))) {
      return {ok: false as const, message: 'No tienes acceso a esta orden.'};
    }
    const {data, error} = await ctx.supabase.rpc('read_order_whatsapp_snapshot_v1', {p_order_id: orderId});
    if (error || !data) {
      console.warn('live WhatsApp snapshot unavailable', {orderId, code: error?.code});
      return {ok: false as const, message: 'No se pudo verificar el pedido y su pago actual. Intenta de nuevo; no se copió información anterior.'};
    }
    return {ok: true as const, text: buildLiveOrderWhatsAppSummary(data)};
  } catch {
    return {ok: false as const, message: 'No se pudo consultar el pedido actual. Revisa tu conexión y vuelve a intentar.'};
  }
}
