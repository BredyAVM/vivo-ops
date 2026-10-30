'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { randomUUID } from 'node:crypto';
import { deliverAdvisorCreatedPush } from '@/lib/orders/advisor-created-push';
import {revalidateRewardWallet} from '@/lib/rewards/revalidate-wallet';
import { rewardFundingChanged } from '@/lib/rewards/order-funding';
import { createClient } from '@supabase/supabase-js';
import { requireAuthContext } from '@/lib/auth';
import { verifyMuerdemeOrderItems } from '@/lib/brands/order-menu-save';
import { canAdvisorModifyOrder } from '@/lib/domain/order-domain';
import { loadAdvisorCrmOrderContext } from '@/lib/crm/advisor-order-context';
import { decideCatalogGift, type CatalogGiftCandidate } from '@/lib/crm/catalog-gift';
import { readEventBudgetPayload } from '@/lib/events/event-budget';
import {
  sanitizeOrderChangeDetails,
  summarizeOrderChangeDetails,
  type OrderChangeDetail,
  type OrderChangeSection,
} from '@/lib/orders/order-change-detail';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';
import { normalizeOrderDetailForSave, type DetailComponent } from '@/lib/orders/order-detail-persistence';
import { storedApprovedPriceLine } from '@/lib/orders/approved-price-preservation';
import { preservedAgreedPriceSnapshot } from '@/lib/orders/operational-edit-pricing';
import { sendPushToRoleDevices } from '@/lib/push';

const STALE_ORDER_EDIT_MESSAGE =
  'No se guardaron los cambios porque otra persona actualizó esta orden después de que la abriste. Para evitar pisar su trabajo, actualiza la orden, revisa lo nuevo y vuelve a guardar si todavía aplica.';

type ReplaceAdvisorOrderItemInput = {
  rewardGrantId?: number | null;
  rewardPurpose?: 'customer_gift' | 'personal_purchase' | null;
  rewardAmountUsd?: number | null;
  orderItemId: number | null;
  draftPriceAgreementKey?: string | null;
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
  crmPlayMemberId: number | null;
  crmPlayBenefitId: number | null;
  crmPlayBenefitUpgradeId: number | null;
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

type CreateAdvisorOrderInput = {
  requestId: string;
  draftId?: number | null;
  payload: AdvisorOrderHeaderInput['payload'];
  items: ReplaceAdvisorOrderItemInput[];
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

function scheduleAdvisorCreatedPush(orderId: number, advisorId: string) {
  try {
    after(async () => {
      try {
        const supabase = createSupabaseServiceRoleServer();
        const claimId = randomUUID();
        await deliverAdvisorCreatedPush({ orderId, claimId }, {
          claim: async () => {
            const { data, error } = await supabase.rpc('claim_advisor_created_push_v1', {
              p_order_id: orderId, p_advisor_id: advisorId, p_claim_id: claimId,
            });
            if (error) throw new Error(error.message);
            const receipt = sanitizePlainObject(data);
            return { claimed: receipt.claimed === true, eventId: Number(receipt.eventId) };
          },
          send: sendPushToRoleDevices,
          finish: async (receipt) => {
            const { data, error } = await supabase.rpc('finish_advisor_created_push_v1', {
              p_event_id: receipt.eventId, p_claim_id: receipt.claimId, p_status: receipt.status,
              p_delivered: receipt.delivered, p_failures: receipt.failures,
            });
            if (error || data !== true) throw new Error('No se pudo registrar el resultado de la alerta.');
          },
          report: (receipt) => console.info('advisor_created_push', receipt),
        });
      } catch {
        // The order is already committed: a transport error must not invite recreation.
        console.warn('advisor_created_push_incomplete', { orderId });
      }
    });
  } catch {
    console.warn('advisor_created_push_not_scheduled', { orderId });
  }
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

export async function saveAdvisorOrderDraftAction(input: SaveAdvisorOrderDraftInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function markAdvisorOrderDraftConvertedAction(input: { draftId: number; orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function ensureAdvisorOrderCreatedEventAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateAdvisorOrderHeaderAction(input: AdvisorOrderHeaderInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function resolveAdvisorCatalogGiftAction(input: { clientId: number; productId: number; quantity: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function prepareAdvisorCrmPlayBenefitsAction(input: {
  playMemberId: number;
  playBenefitIds: number[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadAdvisorExistingOrderCrmContextAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitAdvisorOrderCorrectionForReviewAction(input: {
  orderId: number;
  changeSummary?: AdvisorOrderChangeSummaryInput | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

type AdvisorDetailInput = { productId: number; qty: number; editableDetailLines: string[] };

async function normalizeAdvisorItemDetails(
  supabase: Awaited<ReturnType<typeof requireAuthContext>>['supabase'], items: AdvisorDetailInput[],
) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('La orden debe contener entre 1 y 200 ítems.');
  const ids = [...new Set(items.map(item => Number(item.productId)))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Producto inválido.');
  const [products, components] = await Promise.all([
    supabase.from('products').select('id,name,inventory_policy,is_detail_editable,detail_units_limit').in('id', ids),
    supabase.from('product_components').select('parent_product_id,component_product_id,component_mode,quantity,is_required,counts_toward_detail_limit,sort_order').in('parent_product_id', ids).order('sort_order'),
  ]);
  if (products.error || components.error) throw new Error('No se pudo verificar la composición. Intenta guardar nuevamente.');
  const childIds = [...new Set((components.data ?? []).map(c => Number(c.component_product_id)))];
  const children = childIds.length ? await supabase.from('products').select('id,name').in('id', childIds) : { data: [], error: null };
  if (children.error) throw new Error('No se pudieron verificar las piezas. Intenta guardar nuevamente.');
  const names = new Map((children.data ?? []).map(p => [Number(p.id), String(p.name)]));
  return items.map((item, index) => {
    const product = products.data?.find(p => Number(p.id) === Number(item.productId));
    if (!product) throw new Error(`Ítem ${index + 1}: no se encontró el producto.`);
    const detailComponents: DetailComponent[] = (components.data ?? []).filter(c => Number(c.parent_product_id) === Number(item.productId)).map(c => ({
      component_product_id: Number(c.component_product_id), component_mode: c.component_mode,
      quantity: Number(c.quantity), is_required: Boolean(c.is_required),
      counts_toward_detail_limit: Boolean(c.counts_toward_detail_limit), name: names.get(Number(c.component_product_id)) ?? '',
    }));
    if (detailComponents.some(c => !c.name)) throw new Error(`Ítem ${index + 1}: falta una pieza en el catálogo.`);
    try { return normalizeOrderDetailForSave(product, Number(item.qty), item.editableDetailLines, detailComponents); }
    catch (error) { throw new Error(`Ítem ${index + 1}: ${error instanceof Error ? error.message : 'Detalle inválido.'}`); }
  });
}

/** Read-only preflight, before the composer writes a client or order header. */
export async function validateAdvisorOrderDetailsAction(items: AdvisorDetailInput[]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function validateAdvisorMuerdemeItemsAction(items: Parameters<typeof verifyMuerdemeOrderItems>[1], orderId?:number|null) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createAdvisorOrderAction(input: CreateAdvisorOrderInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function replaceAdvisorOrderItemsAction(input: {
  orderId: number;
  expectedLastModifiedAt?: string | null;
  payload: AdvisorOrderHeaderInput['payload'];
  items: ReplaceAdvisorOrderItemInput[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
