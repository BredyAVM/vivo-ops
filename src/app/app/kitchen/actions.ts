'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

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
