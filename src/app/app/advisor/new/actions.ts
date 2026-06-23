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

type AdvisorOrderDraftStatus = 'draft' | 'quoted';

type SaveAdvisorOrderDraftInput = {
  draftId?: number | null;
  status?: AdvisorOrderDraftStatus;
  title?: string | null;
  clientId?: number | null;
  clientSnapshot?: Record<string, unknown> | null;
  newClientSnapshot?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  quoteText?: string | null;
  totalUsd?: number | null;
  totalBs?: number | null;
  fxRate?: number | null;
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

function sanitizePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeDraftStatus(value: unknown): AdvisorOrderDraftStatus {
  return value === 'quoted' ? 'quoted' : 'draft';
}

function normalizeDraftTitle(value: unknown) {
  const title = String(value || '').trim();
  return title ? title.slice(0, 140) : 'Borrador de pedido';
}

export async function saveAdvisorOrderDraftAction(input: SaveAdvisorOrderDraftInput) {
  const ctx = await requireAuthContext();
  const adminSupabase = createSupabaseServiceRoleServer();
  const draftId = Number(input.draftId || 0);
  const status = normalizeDraftStatus(input.status);
  const nowIso = new Date().toISOString();

  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('No se pudo guardar el borrador: faltan los datos del pedido.');
  }

  const draftPayload = {
    advisor_user_id: ctx.user.id,
    status,
    title: normalizeDraftTitle(input.title),
    client_id: Number(input.clientId || 0) > 0 ? Number(input.clientId) : null,
    client_snapshot: sanitizePlainObject(input.clientSnapshot),
    new_client_snapshot: sanitizePlainObject(input.newClientSnapshot),
    payload: sanitizePlainObject(input.payload),
    quote_text: input.quoteText == null ? null : String(input.quoteText),
    total_usd: toFiniteNumber(input.totalUsd),
    total_bs: toFiniteNumber(input.totalBs),
    fx_rate: input.fxRate == null || !Number.isFinite(Number(input.fxRate)) ? null : Number(input.fxRate),
    ...(status === 'quoted' ? { quoted_at: nowIso } : {}),
  };

  if (Number.isFinite(draftId) && draftId > 0) {
    const { data: existing, error: existingError } = await adminSupabase
      .from('advisor_order_drafts')
      .select('id, advisor_user_id, status')
      .eq('id', draftId)
      .maybeSingle();

    if (existingError || !existing) {
      throw new Error(existingError?.message || 'No se pudo cargar el borrador.');
    }

    if (existing.advisor_user_id !== ctx.user.id) {
      throw new Error('No puedes modificar este borrador.');
    }

    if (existing.status === 'converted' || existing.status === 'archived') {
      throw new Error('Este borrador ya fue cerrado.');
    }

    const { data, error } = await adminSupabase
      .from('advisor_order_drafts')
      .update(draftPayload)
      .eq('id', draftId)
      .select('id, status')
      .single();

    if (error) throw new Error(error.message);

    revalidatePath('/app/advisor/drafts');
    revalidatePath('/app/advisor/new');
    return { id: Number(data.id), status: String(data.status) as AdvisorOrderDraftStatus };
  }

  const { data, error } = await adminSupabase
    .from('advisor_order_drafts')
    .insert(draftPayload)
    .select('id, status')
    .single();

  if (error) throw new Error(error.message);

  revalidatePath('/app/advisor/drafts');
  revalidatePath('/app/advisor/new');
  return { id: Number(data.id), status: String(data.status) as AdvisorOrderDraftStatus };
}

export async function markAdvisorOrderDraftConvertedAction(input: { draftId: number; orderId: number }) {
  const ctx = await requireAuthContext();
  const draftId = Number(input.draftId);
  const orderId = Number(input.orderId);

  if (!Number.isFinite(draftId) || draftId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('No se pudo cerrar el borrador convertido.');
  }

  const adminSupabase = createSupabaseServiceRoleServer();
  const { data: existing, error: existingError } = await adminSupabase
    .from('advisor_order_drafts')
    .select('id, advisor_user_id, status')
    .eq('id', draftId)
    .maybeSingle();

  if (existingError || !existing) {
    throw new Error(existingError?.message || 'No se pudo cargar el borrador.');
  }

  if (existing.advisor_user_id !== ctx.user.id) {
    throw new Error('No puedes cerrar este borrador.');
  }

  const { error } = await adminSupabase
    .from('advisor_order_drafts')
    .update({
      status: 'converted',
      converted_order_id: orderId,
      converted_at: new Date().toISOString(),
    })
    .eq('id', draftId);

  if (error) throw new Error(error.message);

  revalidatePath('/app/advisor/drafts');
}

export async function ensureAdvisorOrderCreatedEventAction(input: { orderId: number }) {
  const ctx = await requireAuthContext();
  const orderId = Number(input.orderId);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const adminSupabase = createSupabaseServiceRoleServer();
  const { data: order, error: orderError } = await adminSupabase
    .from('orders')
    .select('id, order_number, created_at, created_by_user_id, attributed_advisor_id, source, fulfillment, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (order.attributed_advisor_id !== ctx.user.id || order.source !== 'advisor') {
    throw new Error('No puedes registrar el evento inicial de esta orden.');
  }

  const { data: existingEvent, error: existingEventError } = await adminSupabase
    .from('order_timeline_events')
    .select('id')
    .eq('order_id', orderId)
    .eq('event_type', 'order_created')
    .maybeSingle();

  if (existingEventError) throw new Error(existingEventError.message);
  if (existingEvent) return;

  const schedule = sanitizePlainObject(sanitizePlainObject(order.extra_fields).schedule);
  const { data: event, error: eventError } = await adminSupabase
    .from('order_timeline_events')
    .insert({
      order_id: orderId,
      order_number: order.order_number,
      event_type: 'order_created',
      event_group: 'approval',
      title: 'Orden creada',
      message: 'La orden fue creada y quedo pendiente de aprobacion.',
      severity: 'warning',
      actor_user_id: order.created_by_user_id || ctx.user.id,
      payload: {
      fulfillment: order.fulfillment,
      source: 'advisor',
      urgent: Boolean(schedule.asap),
      delivery_time: `${String(schedule.date || '').trim()} ${String(schedule.time_24 || '').trim()}`.trim() || null,
      },
      created_at: order.created_at,
    })
    .select('id')
    .single();

  if (eventError || !event) {
    throw new Error(eventError?.message || 'No se pudo registrar el evento de creación.');
  }

  const recipientRows = [
    { event_id: event.id, target_role: 'master', target_user_id: null, requires_action: true },
    { event_id: event.id, target_role: null, target_user_id: ctx.user.id, requires_action: false },
  ];
  const { error: recipientsError } = await adminSupabase
    .from('order_timeline_event_recipients')
    .insert(recipientRows);

  if (recipientsError) throw new Error(recipientsError.message);

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/master/dashboard');
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
