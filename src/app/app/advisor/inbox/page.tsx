import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { PageIntro } from '../advisor-ui';
import AdvisorInboxClient from './AdvisorInboxClient';
import {
  type InboxEvent,
  INCLUDED_EVENT_TYPES,
  buildLatestOrderActionState,
  buildDetailLines,
  coalesceInboxEvents,
  eventTitle,
  eventTone,
  getFilterForEvent,
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

  const { data: recipientsData } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .select(
      'id, requires_action, read_at, event:order_timeline_events!inner(id, order_id, order_number, event_type, title, message, payload, created_at)'
    )
    .or(`target_user_id.eq.${ctx.user.id},target_role.eq.advisor`)
    .order('id', { ascending: false })
    .limit(200);

  const rawRecipients = (recipientsData ?? []) as TimelineRecipientRow[];
  const recipientOrderIds = Array.from(
    new Set(
      rawRecipients
        .map((recipient) => {
          const event = Array.isArray(recipient.event) ? recipient.event[0] ?? null : recipient.event;
          return Number(event?.order_id || 0);
        })
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const { data: ordersData } = recipientOrderIds.length > 0
    ? await ctx.supabase
        .from('orders')
        .select(
          'id, order_number, status, created_at, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
        )
        .eq('attributed_advisor_id', ctx.user.id)
        .in('id', recipientOrderIds)
        .limit(200)
    : { data: [] };

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const latestActionState = buildLatestOrderActionState(rawRecipients);

  const inboxEvents: InboxEvent[] = coalesceInboxEvents(rawRecipients
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
      const requiresAction = shouldRequireAdvisorAction(
        eventType,
        recipient.requires_action,
        order.status,
        orderId,
        latestActionState
      );

      return {
        id: `recipient-${recipient.id}`,
        recipientId: Number(recipient.id),
        orderId,
        orderNumber: `Orden ${formatOrderDisplayNumber(orderId)}`,
        clientName: getClientName(order),
        deliveryLabel: getDeliveryLabel(order),
        title: eventTitle(eventType, String(event.title || '')),
        message: shortMessage(eventType, event.message, detailLines),
        eventType,
        createdAt: String(event.created_at || order.created_at),
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
        action={
          <Link
            href="/app/advisor"
            className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
          >
            Volver
          </Link>
        }
      />

      <AdvisorInboxClient activeFilter={activeFilter} initialEvents={inboxEvents} />
    </div>
  );
}
