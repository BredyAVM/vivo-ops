export type InboxFilter = 'pending' | 'updates' | 'kitchen' | 'delivery' | 'payments' | 'all';

export type RawTimelineEvent = {
  id: number | string | null;
  order_id: number | string | null;
  event_type: string | null;
  event_group: string | null;
  title: string | null;
  message: string | null;
  severity: 'info' | 'warning' | 'critical' | null;
  actor_user_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string | null;
  event?: string | null;
  performed_by?: string | null;
  meta?: Record<string, unknown> | null;
};

export type InboxEvent = {
  id: string;
  recipientId: number;
  orderId: number;
  orderNumber: string;
  clientName: string;
  deliveryLabel: string;
  title: string;
  message: string;
  eventType: string;
  createdAt: string;
  detailLines: string[];
  requiresAction: boolean;
  readAt: string | null;
  tone: 'neutral' | 'warning' | 'success' | 'danger';
};

type InboxRecipientCountEvent = {
  id: number | string | null;
  order_id: number | string | null;
  event_type: string | null;
  created_at: string | null;
};

export type InboxRecipientCountRow = {
  id: number | string | null;
  requires_action?: boolean | null;
  read_at: string | null;
  event: InboxRecipientCountEvent[] | InboxRecipientCountEvent | null;
};

export const FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: 'pending', label: 'Acción' },
  { key: 'updates', label: 'Seguimiento' },
  { key: 'kitchen', label: 'Cocina' },
  { key: 'delivery', label: 'Entrega' },
  { key: 'payments', label: 'Pagos' },
  { key: 'all', label: 'Todo' },
];

export const INCLUDED_EVENT_TYPES = new Set([
  'order_approved',
  'order_returned_to_review',
  'order_reapproved',
  'order_changes_rejected',
  'order_changes_approved',
  'order_cancelled',
  'order_sent_to_kitchen',
  'kitchen_taken',
  'kitchen_eta_updated',
  'kitchen_delayed_prep',
  'order_ready',
  'pickup_ready',
  'driver_assigned',
  'out_for_delivery',
  'delivery_delayed',
  'pickup_collected',
  'order_delivered',
  'payment_reported',
  'payment_confirmed',
  'payment_rejected',
  'client_fund_application_requested',
]);

export const ACTION_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'payment_rejected',
]);

const REVIEW_STATE_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'order_changes_approved',
  'order_reapproved',
  'order_approved',
]);

const PAYMENT_STATE_EVENT_TYPES = new Set([
  'payment_rejected',
  'payment_reported',
  'payment_confirmed',
]);

export type LatestOrderActionState = {
  review: Map<number, { eventType: string; createdAt: string }>;
  payment: Map<number, { eventType: string; createdAt: string }>;
};

export function normalizeFilter(value: string | undefined): InboxFilter {
  if (value === 'pending' || value === 'updates' || value === 'kitchen' || value === 'delivery' || value === 'payments' || value === 'all') {
    return value;
  }
  return 'all';
}

