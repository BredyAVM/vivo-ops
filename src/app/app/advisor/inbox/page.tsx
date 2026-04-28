import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type SearchParams = Promise<{
  filter?: string;
}>;

type InboxFilter = 'pending' | 'kitchen' | 'delivery' | 'payments' | 'all';

type OrderRow = {
  id: number;
  order_number: string;
  created_at: string;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      asap?: boolean | null;
    } | null;
  } | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type RawTimelineEvent = {
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

type InboxEvent = {
  id: string;
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
  tone: 'neutral' | 'warning' | 'success' | 'danger';
};

const FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: 'pending', label: 'Pendientes' },
  { key: 'kitchen', label: 'Cocina' },
  { key: 'delivery', label: 'Entrega' },
  { key: 'payments', label: 'Pagos' },
  { key: 'all', label: 'Todo' },
];

const INCLUDED_EVENT_TYPES = new Set([
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

const ACTION_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'payment_rejected',
]);

function normalizeFilter(value: string | undefined): InboxFilter {
  if (value === 'pending' || value === 'kitchen' || value === 'delivery' || value === 'payments' || value === 'all') {
    return value;
  }
  return 'pending';
}

function safeText(value: unknown, fallback = 'Sin dato') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function getClientName(order: OrderRow) {
  const client = Array.isArray(order.client) ? order.client[0] ?? null : order.client;
  return safeText(client?.full_name, 'Cliente sin nombre');
}

function getDeliveryLabel(order: OrderRow) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  const date = safeText(schedule?.date, '');
  const time = safeText(schedule?.time_12, '');
  const combined = `${date} ${time}`.trim();
  return combined || formatEventTime(order.created_at);
}

