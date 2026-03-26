'use server';

import { createSupabaseServer } from '@/lib/supabase/server';

type SaveOrderEditInput = {
  orderId: number;
  clientId: number | null;
  fulfillment: 'pickup' | 'delivery';
  deliveryWhenMode: 'today' | 'schedule';
  deliveryDate: string;
  deliveryTime: string;
  deliveryAddress: string;
  receiverName: string;
  receiverPhone: string;
  paymentMethod: string;
  fxRate: number;
  discountEnabled: boolean;
  discountPct: number;
  notes: string;
  items: Array<{
    productId: number;
    qty: number;
    detailText?: string;
  }>;
};

function toNum(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function time24To12(time24: string) {
  const [hhRaw, mmRaw] = String(time24 || '00:00').split(':');
  const hh = Number(hhRaw || 0);
  const mm = Number(mmRaw || 0);

  const d = new Date();
  d.setHours(hh, mm, 0, 0);

  return d
    .toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .toUpperCase();
}

function buildSummary(input: SaveOrderEditInput) {
  const parts: string[] = [];

  parts.push(`items=${input.items.length}`);
  parts.push(`fulfillment=${input.fulfillment}`);
  parts.push(`schedule=${input.deliveryDate} ${input.deliveryTime}`);

  if (input.discountEnabled) parts.push(`discount=${input.discountPct}%`);
  if (input.paymentMethod) parts.push(`payment=${input.paymentMethod}`);

  return `Pedido modificado por master/admin: ${parts.join(' | ')}`;
}

export async function saveMasterOrderEditAction(input: SaveOrderEditInput) {
  const supabase = await createSupabaseServer();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('No autenticado.');
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
    throw new Error('No autorizado.');
  }

  if (!input.orderId || input.items.length === 0) {
    throw new Error('Datos incompletos para guardar.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, extra_fields, notes')
    .eq('id', input.orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (!['created', 'queued'].includes(currentOrder.status)) {
    throw new Error('Solo se pueden modificar órdenes en created o queued.');
  }

  const { data: existingItems, error: existingItemsError } = await supabase
    .from('order_items')
    .select(`
      id,
      product_id,
      qty,
      unit_price_usd_snapshot,
      line_total_usd,
      product_name_snapshot,
      sku_snapshot,
      notes
    `)
    .eq('order_id', input.orderId);

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const deliveryItemsToPreserve =
    input.fulfillment === 'delivery'
      ? (existingItems ?? []).filter((item) =>
          String(item.product_name_snapshot || '').toLowerCase().includes('delivery')
        )
      : [];

  const requestedProductIds = Array.from(new Set(input.items.map((x) => x.productId)));

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, base_price_usd')
    .in('id', requestedProductIds);

  if (productsError) {
    throw new Error(productsError.message);
  }

  const productsMap = new Map((products ?? []).map((p) => [Number(p.id), p]));

  for (const line of input.items) {
    if (!productsMap.has(Number(line.productId))) {
      throw new Error(`Producto inválido: ${line.productId}`);
    }
  }

  const prevExtraFields = (currentOrder.extra_fields ?? {}) as Record<string, any>;

  const nextExtraFields = {
    ...prevExtraFields,
    delivery: {
      ...(prevExtraFields.delivery ?? {}),
      address: input.fulfillment === 'delivery' ? input.deliveryAddress || null : null,
    },
    receiver: {
      ...(prevExtraFields.receiver ?? {}),
      name: input.receiverName || null,
      phone: input.receiverPhone || null,
    },
    schedule: {
      ...(prevExtraFields.schedule ?? {}),
      date: input.deliveryDate,
      time_24: input.deliveryTime,
      time_12: time24To12(input.deliveryTime),
      when_mode: input.deliveryWhenMode,
    },
    payment: {
      ...(prevExtraFields.payment ?? {}),
      method: input.paymentMethod || null,
    },
    pricing: {
      ...(prevExtraFields.pricing ?? {}),
      fx_rate: input.fxRate,
      discount_enabled: input.discountEnabled,
      discount_pct: input.discountEnabled ? input.discountPct : 0,
    },
  };

  const updatePayload: Record<string, any> = {
    client_id: input.clientId,
    fulfillment: input.fulfillment,
    delivery_address: input.fulfillment === 'delivery' ? input.deliveryAddress || null : null,
    receiver_name: input.receiverName || null,
    receiver_phone: input.receiverPhone || null,
    notes: input.notes || null,
    extra_fields: nextExtraFields,
    last_modified_at: new Date().toISOString(),
    last_modified_by: user.id,
  };

  if (currentOrder.status === 'queued') {
    updatePayload.queued_needs_reapproval = true;
    updatePayload.queued_last_modified_at = new Date().toISOString();
    updatePayload.queued_last_modified_by = user.id;
  }

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', input.orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { error: deleteItemsError } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', input.orderId);

  if (deleteItemsError) {
    throw new Error(deleteItemsError.message);
  }

  const rowsToInsert = input.items.map((line) => {
    const product = productsMap.get(Number(line.productId));
    const qty = toNum(line.qty, 0);
    const unitPrice = toNum(product?.base_price_usd, 0);

    return {
      order_id: input.orderId,
      product_id: Number(line.productId),
      qty,
      unit_price_usd_snapshot: unitPrice,
      line_total_usd: qty * unitPrice,
      product_name_snapshot: product?.name ?? 'Producto',
      sku_snapshot: product?.sku ?? null,
      notes: line.detailText?.trim() || null,
    };
  });

  for (const preserved of deliveryItemsToPreserve) {
    rowsToInsert.push({
      order_id: input.orderId,
      product_id: Number(preserved.product_id),
      qty: toNum(preserved.qty, 0),
      unit_price_usd_snapshot: toNum(preserved.unit_price_usd_snapshot, 0),
      line_total_usd: toNum(preserved.line_total_usd, 0),
      product_name_snapshot: preserved.product_name_snapshot,
      sku_snapshot: preserved.sku_snapshot ?? null,
      notes: preserved.notes ?? null,
    });
  }

  if (rowsToInsert.length === 0) {
    throw new Error('La orden no puede quedar sin items.');
  }

  const { error: insertItemsError } = await supabase
    .from('order_items')
    .insert(rowsToInsert);

  if (insertItemsError) {
    throw new Error(insertItemsError.message);
  }

  const { error: recalcError } = await supabase.rpc('recalc_order_total_usd', {
    p_order_id: input.orderId,
  });

  if (recalcError) {
    throw new Error(recalcError.message);
  }

  const { error: markModifiedError } = await supabase.rpc('mark_order_modified', {
    p_order_id: input.orderId,
    p_summary: buildSummary(input),
  });

  if (markModifiedError) {
    throw new Error(markModifiedError.message);
  }

  return { ok: true };
}