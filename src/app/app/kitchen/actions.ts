'use server';

import { revalidatePath } from 'next/cache';
import { getAuthContext, requireAuthContext } from '@/lib/auth';
import { kitchenTakeAction } from '../master/dashboard/actions';

export type KitchenTakeResult =
  | { outcome: 'taken'; status: 'in_kitchen'; message: null }
  | { outcome: 'state_changed'; status: string; message: string }
  | { outcome: 'error'; status: null; message: string };

function changedKitchenState(status: string): KitchenTakeResult {
  const messages: Record<string, string> = {
    in_kitchen: 'Este pedido ya está en preparación. Se conserva su tiempo original.',
    ready: 'Este pedido ya está listo. No es necesario volver a tomarlo.',
    out_for_delivery: 'Este pedido ya salió a delivery. No se volvió a tomar.',
    delivered: 'Este pedido ya fue entregado. No se volvió a tomar.',
    cancelled: 'Este pedido fue cancelado. No se volvió a tomar.',
  };
  return {
    outcome: 'state_changed', status,
    message: messages[status] ?? 'El estado de este pedido cambió y ya no permite tomarlo en Cocina. Revisa el estado actualizado con Máster.',
  };
}

// Kitchen-only adapter: keep the canonical mutation and its notifications in
// Master. A stale screen must never retry that mutation or overwrite its ETA.
export async function takeOrderForKitchenAction(input: {
  orderId: number;
  etaMinutes: number;
}): Promise<KitchenTakeResult> {
  const failure = (message: string): KitchenTakeResult => ({ outcome: 'error', status: null, message });
  const unconfirmed = () => failure('No pudimos confirmar el resultado. Revisa el estado actualizado antes de volver a intentarlo.');
  try {
    const ctx = await getAuthContext();
    if (!ctx) return failure('Tu sesión venció. Ingresa de nuevo antes de tomar el pedido.');
    if (!ctx.roles.some(role => role === 'admin' || role === 'master' || role === 'kitchen')) {
      return failure('Esta acción requiere permisos de Cocina, Máster o administrador.');
    }
    if (!Number.isSafeInteger(input?.orderId) || input.orderId <= 0
      || !Number.isSafeInteger(input?.etaMinutes) || input.etaMinutes <= 0 || input.etaMinutes > 180) {
      return failure('Indica un pedido y un tiempo de preparación válidos.');
    }
    const readStatus = async () => {
      const { data, error } = await ctx.supabase.from('orders')
        .select('status').eq('id', input.orderId).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.status as string | undefined;
    };
    const before = await readStatus();
    if (!before) return failure('No se pudo consultar este pedido. Actualiza la pantalla o solicita revisión a Máster.');
    if (before !== 'confirmed') return changedKitchenState(before);
    try {
      // At most ONE attempt. The canonical RPC atomically checks confirmed.
      await kitchenTakeAction({ orderId: input.orderId, etaMinutes: input.etaMinutes });
      return { outcome: 'taken', status: 'in_kitchen', message: null };
    } catch (error) {
      // A concurrent take, or a failure after the mutation, can leave the order
      // already in preparation. Re-read, never repeat the write/events.
      console.error('Kitchen take could not complete', { orderId: input.orderId, error });
      const after = await readStatus();
      if (after && after !== 'confirmed') return changedKitchenState(after);
      return unconfirmed();
    }
  } catch (error) {
    console.error('Kitchen take state verification failed', { orderId: input?.orderId, error });
    return unconfirmed();
  }
}

type KitchenChangeRecipientRow = {
  id: number | string;
  event_id: number | string;
};

type KitchenChangeEventRow = {
  id: number | string;
  order_id: number | string;
  event_type: string | null;
};

export async function acknowledgeKitchenOrderChangesAction(input: {
  orderId: number;
  recipientIds: number[];
}) {
  const ctx = await requireAuthContext();
  const canOperateKitchen =
    ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('kitchen');

  if (!canOperateKitchen) {
    throw new Error('Esta acción requiere permisos de cocina, master o administrador.');
  }

  const orderId = Math.round(Number(input.orderId));
  const recipientIds = Array.from(
    new Set(
      (input.recipientIds ?? [])
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).slice(0, 50);

  if (!Number.isFinite(orderId) || orderId <= 0 || recipientIds.length === 0) {
    throw new Error('La confirmación de cambios no es válida.');
  }

  const { data: recipientsData, error: recipientsError } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .select('id, event_id')
    .in('id', recipientIds)
    .eq('target_role', 'kitchen');

  if (recipientsError) throw new Error(recipientsError.message);

  const recipients = (recipientsData ?? []) as KitchenChangeRecipientRow[];
  const eventIds = Array.from(
    new Set(
      recipients
        .map((recipient) => Number(recipient.event_id))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );

  if (eventIds.length === 0) {
    revalidatePath('/app/kitchen');
    return { ok: true as const };
  }

  const { data: eventsData, error: eventsError } = await ctx.supabase
    .from('order_timeline_events')
    .select('id, order_id, event_type')
    .in('id', eventIds)
    .eq('order_id', orderId)
    .eq('event_type', 'order_modified');

  if (eventsError) throw new Error(eventsError.message);

  const validEventIds = new Set(
    ((eventsData ?? []) as KitchenChangeEventRow[]).map((event) => Number(event.id)),
  );
  const validRecipientIds = recipients
    .filter((recipient) => validEventIds.has(Number(recipient.event_id)))
    .map((recipient) => Number(recipient.id));

  if (validRecipientIds.length > 0) {
    const { error: updateError } = await ctx.supabase
      .from('order_timeline_event_recipients')
      .update({
        requires_action: false,
        read_at: new Date().toISOString(),
      })
      .in('id', validRecipientIds)
      .eq('target_role', 'kitchen');

    if (updateError) throw new Error(updateError.message);
  }

  revalidatePath('/app/kitchen');
  return { ok: true as const };
}
