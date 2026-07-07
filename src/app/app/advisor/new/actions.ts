'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { requireAuthContext } from '@/lib/auth';
import { canAdvisorModifyOrder } from '@/lib/domain/order-domain';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';
import { sendPushToRoleDevices } from '@/lib/push';

const STALE_ORDER_EDIT_MESSAGE =
  'No se guardaron los cambios porque otra persona actualizó esta orden después de que la abriste. Para evitar pisar su trabajo, actualiza la orden, revisa lo nuevo y vuelve a guardar si todavía aplica.';

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

type AdvisorOrderChangeSummaryInput = {
  sections?: string[];
  summary?: string[];
};

type AdvisorOrderHeaderInput = {
  orderId: number;
  expectedLastModifiedAt?: string | null;
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
  if (!canAdvisorModifyOrder(String(status || ''))) {
    throw new Error('El asesor solo puede modificar una orden antes de entrar a cocina.');
  }
}

function sanitizePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
}

async function clearAdvisorReviewActionRecipients(
  supabase: ReturnType<typeof createSupabaseServiceRoleServer>,
  orderId: number,
  advisorUserId: string,
  nowIso: string
) {
  const { data: actionEvents, error: eventsError } = await supabase
    .from('order_timeline_events')
    .select('id')
    .eq('order_id', orderId)
    .in('event_type', ['order_returned_to_review', 'order_changes_rejected']);

  if (eventsError) throw new Error(eventsError.message);

  const eventIds = (actionEvents ?? [])
    .map((event) => Number(event.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (eventIds.length === 0) return;

  const { error: recipientsError } = await supabase
    .from('order_timeline_event_recipients')
    .update({
      requires_action: false,
      read_at: nowIso,
    })
    .in('event_id', eventIds)
    .or(`target_user_id.eq.${advisorUserId},target_role.eq.advisor`);

  if (recipientsError) throw new Error(recipientsError.message);
}

async function appendAdvisorCorrectionSubmittedEvent(params: {
  supabase: ReturnType<typeof createSupabaseServiceRoleServer>;
  orderId: number;
  orderNumber: string | number | null;
  advisorUserId: string;
  changeSummary?: AdvisorOrderChangeSummaryInput | null;
}) {
  const summary = sanitizeStringList(params.changeSummary?.summary);
  const sections = sanitizeStringList(params.changeSummary?.sections);
  const message = summary.length > 0
    ? summary.join(' ')
    : 'El asesor corrigio la orden y la reenvio para aprobacion.';

  const { data: event, error: eventError } = await params.supabase
    .from('order_timeline_events')
    .insert({
      order_id: params.orderId,
      order_number: params.orderNumber,
      event_type: 'order_modified',
      event_group: 'approval',
      title: 'Correccion reenviada',
      message,
      severity: 'warning',
      actor_user_id: params.advisorUserId,
      payload: {
        changed_sections: sections,
        change_summary: summary,
        source: 'advisor_mobile',
        submitted_for_master_review: true,
      },
    })
    .select('id')
    .single();

  if (eventError || !event) {
    throw new Error(eventError?.message || 'No se pudo registrar el reenvio de la orden.');
  }

  const { error: recipientsError } = await params.supabase
    .from('order_timeline_event_recipients')
    .insert([
      { event_id: event.id, target_role: 'master', target_user_id: null, requires_action: true },
      { event_id: event.id, target_role: 'admin', target_user_id: null, requires_action: true },
      { event_id: event.id, target_role: null, target_user_id: params.advisorUserId, requires_action: false },
    ]);

  if (recipientsError) throw new Error(recipientsError.message);

  try {
    const orderLabel = formatOrderDisplayLabel(params.orderId);
    await sendPushToRoleDevices({
      roles: ['master', 'admin'],
      title: `${orderLabel}: Correccion reenviada`,
      body: 'Un asesor corrigio una orden devuelta y requiere aprobacion.',
      url: '/app/master/dashboard',
      tag: `master-order-${params.orderId}-advisor-correction`,
      tone: 'critical',
      requireInteraction: true,
    });
  } catch (pushError) {
    console.warn(
      'advisor correction role push skipped',
      pushError instanceof Error ? pushError.message : 'unknown push error',
    );
  }
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

  try {
    const orderLabel = formatOrderDisplayLabel(orderId);
    await sendPushToRoleDevices({
      roles: ['master', 'admin'],
      title: `${orderLabel}: Orden creada`,
      body: 'La orden fue creada por un asesor y requiere aprobacion.',
      url: '/app/master/dashboard',
      tag: `master-order-${orderId}-order_created`,
      tone: 'critical',
      requireInteraction: true,
    });
  } catch (pushError) {
    console.warn(
      'advisor order_created role push skipped',
      pushError instanceof Error ? pushError.message : 'unknown push error',
    );
  }

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
    .select('id, attributed_advisor_id, status, last_modified_at, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes modificar esta orden.');
  }

  assertAdvisorCanEditOrderStatus(order.status);

  const expectedLastModifiedAt =
    typeof input.expectedLastModifiedAt === 'string' && input.expectedLastModifiedAt.trim()
      ? input.expectedLastModifiedAt.trim()
      : null;
  const currentLastModifiedAt =
    typeof order.last_modified_at === 'string' && order.last_modified_at.trim()
      ? order.last_modified_at.trim()
      : null;

  if (expectedLastModifiedAt !== currentLastModifiedAt) {
    return { ok: false as const, code: 'stale_order_edit', message: STALE_ORDER_EDIT_MESSAGE };
  }

  const adminSupabase = createSupabaseServiceRoleServer();
  const nowIso = new Date().toISOString();
  const existingExtraFields = sanitizePlainObject(order.extra_fields);
  const existingReview = sanitizePlainObject(existingExtraFields.review);
  const nextExtraFields =
    payload.extra_fields && typeof payload.extra_fields === 'object' && !Array.isArray(payload.extra_fields)
      ? { ...(payload.extra_fields as Record<string, unknown>) }
      : {};
  const incomingReview = sanitizePlainObject(nextExtraFields.review);
  if (Object.keys(existingReview).length > 0 || Object.keys(incomingReview).length > 0) {
    nextExtraFields.review = {
      ...existingReview,
      ...incomingReview,
    };
  }
  let updateOrderQuery = adminSupabase
    .from('orders')
    .update({
      ...payload,
      status: 'created',
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      delivery_address: payload.fulfillment === 'delivery' ? payload.delivery_address : null,
      extra_fields: nextExtraFields,
      last_modified_at: nowIso,
      last_modified_by: ctx.user.id,
    })
    .eq('id', orderId)
    .eq('attributed_advisor_id', ctx.user.id);
  updateOrderQuery =
    expectedLastModifiedAt === null
      ? updateOrderQuery.is('last_modified_at', null)
      : updateOrderQuery.eq('last_modified_at', expectedLastModifiedAt);

  const { data: updatedOrderRows, error: updateError } = await updateOrderQuery.select('id');

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updatedOrderRows || updatedOrderRows.length === 0) {
    return { ok: false as const, code: 'stale_order_edit', message: STALE_ORDER_EDIT_MESSAGE };
  }

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/master/dashboard');

  return { ok: true as const, lastModifiedAt: nowIso };
}

