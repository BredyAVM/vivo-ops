import { sendPushToAdvisorDevices, sendPushToRoleDevices } from '@/lib/push';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';

export type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';
export type OrderNotificationSeverity = 'info' | 'warning' | 'critical';

export type OrderNotificationContext = {
  orderId: number;
  orderNumber: string | null;
  createdAt?: string | null;
  advisorUserId: string | null;
  internalDriverUserId?: string | null;
  fulfillment?: 'pickup' | 'delivery' | null;
  status?: string | null;
  clientName?: string | null;
};

export type OrderNotificationRecipient = {
  targetRole?: NotificationRole | null;
  targetUserId?: string | null;
  requiresAction?: boolean;
};

type SupabaseLike = {
  from: (table: string) => any;
};

type OrderNotificationInput = {
  orderId: number;
  eventType: string;
  eventGroup: string;
  title: string;
  message?: string | null;
  severity?: OrderNotificationSeverity;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string | null;
  context?: OrderNotificationContext | null;
  recipients?: OrderNotificationRecipient[];
};

export async function loadOrderNotificationContext(
  supabase: SupabaseLike,
  orderId: number,
): Promise<OrderNotificationContext | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, created_at, attributed_advisor_id, internal_driver_user_id, fulfillment, status, client:clients!orders_client_id_fkey(full_name)')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) return null;

  const client = Array.isArray(data.client) ? data.client[0] ?? null : data.client;

  return {
    orderId: Number(data.id),
    orderNumber: data.order_number == null ? null : String(data.order_number),
    createdAt: data.created_at == null ? null : String(data.created_at),
    advisorUserId: data.attributed_advisor_id ?? null,
    internalDriverUserId: data.internal_driver_user_id ?? null,
    fulfillment: data.fulfillment === 'pickup' || data.fulfillment === 'delivery' ? data.fulfillment : null,
    status: data.status == null ? null : String(data.status),
    clientName: client?.full_name == null ? null : String(client.full_name),
  };
}

function dedupeRecipients(recipients: OrderNotificationRecipient[]) {
  const seen = new Set<string>();
  const normalized: Array<{
    target_role: NotificationRole | null;
    target_user_id: string | null;
    requires_action: boolean;
  }> = [];

  for (const recipient of recipients) {
    const targetRole = recipient.targetRole ?? null;
    const targetUserId = recipient.targetUserId ?? null;
    if (!targetRole && !targetUserId) continue;

    const key = `${targetRole ?? ''}|${targetUserId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      target_role: targetRole,
      target_user_id: targetUserId,
      requires_action: Boolean(recipient.requiresAction),
    });
  }

  return normalized;
}

function getAdvisorPushTargets(params: {
  contextAdvisorUserId?: string | null;
  recipients?: OrderNotificationRecipient[];
}) {
  const advisorIds = new Set<string>();
  const contextAdvisorUserId = String(params.contextAdvisorUserId || '').trim();

  if (contextAdvisorUserId) advisorIds.add(contextAdvisorUserId);

  for (const recipient of params.recipients ?? []) {
    const targetUserId = String(recipient.targetUserId || '').trim();
    if (targetUserId) {
      advisorIds.add(targetUserId);
      continue;
    }

    if (recipient.targetRole === 'advisor' && contextAdvisorUserId) {
      advisorIds.add(contextAdvisorUserId);
    }
  }

  return Array.from(advisorIds);
}

/**
 * Único punto de escritura para los eventos operativos y sus destinatarios.
 * El historial de una orden, las alertas de Máster y el inbox del asesor parten
 * de estas mismas dos tablas.
 */
export async function appendOrderNotification(
  supabase: SupabaseLike,
  input: OrderNotificationInput,
) {
  const context = input.context ?? (await loadOrderNotificationContext(supabase, input.orderId));
  const eventRow: Record<string, unknown> = {
    order_id: input.orderId,
    order_number: context?.orderNumber ?? null,
    event_type: input.eventType,
    event_group: input.eventGroup,
    title: input.title,
    message: input.message ?? null,
    severity: input.severity ?? 'info',
    actor_user_id: input.actorUserId ?? null,
    payload: input.payload ?? {},
  };

  if (input.createdAt) {
    eventRow.created_at = input.createdAt;
  }

  const { data: insertedEvent, error: insertEventError } = await supabase
    .from('order_timeline_events')
    .insert(eventRow)
    .select('id')
    .single();

  if (insertEventError || !insertedEvent) {
    throw new Error(insertEventError?.message || 'No se pudo registrar el evento en el centro de notificaciones.');
  }

  const recipientRows = dedupeRecipients(input.recipients ?? []).map((recipient) => ({
    event_id: insertedEvent.id,
    target_role: recipient.target_role,
    target_user_id: recipient.target_user_id,
    requires_action: recipient.requires_action,
  }));

  if (recipientRows.length > 0) {
    const { error: recipientsError } = await supabase
      .from('order_timeline_event_recipients')
      .insert(recipientRows);

    if (recipientsError) {
      throw new Error(recipientsError.message);
    }
  }

  const advisorPushTargets = getAdvisorPushTargets({
    contextAdvisorUserId: context?.advisorUserId,
    recipients: input.recipients,
  });

  if (advisorPushTargets.length > 0) {
    const advisorPushRequiresAction = (input.recipients ?? []).some((recipient) => {
      const targetsAdvisor =
        recipient.targetRole === 'advisor' ||
        Boolean(recipient.targetUserId && recipient.targetUserId === context?.advisorUserId);
      return targetsAdvisor && Boolean(recipient.requiresAction);
    });
    const tag = advisorPushRequiresAction
      ? `advisor-order-${input.orderId}-${input.eventType}`
      : `advisor-order-${input.orderId}-status`;

    for (const advisorUserId of advisorPushTargets) {
      try {
        await sendPushToAdvisorDevices({
          advisorUserId,
          orderId: input.orderId,
          eventType: input.eventType,
          title: input.title,
          body: input.message,
          orderNumber: context?.orderNumber,
          clientName: context?.clientName,
          payload: input.payload,
          tag,
        });
      } catch (pushError) {
        console.warn(
          'notification center advisor push skipped',
          pushError instanceof Error ? pushError.message : 'unknown push error',
        );
      }
    }
  }

  const rolePushTargets = new Set<string>();
  for (const recipient of input.recipients ?? []) {
    if (!recipient.requiresAction) continue;
    if (recipient.targetRole === 'admin') rolePushTargets.add('admin');
    if (recipient.targetRole === 'master') {
      rolePushTargets.add('master');
      rolePushTargets.add('admin');
    }
  }

  if (rolePushTargets.size > 0) {
    try {
      const clientLabel = context?.clientName ? `${context.clientName}. ` : '';
      await sendPushToRoleDevices({
        roles: Array.from(rolePushTargets),
        title: `${formatOrderDisplayLabel(input.orderId)}: ${input.title}`,
        body: `${clientLabel}${input.message || 'Requiere revision en el dashboard.'}`,
        url: '/app/master/dashboard',
        tag: `master-order-${input.orderId}-${input.eventType}`,
        tone: input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info',
        requireInteraction: input.severity === 'critical',
      });
    } catch (pushError) {
      console.warn(
        'notification center role push skipped',
        pushError instanceof Error ? pushError.message : 'unknown push error',
      );
    }
  }

  return {
    eventId: Number(insertedEvent.id),
    context,
  };
}
