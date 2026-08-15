import { getAuthContext } from '@/lib/auth';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { PageIntro } from '../advisor-ui';
import AdvisorInboxClient from './AdvisorInboxClient';
import {
  type InboxEvent,
  type InboxRecipientCountRow,
  type RawTimelineEvent,
  ACTION_EVENT_TYPES,
  ADVISOR_TIMELINE_RECIPIENT_SELECT,
  buildDetailLines,
  buildLatestOrderActionState,
  coalesceInboxEvents,
  eventTitle,
  eventTone,
  getFilterForEvent,
  getOrderNotificationEventType,
  normalizeFilter,
  safeText,
  shouldRequireAdvisorAction,
  shortMessage,
} from './inbox-shared';

type SearchParams = Promise<{
  filter?: string;
}>;

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
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
  id: number | string;
  event_id: number | string;
  requires_action: boolean | null;
  created_at: string;
  read_at: string | null;
  event: RawTimelineEvent[] | RawTimelineEvent | null;
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

  const { data: recipientsData } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .select(ADVISOR_TIMELINE_RECIPIENT_SELECT)
    .eq('target_user_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(500);

  const recipients = (recipientsData ?? []) as unknown as TimelineRecipientRow[];
  const notificationOrderIds = Array.from(
    new Set(
      recipients
        .map((recipient) => {
          const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
          return Number(event?.order_id || 0);
        })
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const { data: ordersData } = notificationOrderIds.length > 0
    ? await ctx.supabase
        .from('orders')
        .select(
          'id, order_number, status, created_at, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
        )
        .eq('attributed_advisor_id', ctx.user.id)
        .in('id', notificationOrderIds)
        .limit(200)
    : { data: [] };

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const actionState = buildLatestOrderActionState(recipients as InboxRecipientCountRow[]);

  const inboxEvents: InboxEvent[] = coalesceInboxEvents(recipients
    .map((recipient) => {
      const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
      if (!event) return null;

      const eventType = getOrderNotificationEventType({
        id: event.id ?? recipient.event_id,
        order_id: event.order_id,
        type: event.event_type,
        status: null,
        meta: event.payload,
        created_at: event.created_at,
        read_at: recipient.read_at,
      });
      const orderId = Number(event.order_id || 0);
      const order = orderById.get(orderId);
      if (!order) return null;

      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload
          : {};
      const detailLines = buildDetailLines(eventType, {
        ...payload,
        order_created_at: payload.order_created_at ?? order.created_at,
      });
      const requiresAction = shouldRequireAdvisorAction(
        eventType,
        recipient.requires_action ?? ACTION_EVENT_TYPES.has(eventType),
        order.status,
        orderId,
        actionState
      );

      return {
        id: `timeline-${event.id ?? recipient.event_id}`,
        recipientId: Number(recipient.id),
        orderId,
        orderNumber: `Orden ${formatOrderDisplayNumber(orderId)}`,
        clientName: getClientName(order),
        deliveryLabel: getDeliveryLabel(order),
        title: eventTitle(eventType, safeText(event.title, 'Evento')),
        message: shortMessage(eventType, event.message, detailLines),
        eventType,
        createdAt: String(event.created_at || recipient.created_at || order.created_at),
        detailLines,
        requiresAction,
        readAt: recipient.read_at,
        tone: eventTone(eventType),
      } satisfies InboxEvent;
    })
    .filter((event): event is InboxEvent => !!event)
    .filter((event) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'updates') return !event.requiresAction;
      if (activeFilter === 'pending') return event.requiresAction;
      return getFilterForEvent(event.eventType) === activeFilter;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  const intro = activeFilter === 'pending'
    ? {
        eyebrow: 'Acciones',
        title: 'Acciones pendientes',
        description: 'Solo llamadas de atencion que requieren respuesta del asesor.',
      }
    : activeFilter === 'updates' || activeFilter === 'kitchen' || activeFilter === 'delivery' || activeFilter === 'payments'
      ? {
          eyebrow: 'Seguimiento',
          title: 'Seguimiento de pedidos',
          description: 'Movimiento operativo de tus ordenes, separado de las acciones pendientes.',
        }
      : {
          eyebrow: 'Inbox',
          title: 'Inbox del asesor',
          description: 'Acciones importantes separadas del seguimiento operativo de tus ordenes.',
        };

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow={intro.eyebrow}
        title={intro.title}
        description={intro.description}
      />

      <AdvisorInboxClient activeFilter={activeFilter} initialEvents={inboxEvents} />
    </div>
  );
}