export async function submitAdvisorOrderCorrectionForReviewAction(input: {
  orderId: number;
  changeSummary?: AdvisorOrderChangeSummaryInput | null;
}) {
  const ctx = await requireAuthContext();
  const orderId = Number(input.orderId);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const adminSupabase = createSupabaseServiceRoleServer();
  const { data: order, error: orderError } = await adminSupabase
    .from('orders')
    .select('id, order_number, attributed_advisor_id, status, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes reenviar esta orden.');
  }

  if (String(order.status || '') !== 'created') {
    throw new Error('La orden debe quedar en creado para volver a revision.');
  }

  const nowIso = new Date().toISOString();
  const extraFields = sanitizePlainObject(order.extra_fields);
  const review = sanitizePlainObject(extraFields.review);
  const wasReturnedToAdvisor = Boolean(review.returned_to_advisor);

  if (wasReturnedToAdvisor) {
    const { error: clearReturnError } = await adminSupabase
      .from('orders')
      .update({
        extra_fields: {
          ...extraFields,
          review: {
            ...review,
            returned_to_advisor: false,
            returned_to_advisor_corrected_at: nowIso,
            returned_to_advisor_corrected_by: ctx.user.id,
          },
        },
        last_modified_at: nowIso,
        last_modified_by: ctx.user.id,
      })
      .eq('id', orderId)
      .eq('attributed_advisor_id', ctx.user.id);

    if (clearReturnError) throw new Error(clearReturnError.message);

    await clearAdvisorReviewActionRecipients(adminSupabase, orderId, ctx.user.id, nowIso);
  }

  await appendAdvisorCorrectionSubmittedEvent({
    supabase: adminSupabase,
    orderId,
    orderNumber: order.order_number ?? null,
    advisorUserId: ctx.user.id,
    changeSummary: input.changeSummary,
  });

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
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
    .select('id, attributed_advisor_id, status, extra_fields')
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
