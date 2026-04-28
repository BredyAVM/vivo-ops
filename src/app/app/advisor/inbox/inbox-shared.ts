export type InboxFilter = 'pending' | 'kitchen' | 'delivery' | 'payments' | 'all';

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

export const FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: 'pending', label: 'Pendientes' },
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
]);

export const ACTION_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'payment_rejected',
]);

export function normalizeFilter(value: string | undefined): InboxFilter {
  if (value === 'pending' || value === 'kitchen' || value === 'delivery' || value === 'payments' || value === 'all') {
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
    eventType === 'payment_rejected'
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
    order_approved: 'Orden aprobada',
    order_returned_to_review: 'Orden devuelta',
    order_reapproved: 'Orden re-aprobada',
    order_changes_rejected: 'Cambios rechazados',
    order_changes_approved: 'Cambios aprobados',
    order_sent_to_kitchen: 'Enviada a cocina',
    kitchen_taken: 'Cocina tomo la orden',
    kitchen_eta_updated: 'Tiempo estimado actualizado',
    kitchen_delayed_prep: 'Retraso en cocina',
    order_ready: 'Orden preparada',
    pickup_ready: 'Lista para retiro',
    driver_assigned: 'Motorizado asignado',
    out_for_delivery: 'En camino',
    delivery_delayed: 'Retraso en entrega',
    pickup_collected: 'Orden retirada',
    order_delivered: 'Orden entregada',
    payment_reported: 'Pago reportado',
    payment_confirmed: 'Pago confirmado',
    payment_rejected: 'Pago rechazado',
  };

  return titles[eventType] || safeText(fallbackTitle, 'Evento');
}

export function eventTone(eventType: string): InboxEvent['tone'] {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected') return 'danger';
  if (ACTION_EVENT_TYPES.has(eventType) || eventType.includes('delayed')) return 'warning';
  if (eventType === 'payment_confirmed' || eventType === 'order_delivered' || eventType === 'pickup_collected') return 'success';
  return 'neutral';
}

export function buildDetailLines(eventType: string, payload: Record<string, unknown>) {
  const details: string[] = [];
  const reason = safeText(payload.reason ?? payload.review_notes ?? payload.notes ?? payload.note, '');
  const etaMinutes = payload.eta_minutes ?? payload.etaMinutes;
  const driver = safeText(payload.driver_name ?? payload.driverName ?? payload.partner_name ?? payload.partnerName, '');

  if ((eventType === 'order_returned_to_review' || eventType === 'order_changes_rejected' || eventType === 'payment_rejected') && reason) {
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

  return details;
}

export function shortMessage(rawMessage: string | null, details: string[]) {
  const message = safeText(rawMessage, '');
  if (message) return message;
  return details[0] || 'Sin detalle adicional.';
}
