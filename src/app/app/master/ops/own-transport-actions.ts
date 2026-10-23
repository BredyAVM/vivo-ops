'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

export async function assignOwnTransportAction(input: {
  orderId: number; name: string; phone: string; notes: string; operationId: string;
}) {
  try {
    const { supabase } = await requireMasterOrAdminContext();
    const { data, error } = await supabase.rpc('assign_own_transport_v1', {
      p_order_id: input.orderId, p_name: input.name, p_phone: input.phone || null,
      p_notes: input.notes || null, p_operation_id: input.operationId,
    });
    if (error) return { ok: false as const, message: error.message };
    for (const path of ['/app/master/ops','/app/admin/ordenes','/app/counter','/app/advisor/orders']) revalidatePath(path);
    return { ok: true as const, receipt: data };
  } catch {
    return { ok: false as const, message: 'No se pudo confirmar la asignación. Actualiza la orden antes de repetirla.' };
  }
}
