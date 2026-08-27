'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { requireAuthContext } from '@/lib/auth';
import { canAdvisorModifyOrder } from '@/lib/domain/order-domain';
import { readEventBudgetPayload } from '@/lib/events/event-budget';
import {
  sanitizeOrderChangeDetails,
  summarizeOrderChangeDetails,
  type OrderChangeDetail,
  type OrderChangeSection,
} from '@/lib/orders/order-change-detail';
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

function nestedRecord(source: Record<string, unknown>, key: string) {
  return sanitizePlainObject(source[key]);
}

function comparableChangeValue(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toFixed(4))) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).replace(/\s+/g, ' ').trim();
}

function readableText(value: unknown) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized || 'Sin indicar';
}

function readableBoolean(value: unknown) {
  return Boolean(value) ? 'Si' : 'No';
}

function readableNumber(value: unknown, prefix = '') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Sin indicar';
  const formatted = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(amount);
  return `${prefix}${formatted}`;
}

function readableDate(value: unknown) {
  const normalized = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : readableText(normalized);
}

function readableFulfillment(value: unknown) {
  return String(value || '') === 'delivery' ? 'Delivery' : 'Retiro en local';
}

function readablePaymentMethod(value: unknown) {
  const normalized = String(value || '').trim();
  const labels: Record<string, string> = {
    pending: 'Por definir',
    cash: 'Efectivo',
    cash_usd: 'Efectivo USD',
    cash_ves: 'Efectivo VES',
    payment_mobile: 'Pago movil',
    transfer: 'Transferencia',
    pos: 'Punto de venta',
    zelle: 'Zelle',
    wallet_usd: 'Wallet USD',
    mixed: 'Pago mixto',
  };
  return labels[normalized] ?? readableText(normalized);
}

function appendOrderChangeDetail(
  details: OrderChangeDetail[],
  input: {
    section: OrderChangeSection;
    field: string;
    label: string;
    before: unknown;
    after: unknown;
    format?: (value: unknown) => string;
  }
) {
  if (comparableChangeValue(input.before) === comparableChangeValue(input.after)) return;

  const beforeComparable = comparableChangeValue(input.before);
  const afterComparable = comparableChangeValue(input.after);
  const format = input.format ?? readableText;
  details.push({
    section: input.section,
    field: input.field,
    label: input.label,
    kind: !beforeComparable ? 'added' : !afterComparable ? 'removed' : 'changed',
    before: beforeComparable ? format(input.before) : null,
    after: afterComparable ? format(input.after) : null,
  });
}

