'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { requireAuthContext } from '@/lib/auth';

type ReplaceAdvisorOrderItemInput = {
  productId: number;
  qty: number;
  sourcePriceCurrency: 'VES' | 'USD';
  sourcePriceAmount: number;
  unitPriceUsdSnapshot: number;
  lineTotalUsd: number;
  unitPriceBsSnapshot: number;
  lineTotalBsSnapshot: number;
  skuSnapshot: string | null;
  productNameSnapshot: string;
  editableDetailLines: string[];
};

type AdvisorOrderHeaderInput = {
  orderId: number;
  payload: {
    client_id: number;
    attributed_advisor_id: string;
    source: string;
    status: string;
    fulfillment: 'pickup' | 'delivery';
    total_usd: number;
    total_bs_snapshot: number;
    is_price_locked: boolean;
    delivery_address: string | null;
    receiver_name: string | null;
    receiver_phone: string | null;
    notes: string | null;
    extra_fields: Record<string, unknown>;
  };
};

function createSupabaseServiceRoleServer() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Falta configurar SUPABASE_SERVICE_ROLE_KEY para guardar items de orden.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function assertAdvisorCanEditOrderStatus(status: unknown) {
  if (!['created', 'queued'].includes(String(status || ''))) {
    throw new Error('El asesor solo puede modificar una orden antes de entrar a cocina.');
  }
}

export async function updateAdvisorOrderHeaderAction(input: AdvisorOrderHeaderInput) {
  const ctx = await requireAuthContext();
  const orderId = Number(input.orderId);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const payload = input.payload;
  if (!payload || Number(payload.client_id) <= 0) {
    throw new Error('Falta el cliente de la orden.');
  }

  if (payload.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes modificar esta orden.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, attributed_advisor_id, status')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes modificar esta orden.');
  }

  assertAdvisorCanEditOrderStatus(order.status);

  const adminSupabase = createSupabaseServiceRoleServer();
  const { error: updateError } = await adminSupabase
    .from('orders')
    .update({
      ...payload,
      delivery_address: payload.fulfillment === 'delivery' ? payload.delivery_address : null,
      extra_fields: payload.extra_fields,
    })
    .eq('id', orderId)
    .eq('attributed_advisor_id', ctx.user.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/master/dashboard');
}

export async function replaceAdvisorOrderItemsAction(input: {
  orderId: number;
  items: ReplaceAdvisorOrderItemInput[];
}) {
  const ctx = await requireAuthContext();
  const orderId = Number(input.orderId);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un item.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, attributed_advisor_id, status')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes modificar esta orden.');
  }

  assertAdvisorCanEditOrderStatus(order.status);

  const itemsPayload = input.items.map((item) => ({
    order_id: orderId,
    product_id: Number(item.productId),
    qty: toFiniteNumber(item.qty),
    pricing_origin_currency: item.sourcePriceCurrency === 'VES' ? 'VES' : 'USD',
    pricing_origin_amount: toFiniteNumber(item.sourcePriceAmount),
    unit_price_usd_snapshot: toFiniteNumber(item.unitPriceUsdSnapshot),
    line_total_usd: toFiniteNumber(item.lineTotalUsd),
    unit_price_bs_snapshot: toFiniteNumber(item.unitPriceBsSnapshot),
    line_total_bs_snapshot: toFiniteNumber(item.lineTotalBsSnapshot),
    sku_snapshot: item.skuSnapshot || null,
    product_name_snapshot: String(item.productNameSnapshot || '').trim() || 'Item',
    notes:
      Array.isArray(item.editableDetailLines) && item.editableDetailLines.length > 0
        ? item.editableDetailLines.map((line) => String(line || '').trim()).filter(Boolean).join('\n') || null
        : null,
  }));

  const adminSupabase = createSupabaseServiceRoleServer();

  const { data: existingItems, error: existingItemsError } = await adminSupabase
    .from('order_items')
    .select('id')
    .eq('order_id', orderId);

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const { error: insertItemsError } = await adminSupabase
    .from('order_items')
    .insert(itemsPayload);

  if (insertItemsError) {
    throw new Error(insertItemsError.message);
  }

  const oldItemIds = (existingItems ?? [])
    .map((item) => Number(item.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (oldItemIds.length > 0) {
    const { error: deleteItemsError } = await adminSupabase
      .from('order_items')
      .delete()
      .in('id', oldItemIds);

    if (deleteItemsError) {
      throw new Error(deleteItemsError.message);
    }
  }

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/master/dashboard');
}
