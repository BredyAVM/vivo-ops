import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { PageIntro } from '../advisor-ui';
import AdvisorInboxClient from './AdvisorInboxClient';
import {
  type InboxEvent,
  ACTION_EVENT_TYPES,
  buildDetailLines,
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

type NotificationRow = {
  id: number;
  order_id: number | null;
  type: string;
  status: string;
  title: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
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

  const { data: notificationsData } = await ctx.supabase
    .from('notifications')
    .select('id, order_id, type, status, title, body, meta, created_at, read_at')
    .eq('recipient_user_id', ctx.user.id)
    .not('order_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);

  const notifications = (notificationsData ?? []) as NotificationRow[];
  const notificationOrderIds = Array.from(
    new Set(
      notifications
        .map((notification) => Number(notification.order_id || 0))
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

  const inboxEvents: InboxEvent[] = coalesceInboxEvents(notifications
    .map((notification) => {
      const eventType = getOrderNotificationEventType(notification);
      const orderId = Number(notification.order_id || 0);
      const order = orderById.get(orderId);
      if (!order) return null;

      const payload =
        notification.meta && typeof notification.meta === 'object' && !Array.isArray(notification.meta)
          ? (notification.meta as Record<string, unknown>)
          : {};
      const detailLines = buildDetailLines(eventType, {
        ...payload,
        order_created_at: payload.order_created_at ?? order.created_at,
      });
      const requiresAction = shouldRequireAdvisorAction(
        eventType,
        ACTION_EVENT_TYPES.has(eventType),
        order.status,
        orderId
      );

      return {
        id: `notification-${notification.id}`,
        recipientId: Number(notification.id),
        orderId,
        orderNumber: `Orden ${formatOrderDisplayNumber(orderId)}`,
        clientName: getClientName(order),
        deliveryLabel: getDeliveryLabel(order),
        title: eventTitle(eventType, notification.title),
        message: shortMessage(eventType, notification.body, detailLines),
        eventType,
        createdAt: String(notification.created_at || order.created_at),
        detailLines,
        requiresAction,
        readAt: notification.read_at ?? (notification.status === 'read' ? notification.created_at : null),
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