function buildAdvisorHeaderChangeDetails(input: {
  order: {
    client_id: number | string | null;
    fulfillment: string | null;
    delivery_address: string | null;
    receiver_name: string | null;
    receiver_phone: string | null;
    notes: string | null;
    total_usd: number | string | null;
    total_bs_snapshot: number | string | null;
    extra_fields: Record<string, unknown> | null;
  };
  payload: AdvisorOrderHeaderInput['payload'];
  clientNameById: Map<number, string>;
}) {
  const { order, payload, clientNameById } = input;
  const details: OrderChangeDetail[] = [];
  const previousExtra = sanitizePlainObject(order.extra_fields);
  const nextExtra = sanitizePlainObject(payload.extra_fields);
  const previousSchedule = nestedRecord(previousExtra, 'schedule');
  const nextSchedule = nestedRecord(nextExtra, 'schedule');
  const previousDelivery = nestedRecord(previousExtra, 'delivery');
  const nextDelivery = nestedRecord(nextExtra, 'delivery');
  const previousPayment = nestedRecord(previousExtra, 'payment');
  const nextPayment = nestedRecord(nextExtra, 'payment');
  const previousPricing = nestedRecord(previousExtra, 'pricing');
  const nextPricing = nestedRecord(nextExtra, 'pricing');
  const previousDocuments = nestedRecord(previousExtra, 'documents');
  const nextDocuments = nestedRecord(nextExtra, 'documents');
  const previousInvoice = nestedRecord(previousDocuments, 'invoice_snapshot');
  const nextInvoice = nestedRecord(nextDocuments, 'invoice_snapshot');
  const previousDeliveryNote = nestedRecord(previousDocuments, 'delivery_note_snapshot');
  const nextDeliveryNote = nestedRecord(nextDocuments, 'delivery_note_snapshot');
  const previousClientId = Number(order.client_id || 0);
  const nextClientId = Number(payload.client_id || 0);
  const clientLabel = (value: unknown) => {
    const id = Number(value || 0);
    return id > 0 ? clientNameById.get(id) ?? `Cliente #${id}` : 'Sin indicar';
  };

  appendOrderChangeDetail(details, { section: 'cliente', field: 'client_id', label: 'Cliente', before: previousClientId, after: nextClientId, format: clientLabel });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'fulfillment', label: 'Tipo de entrega', before: order.fulfillment, after: payload.fulfillment, format: readableFulfillment });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'schedule.date', label: 'Fecha de entrega', before: previousSchedule.date, after: nextSchedule.date, format: readableDate });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'schedule.time_12', label: 'Hora de entrega', before: previousSchedule.time_12, after: nextSchedule.time_12 });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'schedule.asap', label: 'Entrega lo antes posible', before: Boolean(previousSchedule.asap), after: Boolean(nextSchedule.asap), format: readableBoolean });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'receiver_name', label: 'Persona que recibe', before: order.receiver_name, after: payload.receiver_name });
  appendOrderChangeDetail(details, { section: 'entrega', field: 'receiver_phone', label: 'Telefono de quien recibe', before: order.receiver_phone, after: payload.receiver_phone });
  appendOrderChangeDetail(details, { section: 'direccion', field: 'delivery_address', label: 'Direccion de entrega', before: order.delivery_address ?? previousDelivery.address, after: payload.delivery_address ?? nextDelivery.address });
  appendOrderChangeDetail(details, { section: 'direccion', field: 'delivery.gps_url', label: 'Ubicacion GPS', before: previousDelivery.gps_url, after: nextDelivery.gps_url });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.method', label: 'Metodo de pago', before: previousPayment.method, after: nextPayment.method, format: readablePaymentMethod });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.currency', label: 'Moneda de pago', before: previousPayment.currency, after: nextPayment.currency });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.requires_change', label: 'Solicita cambio', before: Boolean(previousPayment.requires_change), after: Boolean(nextPayment.requires_change), format: readableBoolean });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.change_for', label: 'Cambio para', before: previousPayment.change_for, after: nextPayment.change_for, format: readableNumber });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.change_currency', label: 'Moneda del cambio', before: previousPayment.change_currency, after: nextPayment.change_currency });
  appendOrderChangeDetail(details, { section: 'pago', field: 'payment.notes', label: 'Nota de pago', before: previousPayment.notes, after: nextPayment.notes });
  appendOrderChangeDetail(details, { section: 'precio', field: 'pricing.fx_rate', label: 'Tasa de la orden', before: previousPricing.fx_rate, after: nextPricing.fx_rate, format: (value) => readableNumber(value, 'Bs ') });
  appendOrderChangeDetail(details, { section: 'precio', field: 'pricing.discount_pct', label: 'Descuento', before: Number(previousPricing.discount_pct || 0), after: Number(nextPricing.discount_pct || 0), format: (value) => `${readableNumber(value)}%` });
  appendOrderChangeDetail(details, { section: 'precio', field: 'total_usd', label: 'Total USD', before: order.total_usd, after: payload.total_usd, format: (value) => readableNumber(value, '$') });
  appendOrderChangeDetail(details, { section: 'precio', field: 'total_bs_snapshot', label: 'Total VES', before: order.total_bs_snapshot, after: payload.total_bs_snapshot, format: (value) => readableNumber(value, 'Bs ') });
  appendOrderChangeDetail(details, { section: 'factura', field: 'documents.has_invoice', label: 'Factura', before: Boolean(previousDocuments.has_invoice), after: Boolean(nextDocuments.has_invoice), format: readableBoolean });
  appendOrderChangeDetail(details, { section: 'factura', field: 'invoice.company_name', label: 'Razon social', before: previousInvoice.company_name, after: nextInvoice.company_name });
  appendOrderChangeDetail(details, { section: 'factura', field: 'invoice.tax_id', label: 'RIF', before: previousInvoice.tax_id, after: nextInvoice.tax_id });
  appendOrderChangeDetail(details, { section: 'factura', field: 'invoice.address', label: 'Direccion fiscal', before: previousInvoice.address, after: nextInvoice.address });
  appendOrderChangeDetail(details, { section: 'factura', field: 'invoice.phone', label: 'Telefono fiscal', before: previousInvoice.phone, after: nextInvoice.phone });
  appendOrderChangeDetail(details, { section: 'nota_entrega', field: 'documents.has_delivery_note', label: 'Nota de entrega', before: Boolean(previousDocuments.has_delivery_note), after: Boolean(nextDocuments.has_delivery_note), format: readableBoolean });
  appendOrderChangeDetail(details, { section: 'nota_entrega', field: 'delivery_note.name', label: 'Nombre en nota de entrega', before: previousDeliveryNote.name, after: nextDeliveryNote.name });
  appendOrderChangeDetail(details, { section: 'nota_entrega', field: 'delivery_note.document_id', label: 'Documento en nota de entrega', before: previousDeliveryNote.document_id, after: nextDeliveryNote.document_id });
  appendOrderChangeDetail(details, { section: 'nota_entrega', field: 'delivery_note.address', label: 'Direccion en nota de entrega', before: previousDeliveryNote.address, after: nextDeliveryNote.address });
  appendOrderChangeDetail(details, { section: 'nota_entrega', field: 'delivery_note.phone', label: 'Telefono en nota de entrega', before: previousDeliveryNote.phone, after: nextDeliveryNote.phone });
  appendOrderChangeDetail(details, { section: 'nota', field: 'notes', label: 'Nota del pedido', before: order.notes, after: payload.notes });

  return sanitizeOrderChangeDetails(details);
}

