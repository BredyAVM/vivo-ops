import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { PageIntro } from '../advisor-ui';
import AdvisorInboxClient from './AdvisorInboxClient';
import {
  type InboxEvent,
  type RawTimelineEvent,
  ACTION_EVENT_TYPES,
  INCLUDED_EVENT_TYPES,
  buildDetailLines,
  dedupeEvents,
  eventTitle,
  eventTone,
  getFilterForEvent,
  normalizeEventType,
  normalizeFilter,
  safeText,
  shortMessage,
} from './inbox-shared';

type SearchParams = Promise<{
  filter?: string;
}>;

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

function getClientName(order: OrderRow) {
  const client = Array.isArray(order.client) ? order.client[0] ?? null : order.client;
  return safeText(client?.full_name, 'Cliente sin nombre');
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function getDeliveryLabel(order: OrderRow) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  const date = safeText(schedule?.date, '');
  const time = safeText(schedule?.time_12, '');
  const combined = `${date} ${time}`.trim();
  return combined || formatEventTime(order.created_at);
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

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Seguimiento"
        title="Inbox del asesor"
        description="Eventos operativos y alertas reales de tus ordenes, listos para revisar desde el telefono."
        action={
          <Link
            href="/app/advisor"
            className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
          >
            Volver
          </Link>
        }
      />

      <AdvisorInboxClient userId={ctx.user.id} activeFilter={activeFilter} events={inboxEvents} />
    </div>
  );
}
