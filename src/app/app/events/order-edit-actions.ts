'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import { validateEventOrderEdit, type EventOrderEditData, type EventOrderEditInput } from '@/lib/events/event-order-edit';

export async function readEventOrderEditAction(orderId: number) {
  try {
    const ctx = await requireAuthContext();
    if (!ctx.roles.includes('admin')) return { ok: false as const, error: 'Solo Administración puede modificar el evento.' };
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return { ok: false as const, error: 'La orden no es válida.' };
    const { data, error } = await ctx.supabase.rpc('admin_event_order_read_v1', { p_order_id: orderId });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, data: data as EventOrderEditData };
  } catch { return { ok: false as const, error: 'No se pudo cargar el evento. Vuelve a consultar.' }; }
}

export async function saveEventOrderEditAction(orderId: number, version: string | null, input: EventOrderEditInput) {
  try {
    const ctx = await requireAuthContext();
    if (!ctx.roles.includes('admin')) return { ok: false as const, error: 'Solo Administración puede modificar el evento.' };
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return { ok: false as const, error: 'La orden no es válida.' };
    validateEventOrderEdit(input);
    const { data, error } = await ctx.supabase.rpc('admin_event_order_update_v1', {
      p_order_id: orderId, p_expected_version: version, p_input: input,
    });
    if (error) return { ok: false as const, error: error.message };
    try {
      revalidatePath('/app/admin/ordenes');
      revalidatePath('/app/master/ops');
      revalidatePath('/app/events', 'layout');
      revalidatePath('/app/admin/eventos', 'layout');
    } catch { console.warn('Event revision saved; view refresh deferred.'); }
    return { ok: true as const, data: data as { total_usd: number; amount: number } };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'No se pudo guardar. Actualiza el evento antes de reintentar.' };
  }
}