type AdvisorComparableOrderItem = {
  productId: number;
  productName: string;
  qty: number;
  unitPriceUsd: number;
  detailLines: string[];
};

function normalizeItemDetailLines(value: unknown) {
  const lines = Array.isArray(value)
    ? value
    : String(value ?? '').split('\n');
  return lines
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function advisorItemSignature(item: AdvisorComparableOrderItem) {
  return `${item.productId}|${item.detailLines.map((line) => line.toLocaleLowerCase('es-VE')).join('|')}`;
}

function itemQuantityText(item: AdvisorComparableOrderItem) {
  const quantity = readableNumber(item.qty);
  return item.detailLines.length > 0
    ? `x${quantity} (${item.detailLines.join('; ')})`
    : `x${quantity}`;
}

function buildAdvisorItemChangeDetails(
  previousItems: AdvisorComparableOrderItem[],
  nextItems: AdvisorComparableOrderItem[]
) {
  const aggregate = (items: AdvisorComparableOrderItem[]) => {
    const result = new Map<string, AdvisorComparableOrderItem>();
    for (const item of items) {
      const key = advisorItemSignature(item);
      const existing = result.get(key);
      if (existing) {
        existing.qty += item.qty;
        continue;
      }
      result.set(key, { ...item, detailLines: [...item.detailLines] });
    }
    return result;
  };
  const previousBySignature = aggregate(previousItems);
  const nextBySignature = aggregate(nextItems);
  const signatures = Array.from(new Set([...previousBySignature.keys(), ...nextBySignature.keys()]));
  const details: OrderChangeDetail[] = [];

  for (const signature of signatures) {
    const previous = previousBySignature.get(signature);
    const next = nextBySignature.get(signature);
    const visible = next ?? previous;
    if (!visible) continue;
    const fieldKey = signature.slice(0, 80);

    if (!previous || !next) {
      appendOrderChangeDetail(details, {
        section: 'pedido',
        field: `item.${fieldKey}`,
        label: visible.productName,
        before: previous ? itemQuantityText(previous) : null,
        after: next ? itemQuantityText(next) : null,
      });
      continue;
    }

    appendOrderChangeDetail(details, {
      section: 'pedido',
      field: `item.${fieldKey}.qty`,
      label: `Cantidad · ${visible.productName}`,
      before: previous.qty,
      after: next.qty,
      format: readableNumber,
    });
    appendOrderChangeDetail(details, {
      section: 'pedido',
      field: `item.${fieldKey}.unit_price_usd`,
      label: `Precio unitario · ${visible.productName}`,
      before: previous.unitPriceUsd,
      after: next.unitPriceUsd,
      format: (value) => readableNumber(value, '$'),
    });
  }

  return sanitizeOrderChangeDetails(details);
}

function mergePendingOrderChangeDetails(existingInput: unknown, incomingInput: unknown) {
  const existing = sanitizeOrderChangeDetails(existingInput);
  const incoming = sanitizeOrderChangeDetails(incomingInput);
  const byField = new Map(existing.map((detail) => [`${detail.section}:${detail.field}`, detail]));

  for (const detail of incoming) {
    const key = `${detail.section}:${detail.field}`;
    const previous = byField.get(key);
    const merged = previous
      ? { ...detail, before: previous.before }
      : detail;
    if (merged.before === merged.after) byField.delete(key);
    else byField.set(key, merged);
  }

  return sanitizeOrderChangeDetails(Array.from(byField.values()));
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
  changeDetails?: OrderChangeDetail[] | null;
}) {
  const changeDetails = sanitizeOrderChangeDetails(params.changeDetails);
  const sections = Array.from(new Set(changeDetails.map((detail) => detail.section)));
  const summary = changeDetails.length > 0
    ? [summarizeOrderChangeDetails(changeDetails)]
    : [];
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
        change_details: changeDetails,
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
      body: message,
      url: `/app/master/ops?openOrder=${params.orderId}&tab=cambios`,
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
  if (readEventBudgetPayload(input.payload)) {
    throw new Error('Los presupuestos de eventos solo pueden ser modificados por Administración.');
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
      .select('id, advisor_user_id, status, payload')
      .eq('id', draftId)
      .maybeSingle();

    if (existingError || !existing) {
      throw new Error(existingError?.message || 'No se pudo cargar el borrador.');
    }

    if (existing.advisor_user_id !== ctx.user.id) {
      throw new Error('No puedes modificar este borrador.');
    }
    if (readEventBudgetPayload(existing.payload)) {
      throw new Error('Los presupuestos de eventos son de solo lectura para el asesor.');
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
    .select('id, advisor_user_id, status, payload')
    .eq('id', draftId)
    .maybeSingle();

  if (existingError || !existing) {
    throw new Error(existingError?.message || 'No se pudo cargar el borrador.');
  }

  if (existing.advisor_user_id !== ctx.user.id) {
    throw new Error('No puedes cerrar este borrador.');
  }
  if (readEventBudgetPayload(existing.payload)) {
    throw new Error('Solo Administración puede convertir un presupuesto de evento.');
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
    .select('id, client_id, attributed_advisor_id, status, last_modified_at, fulfillment, delivery_address, receiver_name, receiver_phone, notes, total_usd, total_bs_snapshot, extra_fields')
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
  const clientIds = Array.from(
    new Set([Number(order.client_id || 0), Number(payload.client_id || 0)].filter((id) => id > 0))
  );
  const clientNameById = new Map<number, string>();
  if (clientIds.length > 0) {
    const { data: clients, error: clientsError } = await adminSupabase
      .from('clients')
      .select('id, full_name')
      .in('id', clientIds);
    if (clientsError) throw new Error(clientsError.message);
    for (const client of clients ?? []) {
      clientNameById.set(Number(client.id), String(client.full_name || '').trim() || `Cliente #${client.id}`);
    }
  }
  const headerChangeDetails = buildAdvisorHeaderChangeDetails({
    order,
    payload,
    clientNameById,
  });
  const pendingChangeDetails = mergePendingOrderChangeDetails(
    existingReview.advisor_pending_change_details,
    headerChangeDetails
  );
  if (Object.keys(existingReview).length > 0 || Object.keys(incomingReview).length > 0) {
    nextExtraFields.review = {
      ...existingReview,
      ...incomingReview,
      advisor_pending_change_details: pendingChangeDetails,
      advisor_pending_change_started_at: nowIso,
      advisor_pending_change_started_by: ctx.user.id,
    };
  } else {
    nextExtraFields.review = {
      advisor_pending_change_details: pendingChangeDetails,
      advisor_pending_change_started_at: nowIso,
      advisor_pending_change_started_by: ctx.user.id,
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
  revalidatePath('/app/master/ops');
  revalidatePath('/app/master/dashboard');

  return { ok: true as const, lastModifiedAt: nowIso };
}

export async function redeemAdvisorCrmPlayBenefitsAction(input: {
  playMemberId: number;
  orderId: number;
}) {
  try {
    const ctx = await requireAuthContext();
    const playMemberId = Math.trunc(Number(input.playMemberId));
    const orderId = Math.trunc(Number(input.orderId));
    if (playMemberId <= 0 || orderId <= 0) {
      return { ok: false as const, message: 'La jugada o la orden no son válidas.' };
    }

    const { data, error } = await ctx.supabase.rpc('crm_redeem_play_benefits_v2', {
      p_play_member_id: playMemberId,
      p_order_id: orderId,
    });
    if (error) return { ok: false as const, message: error.message };

    revalidatePath('/app/advisor/plays');
    revalidatePath(`/app/advisor/orders/${orderId}`);
    revalidatePath('/app/advisor/commissions');
    return { ok: true as const, data, message: 'Beneficio de la jugada aplicado y vinculado a la comisión.' };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo aplicar el beneficio de la jugada.',
    };
  }
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
  const changeDetails = sanitizeOrderChangeDetails(review.advisor_pending_change_details);

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
    changeDetails,
  });

  const clearedReview: Record<string, unknown> = {
    ...review,
    ...(wasReturnedToAdvisor
      ? {
          returned_to_advisor: false,
          returned_to_advisor_corrected_at: nowIso,
          returned_to_advisor_corrected_by: ctx.user.id,
        }
      : {}),
  };
  delete clearedReview.advisor_pending_change_details;
  delete clearedReview.advisor_pending_change_started_at;
  delete clearedReview.advisor_pending_change_started_by;
  const { error: clearPendingDetailsError } = await adminSupabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        review: clearedReview,
      },
    })
    .eq('id', orderId)
    .eq('attributed_advisor_id', ctx.user.id);
  if (clearPendingDetailsError) throw new Error(clearPendingDetailsError.message);

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/master/ops');
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
    .select('id, product_id, product_name_snapshot, qty, unit_price_usd_snapshot, notes')
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

  const previousComparableItems: AdvisorComparableOrderItem[] = (existingItems ?? []).map((item) => ({
    productId: Number(item.product_id || 0),
    productName: String(item.product_name_snapshot || '').trim() || 'Item',
    qty: toFiniteNumber(item.qty),
    unitPriceUsd: toFiniteNumber(item.unit_price_usd_snapshot),
    detailLines: normalizeItemDetailLines(item.notes),
  }));
  const nextComparableItems: AdvisorComparableOrderItem[] = itemsPayload.map((item) => ({
    productId: Number(item.product_id || 0),
    productName: String(item.product_name_snapshot || '').trim() || 'Item',
    qty: toFiniteNumber(item.qty),
    unitPriceUsd: toFiniteNumber(item.unit_price_usd_snapshot),
    detailLines: normalizeItemDetailLines(item.notes),
  }));
  const itemChangeDetails = buildAdvisorItemChangeDetails(previousComparableItems, nextComparableItems);
  const extraFields = sanitizePlainObject(order.extra_fields);
  const review = sanitizePlainObject(extraFields.review);
  const headerChangeDetails = sanitizeOrderChangeDetails(review.advisor_pending_change_details);
  const mergedChangeDetails = mergePendingOrderChangeDetails(headerChangeDetails, itemChangeDetails);
  const { error: reviewUpdateError } = await adminSupabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        review: {
          ...review,
          advisor_pending_change_details: mergedChangeDetails,
        },
      },
    })
    .eq('id', orderId)
    .eq('attributed_advisor_id', ctx.user.id);

  if (reviewUpdateError) throw new Error(reviewUpdateError.message);

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/master/dashboard');
}
