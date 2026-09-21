'use server';
import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import type { EventPaymentAllocation } from '@/lib/events/event-payments';

export async function eventWorkspaceCommand(rootId: number, action: string, input: Record<string, unknown>) {
  const ctx = await requireAuthContext();
  if (!Number.isSafeInteger(rootId) || rootId <= 0 || !['terms', 'request', 'price', 'approve', 'reject', 'close'].includes(action)) {
    return { ok: false as const, error: 'La solicitud no es válida.' };
  }
  if (['terms', 'price'].includes(action) && !ctx.roles.includes('admin')) {
    return { ok: false as const, error: 'Solo Administración autoriza precios y comisiones.' };
  }
  const { data, error } = await ctx.supabase.rpc('event_workspace_command_v1', { p_root_id: rootId, p_action: action, p_input: input });
  if (error) return { ok: false as const, error: error.message };
  revalidatePath('/app/events', 'layout');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor/orders');
  return { ok: true as const, data: data as { id?: number; order_id?: number } };
}

export async function eventPaymentCommand(rootId: number, action: string, input: Record<string, unknown>) {
  const ctx = await requireAuthContext();
  if (!Number.isSafeInteger(rootId) || rootId <= 0 || !['preview', 'report', 'confirm', 'reject', 'void'].includes(action)) {
    return { ok: false as const, error: 'La solicitud no es válida.' };
  }
  if (['confirm', 'reject', 'void'].includes(action) && !ctx.roles.some(r => r === 'admin' || r === 'master')) {
    return { ok: false as const, error: 'Solo Máster o Administración revisan pagos.' };
  }
  if (action === 'void' && !ctx.roles.includes('admin')) return { ok: false as const, error: 'Solo Administración anula pagos.' };
  const { data, error } = await ctx.supabase.rpc('event_payment_command_v1', { p_root_id: rootId, p_action: action, p_input: input });
  if (error) return { ok: false as const, error: error.message };
  if (action !== 'preview') {
    revalidatePath('/app/events', 'layout');
    revalidatePath('/app/master/ops');
    revalidatePath('/app/advisor/orders');
  }
  return { ok: true as const, data: data as { id?: string; allocations?: EventPaymentAllocation[] } };
}