export function safeText(value: unknown, fallback = 'Sin dato') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function formatEventTime(value: string) {
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

export function getFilterForEvent(eventType: string): InboxFilter {
  if (ACTION_EVENT_TYPES.has(eventType)) return 'pending';
  if (
    eventType === 'order_sent_to_kitchen' ||
    eventType === 'kitchen_taken' ||
    eventType === 'kitchen_eta_updated' ||
    eventType === 'kitchen_delayed_prep' ||
    eventType === 'order_ready' ||
    eventType === 'pickup_ready'
  ) {
    return 'kitchen';
  }
  if (
    eventType === 'driver_assigned' ||
    eventType === 'out_for_delivery' ||
    eventType === 'delivery_delayed' ||
    eventType === 'pickup_collected' ||
    eventType === 'order_delivered'
  ) {
    return 'delivery';
  }
  if (
    eventType === 'payment_reported' ||
    eventType === 'payment_confirmed' ||
    eventType === 'payment_rejected' ||
    eventType === 'client_fund_application_requested'
  ) {
    return 'payments';
  }
  return 'all';
}

export function normalizeEventType(event: RawTimelineEvent) {
  return safeText(event.event_type ?? event.event, '');
}

export function buildEventDedupKey(event: RawTimelineEvent) {
  return [
    Number(event.order_id || 0),
    normalizeEventType(event),
    safeText(event.created_at, ''),
    safeText(event.title, ''),
    safeText(event.message, ''),
  ].join('|');
}

export function dedupeEvents(events: RawTimelineEvent[]) {
  const seen = new Set<string>();

  return events.filter((event) => {
    const eventType = normalizeEventType(event);
    if (!eventType) return false;

    const dedupKey = buildEventDedupKey(event);
    if (seen.has(dedupKey)) return false;

    seen.add(dedupKey);
    return true;
  });
}

export function eventTitle(eventType: string, fallbackTitle: string) {
  const titles: Record<string, string> = {
    order_approved: 'Aprobada',
    order_returned_to_review: 'Corregir pedido',
    order_reapproved: 'Re-aprobada',
    order_changes_rejected: 'Corregir cambios',
    order_changes_approved: 'Cambios aprobados',
    order_cancelled: 'Cancelada',
    order_sent_to_kitchen: 'En cocina',
    kitchen_taken: 'Cocina tomó la orden',
    kitchen_eta_updated: 'Tiempo actualizado',
    kitchen_delayed_prep: 'Retraso en cocina',
    order_ready: 'Lista',
    pickup_ready: 'Lista para retiro',
    driver_assigned: 'Motorizado asignado',
    out_for_delivery: 'En camino',
    delivery_delayed: 'Retraso en entrega',
    pickup_collected: 'Retirada',
    order_delivered: 'Entregada',
    payment_reported: 'Pago por validar',
    payment_confirmed: 'Pago confirmado',
    payment_rejected: 'Corregir pago',
    client_fund_application_requested: 'Aplicar fondo',
  };

  return titles[eventType] || safeText(fallbackTitle, 'Evento');
}

export function eventTone(eventType: string): InboxEvent['tone'] {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected' || eventType === 'order_cancelled') return 'danger';
  if (ACTION_EVENT_TYPES.has(eventType) || eventType.includes('delayed') || eventType === 'client_fund_application_requested') return 'warning';
  if (eventType === 'payment_confirmed' || eventType === 'order_delivered' || eventType === 'pickup_collected') return 'success';
  return 'neutral';
}

export function buildDetailLines(eventType: string, payload: Record<string, unknown>) {
  const details: string[] = [];
  const reason = safeText(payload.reason ?? payload.review_notes ?? payload.notes ?? payload.note, '');
  const etaMinutes = payload.eta_minutes ?? payload.etaMinutes;
  const driver = safeText(payload.driver_name ?? payload.driverName ?? payload.partner_name ?? payload.partnerName, '');

  const isCorrectionEvent =
    eventType === 'order_returned_to_review' ||
    eventType === 'order_changes_rejected' ||
    eventType === 'payment_rejected';

  if (isCorrectionEvent && reason) {
    details.push(`Motivo: ${reason}`);
  }

  if (
    (eventType === 'kitchen_eta_updated' || eventType === 'kitchen_delayed_prep' || eventType === 'out_for_delivery' || eventType === 'delivery_delayed') &&
    etaMinutes != null &&
    String(etaMinutes).trim()
  ) {
    details.push(`ETA: ${String(etaMinutes).trim()} min`);
  }

  if ((eventType === 'driver_assigned' || eventType === 'out_for_delivery' || eventType === 'delivery_delayed') && driver) {
    details.push(`Motorizado: ${driver}`);
  }

  if (eventType === 'client_fund_application_requested') {
    const amount = Number(payload.requested_amount_usd ?? NaN);
    if (Number.isFinite(amount) && amount > 0) details.push(`Monto solicitado: $${amount.toFixed(2)}`);
    if (reason) details.push(`Nota: ${reason}`);
  }

  return details;
}

function fallbackMessageByType(eventType: string) {
  const messages: Record<string, string> = {
    order_approved: 'Ya puede avanzar.',
    order_returned_to_review: 'Requiere correccion del asesor.',
    order_reapproved: 'Ya fue aprobada de nuevo.',
    order_changes_rejected: 'Revisa los cambios rechazados.',
    order_changes_approved: 'Los cambios fueron aprobados.',
    order_cancelled: 'La orden fue cancelada.',
    order_sent_to_kitchen: 'Fue enviada a cocina.',
    kitchen_taken: 'Cocina ya la tomo.',
    kitchen_eta_updated: 'Cocina actualizo el estimado.',
    kitchen_delayed_prep: 'La preparacion va con retraso.',
    order_ready: 'Está lista para salir.',
    pickup_ready: 'Esta lista para retiro.',
    driver_assigned: 'Ya tiene motorizado.',
    out_for_delivery: 'Ya va en camino.',
    delivery_delayed: 'La entrega va con retraso.',
    pickup_collected: 'Ya fue retirada.',
    order_delivered: 'La entrega fue completada.',
    payment_reported: 'Pago pendiente por validar.',
    payment_confirmed: 'Pago validado.',
    payment_rejected: 'Debe corregirse el pago.',
    client_fund_application_requested: 'Solicitud para usar fondo.',
  };

  return messages[eventType] || 'Sin detalle adicional.';
}

export function shortMessage(eventType: string, rawMessage: string | null, details: string[]) {
  const message = safeText(rawMessage, '');
  if (message) return message;
  if (details[0]) return details[0];
  return fallbackMessageByType(eventType);
}

function getRecipientCountEvent(recipient: InboxRecipientCountRow) {
  return Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
}

function isActionNotification(eventType: string, requiresAction: boolean | null | undefined) {
  return Boolean(requiresAction) || ACTION_EVENT_TYPES.has(eventType);
}

export function isClosedOrderStatus(status: string | null | undefined) {
  return status === 'delivered' || status === 'cancelled';
}

export function isOrderReviewActionEvent(eventType: string) {
  return eventType === 'order_returned_to_review' || eventType === 'order_changes_rejected';
}

function updateLatestOrderActionState(
  state: LatestOrderActionState,
  orderId: number,
  eventType: string,
  createdAt: string
) {
  if (REVIEW_STATE_EVENT_TYPES.has(eventType)) {
    const current = state.review.get(orderId);
    if (!current || createdAt.localeCompare(current.createdAt) >= 0) {
      state.review.set(orderId, { eventType, createdAt });
    }
  }

  if (PAYMENT_STATE_EVENT_TYPES.has(eventType)) {
    const current = state.payment.get(orderId);
    if (!current || createdAt.localeCompare(current.createdAt) >= 0) {
      state.payment.set(orderId, { eventType, createdAt });
    }
  }
}

export function buildLatestOrderActionState(recipients: InboxRecipientCountRow[]) {
  const state: LatestOrderActionState = {
    review: new Map(),
    payment: new Map(),
  };

  for (const recipient of recipients) {
    const event = getRecipientCountEvent(recipient);
    const eventType = safeText(event?.event_type, '');
    const orderId = Number(event?.order_id || 0);
    if (!event || !Number.isFinite(orderId) || orderId <= 0) continue;
    updateLatestOrderActionState(state, orderId, eventType, safeText(event.created_at, ''));
  }

  return state;
}

export function isLatestAdvisorActionEvent(
  eventType: string,
  orderId: number,
  actionState: LatestOrderActionState
) {
  return !isSupersededAdvisorAction(eventType, orderId, actionState);
}

function isSupersededAdvisorAction(
  eventType: string,
  orderId: number,
  actionState?: LatestOrderActionState | null
) {
  if (!actionState) return false;

  if (isOrderReviewActionEvent(eventType)) {
    const latest = actionState.review.get(orderId);
    return Boolean(latest && latest.eventType !== eventType);
  }

  if (eventType === 'payment_rejected') {
    const latest = actionState.payment.get(orderId);
    return Boolean(latest && latest.eventType !== 'payment_rejected');
  }

  return false;
}

export function shouldRequireAdvisorAction(
  eventType: string,
  requiresAction: boolean | null | undefined,
  orderStatus?: string | null,
  orderId?: number | null,
  actionState?: LatestOrderActionState | null
) {
  if (isClosedOrderStatus(orderStatus) && isOrderReviewActionEvent(eventType)) return false;
  if (orderId && isSupersededAdvisorAction(eventType, orderId, actionState)) return false;
  return isActionNotification(eventType, requiresAction);
}

export function coalesceInboxEvents(events: InboxEvent[]) {
  const actionEvents: InboxEvent[] = [];
  const latestInfoByOrderId = new Map<number, InboxEvent>();

  for (const event of events) {
    if (event.requiresAction) {
      actionEvents.push(event);
      continue;
    }

    const current = latestInfoByOrderId.get(event.orderId);
    if (!current || String(event.createdAt).localeCompare(String(current.createdAt)) > 0) {
      latestInfoByOrderId.set(event.orderId, event);
    }
  }

  return [...actionEvents, ...latestInfoByOrderId.values()].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

export function countCoalescedUnreadNotifications(
  recipients: InboxRecipientCountRow[],
  closedOrderIds: Set<number> = new Set()
) {
  return countCoalescedUnreadNotificationsByKind(recipients, closedOrderIds).total;
}

export function countCoalescedUnreadNotificationsByKind(
  recipients: InboxRecipientCountRow[],
  closedOrderIds: Set<number> = new Set()
) {
  const counts = countCoalescedNotificationsByKind(recipients, closedOrderIds);

  return {
    actions: counts.unreadActions,
    updates: counts.unreadUpdates,
    total: counts.unreadTotal,
  };
}

export function countCoalescedNotificationsByKind(
  recipients: InboxRecipientCountRow[],
  closedOrderIds: Set<number> = new Set()
) {
  let actionCount = 0;
  let unreadActionCount = 0;
  const seenActionEventIds = new Set<string>();
  const actionState = buildLatestOrderActionState(recipients);
  const latestInfoByOrderId = new Map<
    number,
    {
      createdAt: string;
      eventId: string;
      hasUnreadRecipient: boolean;
    }
  >();

  for (const recipient of recipients) {
    const event = getRecipientCountEvent(recipient);
    const eventType = safeText(event?.event_type, '');
    if (!event || !INCLUDED_EVENT_TYPES.has(eventType)) continue;

    const orderId = Number(event.order_id || 0);
    if (!Number.isFinite(orderId) || orderId <= 0) continue;

    const eventId = safeText(event.id, `${orderId}-${eventType}-${safeText(event.created_at, '')}`);
    const createdAt = safeText(event.created_at, '');
    const isUnread = !recipient.read_at;
    const orderStatus = closedOrderIds.has(orderId) ? 'delivered' : null;

    if (shouldRequireAdvisorAction(eventType, recipient.requires_action, orderStatus, orderId, actionState)) {
      if (!seenActionEventIds.has(eventId)) {
        seenActionEventIds.add(eventId);
        actionCount += 1;
        if (isUnread) unreadActionCount += 1;
      }
      continue;
    }

    const current = latestInfoByOrderId.get(orderId);
    if (!current || createdAt.localeCompare(current.createdAt) > 0) {
      latestInfoByOrderId.set(orderId, {
        createdAt,
        eventId,
        hasUnreadRecipient: isUnread,
      });
    } else if (current.eventId === eventId && isUnread) {
      latestInfoByOrderId.set(orderId, {
        ...current,
        hasUnreadRecipient: true,
      });
    }
  }

  const updateCount = latestInfoByOrderId.size;
  const unreadInfoCount = Array.from(latestInfoByOrderId.values()).filter((event) => event.hasUnreadRecipient).length;
  return {
    actions: actionCount,
    updates: updateCount,
    total: actionCount + updateCount,
    unreadActions: unreadActionCount,
    unreadUpdates: unreadInfoCount,
    unreadTotal: unreadActionCount + unreadInfoCount,
  };
}
