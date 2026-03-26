import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import MasterEditOrderClient from './MasterEditOrderClient';

type PageProps = {
  params: Promise<{ id: string }>;
};

function toNum(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractUnitsPerService(name: string, extraFields: any) {
  const explicit =
    extraFields?.unitsPerService ??
    extraFields?.units_per_service ??
    extraFields?.service_units;

  if (explicit != null) {
    const n = Number(explicit);
    if (Number.isFinite(n)) return n;
  }

  const m = String(name || '').match(/\((\d+)\s*UND\)/i);
  if (!m) return 0;

  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function buildInitialDeliveryDate(extraFields: any, createdAt: string) {
  return extraFields?.schedule?.date || new Date(createdAt).toISOString().slice(0, 10);
}

function buildInitialDeliveryTime(extraFields: any) {
  return extraFields?.schedule?.time_24 || '12:00';
}

export default async function MasterEditOrderPage({ params }: PageProps) {
  const { id } = await params;
  const orderId = Number(id);

  if (!Number.isFinite(orderId)) {
    redirect('/app/master/dashboard');
  }

  const supabase = await createSupabaseServer();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect('/login');
  }

  const { data: rolesData, error: rolesError } = await supabase.rpc('get_my_roles');

  if (rolesError) {
    throw new Error(rolesError.message);
  }

  const roles: string[] = Array.isArray(rolesData)
    ? rolesData
    : rolesData
      ? [rolesData]
      : [];

  if (!roles.includes('master') && !roles.includes('admin')) {
    redirect('/app');
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      client_id,
      fulfillment,
      delivery_address,
      receiver_name,
      receiver_phone,
      status,
      notes,
      created_at,
      extra_fields,
      client:clients!orders_client_id_fkey (
        id,
        full_name,
        phone
      ),
      advisor:profiles!orders_attributed_advisor_id_fkey (
        id,
        full_name
      )
    `)
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    redirect('/app/master/dashboard');
  }

  const { data: orderItems, error: orderItemsError } = await supabase
    .from('order_items')
    .select(`
      id,
      order_id,
      product_id,
      qty,
      unit_price_usd_snapshot,
      line_total_usd,
      product_name_snapshot,
      sku_snapshot,
      notes
    `)
    .eq('order_id', orderId)
    .order('id', { ascending: true });

  if (orderItemsError) {
    throw new Error(orderItemsError.message);
  }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, base_price_usd, is_active, extra_fields')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (productsError) {
    throw new Error(productsError.message);
  }

  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('id, full_name, phone')
    .order('full_name', { ascending: true })
    .limit(250);

  if (clientsError) {
    throw new Error(clientsError.message);
  }

  const fxRate =
    Number(order.extra_fields?.pricing?.fx_rate) > 0
      ? Number(order.extra_fields?.pricing?.fx_rate)
      : 100;

  const discountEnabled = !!order.extra_fields?.pricing?.discount_enabled;
  const discountPct = Number(order.extra_fields?.pricing?.discount_pct ?? 0) || 0;

  const deliveryProductIds = new Set(
    (orderItems ?? [])
      .filter((item) =>
        String(item.product_name_snapshot || '').toLowerCase().includes('delivery')
      )
      .map((item) => Number(item.product_id))
  );

  const productOptions = (products ?? [])
    .filter((p) => !deliveryProductIds.has(Number(p.id)))
    .map((p) => ({
      id: Number(p.id),
      name: p.name,
      sku: p.sku ?? '',
      unitsPerService: extractUnitsPerService(p.name, p.extra_fields),
      priceUsd: toNum(p.base_price_usd, 0),
      priceBs: Math.round(toNum(p.base_price_usd, 0) * fxRate),
      detailEditable: String(p.name || '').toLowerCase().includes('combo'),
      kind: 'service' as const,
    }));

  const existingCart = (orderItems ?? [])
    .filter((item) => !String(item.product_name_snapshot || '').toLowerCase().includes('delivery'))
    .map((item) => ({
      productId: Number(item.product_id),
      qty: toNum(item.qty, 0),
      detailText: item.notes ?? '',
    }));

  const selectedClient =
    order.client
      ? {
          id: String(order.client.id),
          full_name: order.client.full_name ?? 'Cliente',
          phone: order.client.phone ?? '',
        }
      : null;

    return (
    <MasterEditOrderClient
      orderId={orderId}
      orderNumber={order.order_number}
      status={order.status}
      advisorName={order.advisor?.full_name ?? 'Asesor'}
      clients={(clients ?? []).map((c) => ({
        id: String(c.id),
        full_name: c.full_name,
        phone: c.phone ?? '',
      }))}
      selectedClient={selectedClient}
      products={productOptions}
      initialCart={existingCart}
      initialFulfillment={order.fulfillment}
      initialDeliveryWhenMode={
        order.extra_fields?.schedule?.when_mode === 'today' ? 'today' : 'schedule'
      }
      initialDeliveryDate={buildInitialDeliveryDate(order.extra_fields, order.created_at)}
      originalDeliveryDate={buildInitialDeliveryDate(order.extra_fields, order.created_at)}
      initialDeliveryTime={buildInitialDeliveryTime(order.extra_fields)}
      initialDeliveryAddress={order.delivery_address ?? order.extra_fields?.delivery?.address ?? ''}
      initialReceiverName={
        order.receiver_name ??
        order.extra_fields?.receiver?.name ??
        order.client?.full_name ??
        ''
      }
      initialReceiverPhone={
        order.receiver_phone ??
        order.extra_fields?.receiver?.phone ??
        order.client?.phone ??
        ''
      }
      initialPaymentMethod={order.extra_fields?.payment?.method ?? 'Pago móvil'}
      initialFxRate={fxRate}
      initialDiscountEnabled={discountEnabled}
      initialDiscountPct={discountPct}
      initialNotes={order.notes ?? ''}
    />
  );
}