import { redirect } from 'next/navigation';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import KitchenClient, { type KitchenOrder, type KitchenOrderItem } from './KitchenClient';

type RawKitchenOrder = {
  id: number;
  order_number: string | null;
  status: 'confirmed' | 'in_kitchen' | 'ready';
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
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

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  const { data: ordersData, error: ordersError } = await ctx.supabase
    .from('orders')
    .select(
      [
        'id',
        'order_number',
        'status',
        'fulfillment',
        'delivery_address',
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
    .limit(120);

  if (ordersError) {
    throw new Error(ordersError.message);
  }

  const rawOrders = (ordersData ?? []) as unknown as RawKitchenOrder[];
  const orderIds = rawOrders.map((order) => order.id);

  const { data: itemsData, error: itemsError } = orderIds.length
    ? await ctx.supabase
        .from('order_items')
        .select('id, order_id, qty, product_name_snapshot, notes')
        .in('order_id', orderIds)
        .order('id', { ascending: true })
    : { data: [], error: null };

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  const itemsByOrder = new Map<number, KitchenOrderItem[]>();
  for (const item of (itemsData ?? []) as unknown as RawKitchenItem[]) {
    const orderItems = itemsByOrder.get(item.order_id) ?? [];
    orderItems.push({
      id: item.id,
      qty: toSafeNumber(item.qty, 0),
      name: item.product_name_snapshot || 'Producto',
      notes: item.notes,
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

  return (
    <KitchenClient
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Cocina'
      }
      orders={orders}
    />
  );
}
