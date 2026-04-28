import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { PageIntro } from '../advisor-ui';
import AdvisorInboxClient from './AdvisorInboxClient';
import AdvisorPushPanel from './AdvisorPushPanel';
import {
  type InboxEvent,
  ACTION_EVENT_TYPES,
  INCLUDED_EVENT_TYPES,
  buildDetailLines,
  eventTitle,
  eventTone,
  getFilterForEvent,
  normalizeFilter,
  safeText,
  shortMessage,
} from './inbox-shared';
import { getPublicVapidKey } from '@/lib/push';

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

type TimelineRecipientRow = {
  id: number;
  requires_action: boolean;
  read_at: string | null;
  event:
    | {
        id: number | string | null;
        order_id: number | string | null;
        order_number: string | null;
        event_type: string | null;
        title: string | null;
        message: string | null;
        payload: Record<string, unknown> | null;
        created_at: string | null;
      }[]
    | {
        id: number | string | null;
        order_id: number | string | null;
        order_number: string | null;
        event_type: string | null;
        title: string | null;
        message: string | null;
        payload: Record<string, unknown> | null;
        created_at: string | null;
      }
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
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const { data: recipientsData } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .select(
      'id, requires_action, read_at, event:order_timeline_events!inner(id, order_id, order_number, event_type, title, message, payload, created_at)'
    )
    .or(`target_user_id.eq.${ctx.user.id},target_role.eq.advisor`)
    .limit(200);

  const inboxEvents: InboxEvent[] = ((recipientsData ?? []) as TimelineRecipientRow[])
    .map((recipient) => {
      const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
      if (!event) return null;

      const eventType = safeText(event.event_type, '');
      if (!INCLUDED_EVENT_TYPES.has(eventType)) return null;

      const orderId = Number(event.order_id || 0);
      const order = orderById.get(orderId);
      if (!order) return null;

      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const detailLines = buildDetailLines(eventType, payload);

      return {
        id: `recipient-${recipient.id}`,
        recipientId: Number(recipient.id),
        orderId,
        orderNumber: safeText(event.order_number || order.order_number, `Orden ${orderId}`),
        clientName: getClientName(order),
        deliveryLabel: getDeliveryLabel(order),
        title: eventTitle(eventType, String(event.title || '')),
        message: shortMessage(event.message, detailLines),
        eventType,
        createdAt: String(event.created_at || order.created_at),
        detailLines,
        requiresAction: Boolean(recipient.requires_action) || ACTION_EVENT_TYPES.has(eventType),
        readAt: recipient.read_at,
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

      <AdvisorPushPanel publicVapidKey={getPublicVapidKey()} />

      <AdvisorInboxClient activeFilter={activeFilter} initialEvents={inboxEvents} userId={ctx.user.id} />
    </div>
  );
}