function getFilterForEvent(eventType: string): InboxFilter {
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

function normalizeEventType(event: RawTimelineEvent) {
  return safeText(event.event_type ?? event.event, '');
}

function buildEventDedupKey(event: RawTimelineEvent) {
  return [
    Number(event.order_id || 0),
    normalizeEventType(event),
    safeText(event.created_at, ''),
    safeText(event.title, ''),
    safeText(event.message, ''),
  ].join('|');
}

function dedupeEvents(events: RawTimelineEvent[]) {
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

function eventTitle(eventType: string, fallbackTitle: string) {
  if (eventType === 'kitchen_taken') return 'Cocina tomó la orden';

  const titles: Record<string, string> = {
    order_approved: 'Orden aprobada',
    order_returned_to_review: 'Orden devuelta',
    order_reapproved: 'Orden re-aprobada',
    order_changes_rejected: 'Cambios rechazados',
    order_changes_approved: 'Cambios aprobados',
    order_sent_to_kitchen: 'Enviada a cocina',
    kitchen_taken: 'Cocina tomó la orden',
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

function eventTone(eventType: string): InboxEvent['tone'] {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected') return 'danger';
  if (ACTION_EVENT_TYPES.has(eventType) || eventType.includes('delayed')) return 'warning';
  if (eventType === 'payment_confirmed' || eventType === 'order_delivered' || eventType === 'pickup_collected') return 'success';
  return 'neutral';
}

function buildDetailLines(eventType: string, payload: Record<string, unknown>) {
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

function shortMessage(rawMessage: string | null, details: string[]) {
  const message = safeText(rawMessage, '');
  if (message) return message;
  return details[0] || 'Sin detalle adicional.';
}

export default async function AdvisorInboxPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const activeFilter = normalizeFilter(params.filter);
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data: ordersData } = await ctx.supabase
    .from('orders')
    .select(
      'id, order_number, created_at, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
    )
    .eq('attributed_advisor_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(120);

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));

  const orderIds = orders.map((order) => order.id);
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const [timelineResult, legacyResult] = await Promise.all([
    ctx.supabase
      .from('order_timeline_events')
      .select('id, order_id, event_type, event_group, title, message, severity, actor_user_id, payload, created_at')
      .in('order_id', orderIds.length > 0 ? orderIds : [-1])
      .order('created_at', { ascending: false }),
    ctx.supabase
      .from('order_events')
      .select('id, order_id, order_number, event_type, event_group, title, message, severity, actor_user_id, payload, created_at, event, performed_by, meta')
      .in('order_id', orderIds.length > 0 ? orderIds : [-1])
      .order('created_at', { ascending: false }),
  ]);

  const rawEvents = dedupeEvents([
    ...((timelineResult.data ?? []) as RawTimelineEvent[]),
    ...((legacyResult.data ?? []) as RawTimelineEvent[]),
  ]);

  const inboxEvents: InboxEvent[] = rawEvents
    .map((event) => {
      const orderId = Number(event.order_id || 0);
      const order = orderById.get(orderId);
      if (!order) return null;

      const eventType = normalizeEventType(event);
      if (!INCLUDED_EVENT_TYPES.has(eventType)) return null;

      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : event.meta && typeof event.meta === 'object' && !Array.isArray(event.meta)
            ? (event.meta as Record<string, unknown>)
            : {};
      const detailLines = buildDetailLines(eventType, payload);

      return {
        id: `${eventType}-${String(event.id ?? '')}`,
        orderId,
        orderNumber: safeText(order.order_number, `Orden ${orderId}`),
        clientName: getClientName(order),
        deliveryLabel: getDeliveryLabel(order),
        title: eventTitle(eventType, String(event.title || '')),
        message: shortMessage(event.message, detailLines),
        eventType,
        createdAt: String(event.created_at || order.created_at),
        detailLines,
        requiresAction: ACTION_EVENT_TYPES.has(eventType),
        tone: eventTone(eventType),
      } satisfies InboxEvent;
    })
    .filter((event): event is InboxEvent => !!event)
    .filter((event) => {
      if (activeFilter === 'all') return true;
      return getFilterForEvent(event.eventType) === activeFilter;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const pendingCount = rawEvents.filter((event) =>
    ACTION_EVENT_TYPES.has(normalizeEventType(event))
  ).length;

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Seguimiento"
        title="Inbox del asesor"
        description="Eventos operativos y alertas reales de tus ordenes, listos para revisar desde el telefono."
        action={
          <Link href="/app/advisor" className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Volver
          </Link>
        }
      />

      <section className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {FILTERS.map((filter) => (
            <Link
              key={filter.key}
              href={`/app/advisor/inbox?filter=${filter.key}`}
              className={[
                'rounded-[16px] border px-3 py-2 text-sm font-medium',
                activeFilter === filter.key
                  ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                  : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
              ].join(' ')}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </section>

      <SectionCard
        title="Bandeja"
        subtitle={activeFilter === 'pending' ? 'Eventos que requieren accion del asesor.' : 'Eventos recientes para seguimiento operativo.'}
        action={pendingCount > 0 ? <StatusBadge label={`${pendingCount} por atender`} tone="warning" /> : null}
      >
        {inboxEvents.length === 0 ? (
          <EmptyBlock title="Sin eventos para este filtro" detail="Cuando entren eventos de orden, apareceran aqui con prioridad y contexto." />
        ) : (
          <div className="space-y-2.5">
            {inboxEvents.map((event) => (
                <Link key={event.id} href={`/app/advisor/orders/${event.orderId}`} className="block rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{event.clientName}</div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{event.orderNumber}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <StatusBadge label={event.title} tone={event.tone} />
                    {event.requiresAction ? <StatusBadge label="Requiere accion" tone="warning" /> : null}
                  </div>
                </div>

                <div className="mt-3 grid gap-1.5 text-xs leading-5 text-[#AAB2C5]">
                  <div>Entrega: {event.deliveryLabel}</div>
                  <div>{event.message}</div>
                  {event.detailLines.map((line) => (
                    <div key={`${event.id}-${line}`}>{line}</div>
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                  <span>{formatEventTime(event.createdAt)}</span>
                  <span className="font-medium text-[#F0D000]">Abrir pedido</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
