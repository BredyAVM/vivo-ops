import { redirect } from 'next/navigation';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { getPublicVapidKey } from '@/lib/push';
import KitchenClient, {
  type KitchenOrder,
  type KitchenOrderChangeAlert,
  type KitchenOrderItem,
} from './KitchenClient';

type RawKitchenOrder = {
  id: number;
  order_number: string | null;
  status: 'confirmed' | 'in_kitchen' | 'ready';
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
  notes: string | null;
  created_at: string;
  sent_to_kitchen_at: string | null;
  kitchen_started_at: string | null;
  ready_at: string | null;
  eta_minutes: number | string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
  } | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type RawKitchenItem = {
  id: number;
  order_id: number;
  qty: number | string;
  product_name_snapshot: string | null;
  notes: string | null;
  product:
    | { units_per_service: number | string | null }[]
    | { units_per_service: number | string | null }
    | null;
};

type RawKitchenChangeEvent = {
  id: number | string;
  order_id: number | string;
  title: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type RawKitchenChangeRecipient = {
  id: number | string;
  event_id: number | string;
};

function normalizeClient(order: RawKitchenOrder) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client;
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getScheduleTime(order: RawKitchenOrder) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  return schedule?.time_12 || schedule?.time_24 || null;
}

export default async function KitchenPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const canAccessKitchen = isMasterOrAdminRole(ctx.roles) || ctx.roles.includes('kitchen');
  if (!canAccessKitchen) {
    redirect(resolveHomePath(ctx.roles));
  }

  const [profileResult, ordersResult] = await Promise.all([
    ctx.supabase
      .from('profiles')
      .select('full_name')
      .eq('id', ctx.user.id)
      .maybeSingle(),
    ctx.supabase
      .from('orders')
      .select(
        [
          'id',
          'order_number',
          'status',
          'fulfillment',
          'delivery_address',
          'notes',
          'created_at',
          'sent_to_kitchen_at',
          'kitchen_started_at',
          'ready_at',
          'eta_minutes',
          'extra_fields',
          'client:clients(full_name, phone)',
        ].join(', ')
      )
      .in('status', ['confirmed', 'in_kitchen', 'ready'])
      .order('sent_to_kitchen_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(120),
  ]);
  const { data: profile } = profileResult;
  const { data: ordersData, error: ordersError } = ordersResult;

  if (ordersError) {
    throw new Error(ordersError.message);
  }

  const rawOrders = (ordersData ?? []) as unknown as RawKitchenOrder[];
  const orderIds = rawOrders.map((order) => order.id);

  const [itemsResult, changeEventsResult] = await Promise.all([
    orderIds.length
      ? ctx.supabase
          .from('order_items')
          .select('id, order_id, qty, product_name_snapshot, notes, product:products!order_items_product_id_fkey(units_per_service)')
          .in('order_id', orderIds)
          .order('id', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? ctx.supabase
          .from('order_timeline_events')
          .select('id, order_id, title, message, payload, created_at')
          .in('order_id', orderIds)
          .eq('event_type', 'order_modified')
          .order('created_at', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const { data: itemsData, error: itemsError } = itemsResult;
  const { data: changeEventsData, error: changeEventsError } = changeEventsResult;

  if (itemsError) {
    throw new Error(itemsError.message);
  }
  if (changeEventsError) {
    throw new Error(changeEventsError.message);
  }

  const rawChangeEvents = (changeEventsData ?? []) as unknown as RawKitchenChangeEvent[];
  const changeEventIds = rawChangeEvents
    .map((event) => Number(event.id))
    .filter((eventId) => Number.isFinite(eventId) && eventId > 0);
  const { data: changeRecipientsData, error: changeRecipientsError } = changeEventIds.length
    ? await ctx.supabase
        .from('order_timeline_event_recipients')
        .select('id, event_id')
        .in('event_id', changeEventIds)
        .eq('target_role', 'kitchen')
        .eq('requires_action', true)
        .is('read_at', null)
    : { data: [], error: null };

  if (changeRecipientsError) {
    throw new Error(changeRecipientsError.message);
  }

  const itemsByOrder = new Map<number, KitchenOrderItem[]>();
  for (const item of (itemsData ?? []) as unknown as RawKitchenItem[]) {
    const orderItems = itemsByOrder.get(item.order_id) ?? [];
    const product = Array.isArray(item.product) ? item.product[0] ?? null : item.product;
    orderItems.push({
      id: item.id,
      qty: toSafeNumber(item.qty, 0),
      name: item.product_name_snapshot || 'Producto',
      notes: item.notes,
      unitsPerService: toSafeNumber(product?.units_per_service, 0),
    });
    itemsByOrder.set(item.order_id, orderItems);
  }

  const statusOrder: Record<RawKitchenOrder['status'], number> = {
    confirmed: 0,
    in_kitchen: 1,
    ready: 2,
  };

  const orders: KitchenOrder[] = rawOrders
    .map((order) => {
      const client = normalizeClient(order);

      return {
        id: order.id,
        orderNumber: order.order_number || String(order.id),
        displayNumber: formatOrderDisplayNumber(order.id),
        status: order.status,
        clientName: client?.full_name || 'Cliente',
        clientPhone: client?.phone || null,
        fulfillment: order.fulfillment,
        deliveryAddress: order.delivery_address,
        notes: order.notes,
        createdAt: order.created_at,
        scheduledDate: order.extra_fields?.schedule?.date || null,
        scheduledTime: getScheduleTime(order),
        sentToKitchenAt: order.sent_to_kitchen_at,
        kitchenStartedAt: order.kitchen_started_at,
        readyAt: order.ready_at,
        etaMinutes: order.eta_minutes == null ? null : toSafeNumber(order.eta_minutes, 0),
        items: itemsByOrder.get(order.id) ?? [],
      };
    })
    .sort((a, b) => {
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      return `${a.scheduledDate || ''}|${a.scheduledTime || ''}|${a.createdAt}`.localeCompare(
        `${b.scheduledDate || ''}|${b.scheduledTime || ''}|${b.createdAt}`
      );
    });

  const changeEventById = new Map(
    rawChangeEvents.map((event) => [Number(event.id), event]),
  );
  const changeAlerts: KitchenOrderChangeAlert[] = (
    (changeRecipientsData ?? []) as unknown as RawKitchenChangeRecipient[]
  )
    .flatMap((recipient) => {
      const recipientId = Number(recipient.id);
      const eventId = Number(recipient.event_id);
      const event = changeEventById.get(eventId);
      const orderId = Number(event?.order_id);
      if (
        !event ||
        !Number.isFinite(recipientId) ||
        recipientId <= 0 ||
        !Number.isFinite(eventId) ||
        eventId <= 0 ||
        !Number.isFinite(orderId) ||
        orderId <= 0
      ) {
        return [];
      }

      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload
          : {};
      const changedSections = Array.isArray(payload.changed_sections)
        ? payload.changed_sections
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
        : [];

      return [{
        recipientId,
        eventId,
        orderId,
        title: event.title?.trim() || 'Orden modificada durante preparación',
        message: event.message?.trim() || 'Se realizaron cambios en la orden.',
        reason: String(payload.reason ?? '').trim() || null,
        changedSections,
        createdAt: event.created_at,
      }];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <KitchenClient
      publicVapidKey={getPublicVapidKey()}
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Cocina'
      }
      orders={orders}
      changeAlerts={changeAlerts}
    />
  );
}
