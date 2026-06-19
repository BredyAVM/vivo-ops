import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import {
  OPERATIONAL_PHASES,
  type OperationalPhase,
  getOperationalPhase,
  getOperationalPhaseIndex,
  getOperationalStatusLabel,
  getPaymentMethodLabel,
  formatOrderDisplayNumber,
} from '@/lib/orders/order-labels';
import { getOrderLineTotalBs, getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { buildWhatsAppOrderSummaryText } from '@/lib/orders/whatsapp-summary';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../../advisor-ui';
import { shouldRequireAdvisorAction } from '../../inbox/inbox-shared';
import OrderDetailActions from './OrderDetailActions';

type PageParams = Promise<{
  id: string;
}>;

type PageSearchParams = Promise<{
  reportPayment?: string;
}>;

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string;
  created_at: string;
  delivery_address: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  notes: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      asap?: boolean | null;
    } | null;
    receiver?: {
      name?: string | null;
      phone?: string | null;
    } | null;
    delivery?: {
      gps_url?: string | null;
      completed_at?: string | null;
    } | null;
    payment?: {
      method?: string | null;
      currency?: string | null;
      notes?: string | null;
      requires_change?: boolean | null;
      change_for?: string | number | null;
      change_currency?: string | null;
      client_fund_used_usd?: number | string | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      subtotal_usd?: number | string | null;
      subtotal_bs?: number | string | null;
      discount_enabled?: boolean | null;
      discount_pct?: number | string | null;
      discount_amount_usd?: number | string | null;
      discount_amount_bs?: number | string | null;
      subtotal_after_discount_usd?: number | string | null;
      subtotal_after_discount_bs?: number | string | null;
      invoice_tax_pct?: number | string | null;
      invoice_tax_amount_usd?: number | string | null;
      invoice_tax_amount_bs?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
    } | null;
    documents?: {
      has_delivery_note?: boolean | null;
      has_invoice?: boolean | null;
      invoice_data_note?: string | null;
      invoice_snapshot?: {
        company_name?: string | null;
        tax_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
      delivery_note_snapshot?: {
        name?: string | null;
        document_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
    } | null;
  } | null;
  client:
    | {
        full_name: string | null;
        phone: string | null;
        client_type: string | null;
        fund_balance_usd: number | string | null;
      }[]
    | {
        full_name: string | null;
        phone: string | null;
        client_type: string | null;
        fund_balance_usd: number | string | null;
      }
    | null;
};

type OrderItemRow = {
  id: number;
  product_id: number | string | null;
  qty: number | string;
  product_name_snapshot: string | null;
  line_total_usd: number | string | null;
  line_total_bs_snapshot: number | string | null;
  admin_price_override_usd?: number | string | null;
  admin_price_override_reason?: string | null;
  notes: string | null;
  product:
    | {
        type: 'product' | 'combo' | 'service' | 'promo' | 'gambit' | null;
        units_per_service: number | null;
      }[]
    | {
        type: 'product' | 'combo' | 'service' | 'promo' | 'gambit' | null;
        units_per_service: number | null;
      }
    | null;
};

type PaymentReportRow = {
  id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reported_currency_code: string | null;
  reported_amount: number | string | null;
  reported_amount_usd_equivalent: number | string | null;
  reference_code: string | null;
  notes: string | null;
  created_at: string | null;
};

type RawOrderFinancialStateRow = {
  order_id: number | string;
  total_usd: number | string | null;
  total_bs: number | string | null;
  confirmed_paid_usd: number | string | null;
  confirmed_paid_bs_snapshot: number | string | null;
  pending_reports_usd: number | string | null;
  pending_reports_bs_snapshot: number | string | null;
  rejected_reports_count: number | string | null;
  pending_usd: number | string | null;
  pending_bs: number | string | null;
};

type RawTimelineEvent = {
  id: number | string | null;
  order_id: number | string | null;
  event_type: string | null;
  event_group: string | null;
  title: string | null;
  message: string | null;
  severity: 'info' | 'warning' | 'critical' | null;
  payload: Record<string, unknown> | null;
  created_at: string | null;
  event?: string | null;
  meta?: Record<string, unknown> | null;
};

type TimelineEvent = {
  id: string;
  eventType: string;
  title: string;
  message: string;
  createdAt: string;
  tone: 'neutral' | 'warning' | 'success' | 'danger';
  detailLines: string[];
  requiresAction: boolean;
};

const ACTION_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'payment_rejected',
]);

function safeText(value: unknown, fallback = 'Sin dato') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizePhoneForWhatsApp(value: string | null | undefined) {
  const normalized = String(value || '').replace(/[^\d+]/g, '').trim();
  if (!normalized) return '';
  return normalized.startsWith('+') ? normalized.slice(1) : normalized;
}

function formatUsd(value: number | string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function formatBs(value: number | string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `Bs ${amount.toFixed(2)}` : 'Bs 0.00';
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function statusTone(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'created' || status === 'queued' || status === 'ready') return 'warning';
  if (status === 'delivered') return 'success';
  if (status === 'cancelled') return 'danger';
  return 'neutral';
}

function paymentLabel(status: PaymentReportRow['status']) {
  if (status === 'confirmed') return 'Confirmado';
  if (status === 'rejected') return 'Rechazado';
  return 'Por validar';
}

function paymentTone(status: PaymentReportRow['status']): 'warning' | 'success' | 'danger' {
  if (status === 'confirmed') return 'success';
  if (status === 'rejected') return 'danger';
  return 'warning';
}

function paymentMethodCopyLabel(value: string | null | undefined) {
  return getPaymentMethodLabel(value, { lowercase: true });
}

function isMovingOrderStatus(status: string) {
  return ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(status);
}

function getPaymentSummary(
  totalUsd: number,
  confirmedPaidUsd: number,
  pendingPaidUsd: number,
  balanceUsd: number,
) {
  const reportableBalanceUsd = Math.max(0, Number((balanceUsd - pendingPaidUsd).toFixed(2)));

  if (balanceUsd <= 0.005) {
    return {
      label: 'Pagado',
      tone: 'success' as const,
      detail: `Cobro completo por ${formatUsd(totalUsd)}.`,
    };
  }

  if (pendingPaidUsd > 0.005 && reportableBalanceUsd > 0.005) {
    return {
      label: 'Saldo pendiente',
      tone: 'warning' as const,
      detail: `${formatUsd(pendingPaidUsd)} en revision. Faltan ${formatUsd(reportableBalanceUsd)} por reportar.`,
    };
  }

  if (pendingPaidUsd > 0.005) {
    return {
      label: 'Por validar',
      tone: 'warning' as const,
      detail: `${formatUsd(pendingPaidUsd)} enviados a revision.`,
    };
  }

  if (confirmedPaidUsd > 0.005) {
    return {
      label: 'Saldo pendiente',
      tone: 'warning' as const,
      detail: `Faltan ${formatUsd(balanceUsd)} por cobrar.`,
    };
  }

  return {
    label: 'Sin cobro',
    tone: 'danger' as const,
    detail: `Pedido completo pendiente por ${formatUsd(balanceUsd)}.`,
  };
}

function operationalPhase(order: Pick<OrderRow, 'status'>): OperationalPhase {
  return getOperationalPhase(order.status);
}

function operationalPhaseIndex(order: Pick<OrderRow, 'status'>) {
  return getOperationalPhaseIndex(order.status);
}

function operationalPhaseLabel(order: Pick<OrderRow, 'status' | 'fulfillment'>) {
  return getOperationalStatusLabel(order);
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getVisibleEditableDetailLines(value: string | null | undefined) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('@sel|'));
}

function formatQuantityLabel(value: number | string | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function getDisplayPieces(qty: number, unitsPerService: number) {
  const fullServices = Math.trunc(qty);
  const fractional = qty - fullServices;

  let pieces = fullServices * unitsPerService;

  if (fractional >= 0.5) {
    pieces += Math.floor(unitsPerService / 2);
  }

  return pieces;
}

function getLineTotalBs(item: OrderItemRow, fxRate: number) {
  return getOrderLineTotalBs(item, fxRate);
}

function getOrderTotalBs(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalBs;
}

function getOrderFxRate(order: OrderRow) {
  return getOrderMoneySnapshot(order).fxRate;
}

function getOrderTotalUsdForSummary(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalUsd;
}

function lineTextWhatsAppStyle(item: OrderItemRow, fxRate: number) {
  const relatedProduct = Array.isArray(item.product) ? item.product[0] ?? null : item.product;
  const normalizedName = safeText(item.product_name_snapshot, 'Item');
  const isDelivery = normalizedName.toLowerCase().startsWith('delivery');
  const unitsPerService = Math.max(0, Number(relatedProduct?.units_per_service || 0));
  const lineTotalBs = getLineTotalBs(item, fxRate);
  const priceLabel = isDelivery && lineTotalBs <= 0.005 ? 'Delivery obsequiado' : formatBs(lineTotalBs);

  if (isDelivery) {
    return `- ${formatQuantityLabel(item.qty)} ${normalizedName}: ${priceLabel}`;
  }

  if (unitsPerService > 0) {
    const cleanName = normalizedName.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    const units = getDisplayPieces(Number(item.qty || 0), unitsPerService);
    const servicePrefix = relatedProduct?.type === 'service' ? 'Serv. ' : '';
    return `- ${formatQuantityLabel(item.qty)} ${servicePrefix}${cleanName} (${formatQuantityLabel(units)} und): ${formatBs(lineTotalBs)}`;
  }

  return `- ${formatQuantityLabel(item.qty)} ${normalizedName}: ${formatBs(lineTotalBs)}`;
}

function deliveryText(
  schedule:
    | {
        date?: string | null;
        time_12?: string | null;
        asap?: boolean | null;
      }
    | null
    | undefined,
) {
  if (schedule?.asap) return 'Lo antes posible';

  const date = safeText(schedule?.date, '');
  const time = safeText(schedule?.time_12, '');
  return `${date} ${time}`.trim() || 'Sin horario';
}

function deliveryDayText(
  schedule:
    | {
        date?: string | null;
        time_12?: string | null;
        asap?: boolean | null;
      }
    | null
    | undefined,
) {
  if (schedule?.asap) return 'Lo antes posible';
  return safeText(schedule?.date, 'Sin fecha');
}

function deliveryHourText(
  schedule:
    | {
        date?: string | null;
        time_12?: string | null;
        asap?: boolean | null;
      }
    | null
    | undefined,
) {
  if (schedule?.asap) return '';
  return safeText(schedule?.time_12, '');
}

function buildWhatsAppPricingLines(order: OrderRow) {
  const pricing = getOrderMoneySnapshot(order);
  const showBreakdown =
    pricing.discountEnabled ||
    pricing.discountAmountUsd > 0 ||
    pricing.discountAmountBs > 0 ||
    pricing.hasInvoice;
  const lines: string[] = [];

  if (showBreakdown) {
    lines.push(`*SUBTOTAL:* ${formatBs(pricing.subtotalBs)} / ${formatUsd(pricing.subtotalUsd)}`);
  }

  if (pricing.discountEnabled && (pricing.discountAmountUsd > 0 || pricing.discountAmountBs > 0)) {
    const pctLabel = pricing.discountPct > 0 ? ` (${pricing.discountPct}%)` : '';
    lines.push(
      `*DESCUENTO${pctLabel}:* -${formatBs(pricing.discountAmountBs)} / -${formatUsd(pricing.discountAmountUsd)}`
    );
  }

  if (showBreakdown && (pricing.discountEnabled || pricing.hasInvoice)) {
    lines.push(
      `*SUBTOTAL NETO:* ${formatBs(pricing.subtotalAfterDiscountBs)} / ${formatUsd(pricing.subtotalAfterDiscountUsd)}`
    );
  }

  if (pricing.hasInvoice) {
    const pctLabel = pricing.invoiceTaxPct > 0 ? ` (${pricing.invoiceTaxPct}%)` : '';
    lines.push(
      `*IVA${pctLabel}:* ${formatBs(pricing.invoiceTaxAmountBs)} / ${formatUsd(pricing.invoiceTaxAmountUsd)}`
    );
  }

  lines.push(`*TOTAL:* ${formatBs(pricing.totalBs)} / ${formatUsd(pricing.totalUsd)}`);
  return lines;
}

function buildWhatsAppInvoiceLines(order: OrderRow, check = '') {
  const documents = order.extra_fields?.documents;
  if (!documents?.has_invoice) return [];

  const snapshot = documents.invoice_snapshot;
  const prefix = check ? `${check} ` : '';
  const lines = [`${prefix}*Factura:* Si`];

  if (snapshot?.company_name?.trim()) lines.push(`${prefix}*Razon social:* ${snapshot.company_name.trim()}`);
  if (snapshot?.tax_id?.trim()) lines.push(`${prefix}*RIF/Cedula:* ${snapshot.tax_id.trim()}`);
  if (snapshot?.address?.trim()) lines.push(`${prefix}*Direccion fiscal:* ${snapshot.address.trim()}`);
  if (snapshot?.phone?.trim()) lines.push(`${prefix}*Telefono fiscal:* ${snapshot.phone.trim()}`);
  if (documents.invoice_data_note?.trim()) lines.push(`${prefix}*Datos factura:* ${documents.invoice_data_note.trim()}`);

  return lines;
}

function buildWhatsAppOrderSummary({
  order,
  items,
  advisorLabel,
}: {
  order: OrderRow & {
    client: {
      full_name: string | null;
      phone: string | null;
      client_type: string | null;
      fund_balance_usd: number | string | null;
    } | null;
  };
  items: OrderItemRow[];
  advisorLabel: string;
}) {
  const parts: string[] = [];
  const fxRate = getOrderFxRate(order);

  parts.push('*Resumen de Pedido*');
  parts.push('');
  parts.push(`*Orden:* ${order.id}`);
  parts.push(`*Asesor:* ${advisorLabel}`);
  parts.push(`*Cliente:* ${order.client?.full_name?.trim() || 'Cliente'}`);
  parts.push('');
  parts.push('*Pedido:*');
  parts.push('');

  if (items.length === 0) {
    parts.push('- Sin items cargados');
  } else {
    for (const item of items) {
      parts.push(lineTextWhatsAppStyle(item, fxRate));
      for (const detail of getVisibleEditableDetailLines(item.notes)) {
        parts.push(`- ${detail}`);
      }
    }
  }

  parts.push('');
  parts.push(...buildWhatsAppPricingLines(order));
  parts.push('');
  parts.push(`*Entrega:* ${order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`);
  parts.push(`*Dia de entrega:* ${deliveryText(order.extra_fields?.schedule)}`);

  if (order.fulfillment === 'delivery' && order.delivery_address?.trim()) {
    parts.push(`*Direccion:* ${order.delivery_address.trim()}`);
  }

  const invoiceLines = buildWhatsAppInvoiceLines(order);
  if (invoiceLines.length > 0) {
    parts.push('');
    parts.push(...invoiceLines);
  }

  if (order.notes?.trim()) {
    parts.push('');
    parts.push(`*Notas:* ${order.notes.trim()}`);
  }

  return parts.join('\n');
}

function buildCleanWhatsAppOrderSummary({
  order,
  items,
  advisorLabel,
}: {
  order: OrderRow & {
    client: {
      full_name: string | null;
      phone: string | null;
      client_type: string | null;
      fund_balance_usd: number | string | null;
    } | null;
  };
  items: OrderItemRow[];
  advisorLabel: string;
}) {
  const fxRate = getOrderFxRate(order);
  const pricing = getOrderMoneySnapshot(order);
  const payment = order.extra_fields?.payment;
  const documents = order.extra_fields?.documents;
  const invoiceSnapshot = documents?.invoice_snapshot;
  const deliveryNoteSnapshot = documents?.delivery_note_snapshot;
  const deliveryHour = deliveryHourText(order.extra_fields?.schedule);
  const deliveryFullText = [deliveryDayText(order.extra_fields?.schedule), deliveryHour].filter(Boolean).join(' - ');
  const paymentChangeText =
    payment?.requires_change && String(payment.change_for ?? '').trim()
      ? `${String(payment.change_for).trim()} ${safeText(payment.change_currency, 'USD')}`.trim()
      : null;

  return buildWhatsAppOrderSummaryText({
    title: 'Resumen de Pedido',
    orderLabel: String(order.id),
    advisorName: advisorLabel,
    clientName: order.client?.full_name?.trim() || 'Cliente',
    clientPhone: order.client?.phone,
    receiverName: order.extra_fields?.receiver?.name ?? order.receiver_name,
    receiverPhone: order.extra_fields?.receiver?.phone ?? order.receiver_phone,
    lines: items.map((item) => ({
      text: lineTextWhatsAppStyle(item, fxRate),
      detailLines: getVisibleEditableDetailLines(item.notes),
    })),
    price: {
      subtotalBs: pricing.subtotalBs,
      subtotalUsd: pricing.subtotalUsd,
      discountPct: pricing.discountPct,
      discountAmountBs: pricing.discountAmountBs,
      discountAmountUsd: pricing.discountAmountUsd,
      invoiceTaxPct: pricing.invoiceTaxPct,
      invoiceTaxAmountBs: pricing.invoiceTaxAmountBs,
      invoiceTaxAmountUsd: pricing.invoiceTaxAmountUsd,
      totalBs: pricing.totalBs,
      totalUsd: pricing.totalUsd,
    },
    fulfillment: order.fulfillment,
    deliveryText: deliveryFullText || deliveryText(order.extra_fields?.schedule),
    address: order.delivery_address,
    gpsUrl: order.extra_fields?.delivery?.gps_url,
    paymentMethodLabel: paymentMethodCopyLabel(payment?.method),
    paymentChangeText,
    paymentNote: payment?.notes,
    paymentStatus: 'Pendiente',
    invoice: {
      enabled: Boolean(documents?.has_invoice),
      companyName: invoiceSnapshot?.company_name,
      taxId: invoiceSnapshot?.tax_id,
      address: invoiceSnapshot?.address,
      phone: invoiceSnapshot?.phone,
    },
    deliveryNote: {
      enabled: Boolean(documents?.has_delivery_note),
      name: deliveryNoteSnapshot?.name,
      documentId: deliveryNoteSnapshot?.document_id,
      address: deliveryNoteSnapshot?.address,
      phone: deliveryNoteSnapshot?.phone,
    },
    notes: order.notes,
  });
}

function formatCaracasDateOnly(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeEventType(event: RawTimelineEvent) {
  return safeText(event.event_type ?? event.event, '');
}

function buildEventDedupKey(event: RawTimelineEvent) {
  return [
    Number(event.order_id || 0),
    normalizeEventType(event),
    safeText(event.created_at, ''),
    safeText(event.title, ''),
    safeText(event.message, ''),
  ].join('|');
}

function dedupeEvents(events: RawTimelineEvent[]) {
  const seen = new Set<string>();

  return events.filter((event) => {
    const eventType = normalizeEventType(event);
    if (!eventType) return false;

    const dedupKey = buildEventDedupKey(event);
    if (seen.has(dedupKey)) return false;

    seen.add(dedupKey);
    return true;
  });
}

function eventTitle(eventType: string, fallbackTitle: string) {
  const titles: Record<string, string> = {
    order_modified: 'Orden modificada',
    order_approved: 'Orden aprobada',
    order_returned_to_review: 'Orden devuelta',
    order_reapproved: 'Orden re-aprobada',
    order_changes_rejected: 'Cambios rechazados',
    order_changes_approved: 'Cambios aprobados',
    order_sent_to_kitchen: 'Enviada a cocina',
    kitchen_taken: 'Cocina tomó la orden',
    kitchen_eta_updated: 'Tiempo estimado actualizado',
    kitchen_delayed_prep: 'Retraso en cocina',
    order_ready: 'Orden preparada',
    pickup_ready: 'Lista para retiro',
    driver_assigned: 'Motorizado asignado',
    out_for_delivery: 'En camino',
    delivery_delayed: 'Retraso en entrega',
    pickup_collected: 'Orden retirada',
    order_delivered: 'Orden entregada',
    payment_reported: 'Pago reportado',
    payment_confirmed: 'Pago confirmado',
    payment_rejected: 'Pago rechazado',
    client_fund_application_requested: 'Solicitud de pago con fondo',
  };

  return titles[eventType] || safeText(fallbackTitle, 'Evento');
}

function fallbackTimelineMessage(eventType: string) {
  const messages: Record<string, string> = {
    order_modified: 'La orden fue actualizada por el asesor.',
    order_approved: 'La orden ya esta aprobada.',
    order_returned_to_review: 'La orden necesita una revision del asesor.',
    order_reapproved: 'La orden volvio a quedar aprobada.',
    order_changes_rejected: 'Se rechazaron cambios y toca revisarlos.',
    order_changes_approved: 'Los cambios solicitados fueron aprobados.',
    order_sent_to_kitchen: 'La orden ya fue enviada a cocina.',
    kitchen_taken: 'Cocina ya tomo la orden y comenzo a moverla.',
    kitchen_eta_updated: 'Cocina actualizo el tiempo estimado.',
    kitchen_delayed_prep: 'La preparacion va con retraso.',
    order_ready: 'La orden esta lista para salir.',
    pickup_ready: 'La orden esta lista para retiro.',
    driver_assigned: 'Ya hay motorizado asignado para esta entrega.',
    out_for_delivery: 'La orden ya va en camino.',
    delivery_delayed: 'La entrega se esta retrasando.',
    pickup_collected: 'La orden ya fue retirada.',
    order_delivered: 'La entrega ya fue completada.',
    payment_reported: 'Se reporto un pago y esta en revision.',
    payment_confirmed: 'El pago ya quedo confirmado.',
    payment_rejected: 'El pago fue rechazado y necesita correccion.',
    client_fund_application_requested: 'Se solicito aplicar fondo del cliente a esta orden.',
  };

  return messages[eventType] || 'Sin detalle adicional.';
}

function eventTone(eventType: string): TimelineEvent['tone'] {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected') return 'danger';
  if (
    ACTION_EVENT_TYPES.has(eventType) ||
    eventType.includes('delayed') ||
    eventType === 'client_fund_application_requested'
  ) return 'warning';
  if (eventType === 'payment_confirmed' || eventType === 'order_delivered' || eventType === 'pickup_collected') return 'success';
  return 'neutral';
}

function buildDetailLines(eventType: string, payload: Record<string, unknown>) {
  const details: string[] = [];
  const reason = safeText(payload.reason ?? payload.review_notes ?? payload.notes ?? payload.note, '');
  const etaMinutes = payload.eta_minutes ?? payload.etaMinutes;
  const driver = safeText(payload.driver_name ?? payload.driverName ?? payload.partner_name ?? payload.partnerName, '');

  if (
    (eventType === 'order_returned_to_review' ||
      eventType === 'order_changes_rejected' ||
      eventType === 'payment_rejected') &&
    reason
  ) {
    details.push(`Motivo: ${reason}`);
  }

  if (eventType === 'client_fund_application_requested') {
    const amount = payload.requested_amount_usd;
    const available = payload.available_fund_usd;
    if (amount != null && String(amount).trim()) details.push(`Monto solicitado: $${Number(amount).toFixed(2)}`);
    if (available != null && String(available).trim()) details.push(`Fondo disponible: $${Number(available).toFixed(2)}`);
    if (reason) details.push(`Nota: ${reason}`);
  }

  if (
    (eventType === 'kitchen_eta_updated' ||
      eventType === 'kitchen_delayed_prep' ||
      eventType === 'out_for_delivery' ||
      eventType === 'delivery_delayed') &&
    etaMinutes != null &&
    String(etaMinutes).trim()
  ) {
    details.push(`ETA: ${String(etaMinutes).trim()} min`);
  }

  if (
    (eventType === 'driver_assigned' ||
      eventType === 'out_for_delivery' ||
      eventType === 'delivery_delayed') &&
    driver
  ) {
    details.push(`Motorizado: ${driver}`);
  }

  return details;
}

export default async function AdvisorOrderDetailPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams?: PageSearchParams;
}) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const resolved = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const orderId = Number(resolved.id);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    redirect('/app/advisor/orders');
  }

  const { data: orderData } = await ctx.supabase
    .from('orders')
    .select(
      'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, receiver_name, receiver_phone, notes, extra_fields, client:clients!orders_client_id_fkey(full_name, phone, client_type, fund_balance_usd)'
    )
    .eq('id', orderId)
    .eq('attributed_advisor_id', ctx.user.id)
    .maybeSingle();

  if (!orderData) {
    redirect('/app/advisor/orders');
  }

  const orderRow = orderData as OrderRow;
  const orderClientData = orderRow.client;
  const order = {
    ...orderRow,
    client: Array.isArray(orderClientData) ? orderClientData[0] ?? null : orderClientData ?? null,
  };

  const orderPaymentMethod = String(order.extra_fields?.payment?.method || '').trim();

  const [
    itemsResult,
    paymentsResult,
    timelineResult,
    exchangeRateResult,
  ] = await Promise.all([
      ctx.supabase
        .from('order_items')
        .select('id, product_id, qty, product_name_snapshot, line_total_usd, line_total_bs_snapshot, admin_price_override_usd, admin_price_override_reason, notes, product:products(type, units_per_service)')
        .eq('order_id', orderId)
        .order('id', { ascending: true }),
      ctx.supabase
        .from('payment_reports')
        .select(
          'id, status, reported_currency_code, reported_amount, reported_amount_usd_equivalent, reference_code, notes, created_at'
        )
        .eq('order_id', orderId)
        .order('created_at', { ascending: false }),
      ctx.supabase
        .from('order_timeline_events')
        .select('id, order_id, event_type, event_group, title, message, severity, payload, created_at')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false })
        .limit(80),
      ctx.supabase
        .from('exchange_rates')
        .select('rate_bs_per_usd')
        .eq('is_active', true)
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const items = (itemsResult.data ?? []) as OrderItemRow[];
  const payments = (paymentsResult.data ?? []) as PaymentReportRow[];
  const rawTimeline = dedupeEvents((timelineResult.data ?? []) as RawTimelineEvent[]);

  const timeline: TimelineEvent[] = rawTimeline
    .map((event) => {
      const eventType = normalizeEventType(event);
      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : event.meta && typeof event.meta === 'object' && !Array.isArray(event.meta)
            ? (event.meta as Record<string, unknown>)
            : {};
      const detailLines = buildDetailLines(eventType, payload);

      return {
        id: `${eventType}-${String(event.id ?? '')}`,
        eventType,
        title: eventTitle(eventType, String(event.title || '')),
        message: safeText(event.message, detailLines[0] || fallbackTimelineMessage(eventType)),
        createdAt: String(event.created_at || order.created_at),
        tone: eventTone(eventType),
        detailLines,
        requiresAction: shouldRequireAdvisorAction(eventType, ACTION_EVENT_TYPES.has(eventType), order.status),
      } satisfies TimelineEvent;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const activeBsRate = toSafeNumber(exchangeRateResult.data?.rate_bs_per_usd, 0);
  const { data: financialStateData, error: financialStateError } = await (ctx.supabase as any).rpc(
    'get_order_financial_state',
    {
      p_order_id: orderId,
      p_operation_date: null,
      p_active_bs_rate: activeBsRate > 0 ? activeBsRate : null,
    }
  );
  if (financialStateError) {
    console.warn('get_order_financial_state skipped in advisor order detail', financialStateError.message);
  }
  const financialState = ((financialStateData ?? []) as RawOrderFinancialStateRow[])[0] ?? null;

  const localConfirmedPaidUsd =
    payments
      .filter((paymentReport) => paymentReport.status === 'confirmed')
      .reduce((sum, paymentReport) => sum + Number(paymentReport.reported_amount_usd_equivalent || 0), 0) +
    Number(order.extra_fields?.payment?.client_fund_used_usd || 0);
  const clientFundUsedUsd = toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0);
  const localPendingPaidUsd = payments
    .filter((paymentReport) => paymentReport.status === 'pending')
    .reduce((sum, paymentReport) => sum + Number(paymentReport.reported_amount_usd_equivalent || 0), 0);
  const orderPricing = getOrderMoneySnapshot(order);
  const orderTotalUsd = financialState ? toSafeNumber(financialState.total_usd, orderPricing.totalUsd) : orderPricing.totalUsd;
  const confirmedPaidUsd = financialState
    ? toSafeNumber(financialState.confirmed_paid_usd, 0)
    : localConfirmedPaidUsd;
  const pendingPaidUsd = financialState
    ? toSafeNumber(financialState.pending_reports_usd, 0)
    : localPendingPaidUsd;
  const balanceUsd = financialState
    ? toSafeNumber(financialState.pending_usd, 0)
    : Math.max(0, Number((orderTotalUsd - confirmedPaidUsd).toFixed(2)));
  const reportableBalanceUsd = Math.max(0, Number((balanceUsd - pendingPaidUsd).toFixed(2)));
  const client = order.client && !Array.isArray(order.client) ? order.client : null;
  const clientFundAvailableUsd = Math.max(0, toSafeNumber(client?.fund_balance_usd, 0));
  const fundRequestSuggestedUsd = Number(
    Math.min(clientFundAvailableUsd, reportableBalanceUsd > 0 ? reportableBalanceUsd : balanceUsd).toFixed(2)
  );
  const canRequestClientFund =
    clientFundAvailableUsd > 0.005 &&
    fundRequestSuggestedUsd > 0.005 &&
    order.status !== 'cancelled';
  const contactPhoneRaw = order.receiver_phone?.trim() || client?.phone?.trim() || '';
  const whatsappPhone = normalizePhoneForWhatsApp(contactPhoneRaw);
  const whatsappContactHref = whatsappPhone ? `https://wa.me/${whatsappPhone}` : '';
  const schedule = order.extra_fields?.schedule;
  const payment = order.extra_fields?.payment;
  const deliveryReferenceDate =
    formatCaracasDateOnly(order.extra_fields?.delivery?.completed_at ?? null) ??
    (safeText(schedule?.date, '') || null);
  const moneyAccounts: Array<{
    id: number;
    name: string;
    currencyCode: string;
    isActive: boolean;
    paymentMethodCodes: string[];
  }> = [];
  const totalBs = financialState ? toSafeNumber(financialState.total_bs, orderPricing.totalBs) : orderPricing.totalBs;
  const snapshotBsRate = orderPricing.fxRate > 0 ? orderPricing.fxRate : activeBsRate;
  const localConfirmedPaidBs =
    payments
      .filter((paymentReport) => paymentReport.status === 'confirmed')
      .reduce((sum, paymentReport) => {
        const currency = safeText(paymentReport.reported_currency_code, '').toUpperCase();
        if (currency === 'VES') return sum + toSafeNumber(paymentReport.reported_amount, 0);
        return sum + toSafeNumber(paymentReport.reported_amount_usd_equivalent, 0) * snapshotBsRate;
      }, 0) + toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0) * snapshotBsRate;
  const localPendingPaidBs = payments
    .filter((paymentReport) => paymentReport.status === 'pending')
    .reduce((sum, paymentReport) => {
      const currency = safeText(paymentReport.reported_currency_code, '').toUpperCase();
      if (currency === 'VES') return sum + toSafeNumber(paymentReport.reported_amount, 0);
      return sum + toSafeNumber(paymentReport.reported_amount_usd_equivalent, 0) * snapshotBsRate;
    }, 0);
  const confirmedPaidBs = financialState
    ? toSafeNumber(financialState.confirmed_paid_bs_snapshot, 0)
    : localConfirmedPaidBs;
  const pendingPaidBs = financialState
    ? toSafeNumber(financialState.pending_reports_bs_snapshot, 0)
    : localPendingPaidBs;
  const balanceBs = financialState
    ? toSafeNumber(financialState.pending_bs, 0)
    : totalBs > 0
      ? Math.max(0, Number((totalBs - confirmedPaidBs).toFixed(2)))
      : activeBsRate > 0
        ? Number((balanceUsd * activeBsRate).toFixed(2))
        : 0;
  const reportableBalanceBs = Math.max(0, Number((balanceBs - pendingPaidBs).toFixed(2)));
  const advisorLabel = safeText(
    ctx.user.user_metadata?.full_name ??
      ctx.user.user_metadata?.name ??
      null,
    'Asesor'
  );
  const latestPaymentEvent = timeline.find((event) =>
    ['payment_rejected', 'payment_reported', 'payment_confirmed'].includes(event.eventType)
  );
  const latestReviewEvent = timeline.find((event) =>
    [
      'order_returned_to_review',
      'order_changes_rejected',
      'order_changes_approved',
      'order_reapproved',
      'order_approved',
    ].includes(event.eventType)
  );
  const canReportPayment =
    reportableBalanceUsd > 0.005 &&
    order.status !== 'cancelled';
  const canCorrectOrder =
    ['created', 'queued'].includes(order.status) &&
    (latestReviewEvent?.eventType === 'order_returned_to_review' ||
      latestReviewEvent?.eventType === 'order_changes_rejected' ||
      order.status === 'created' ||
      order.status === 'queued');
  const canDuplicateOrder = true;
  const canCancelOrder =
    ['created', 'queued'].includes(order.status) &&
    confirmedPaidUsd <= 0.005 &&
    pendingPaidUsd <= 0.005 &&
    clientFundUsedUsd <= 0.005;
  const actionableEvents = timeline.filter((event) => event.requiresAction).length;
  const openPaymentOnLoad = resolvedSearchParams.reportPayment === '1';
  const paymentSummary = getPaymentSummary(
    toSafeNumber(orderTotalUsd, 0),
    toSafeNumber(confirmedPaidUsd, 0),
    toSafeNumber(pendingPaidUsd, 0),
    toSafeNumber(balanceUsd, 0),
  );
  const hasPendingFundRequest = timeline.some((event) => event.eventType === 'client_fund_application_requested');
  const detailFxRate = getOrderFxRate(order);
  const phaseIndex = operationalPhaseIndex(order);
  const phaseLabel = operationalPhaseLabel(order);
  const deliveryLabel = schedule?.asap
    ? 'Lo antes posible'
    : `${safeText(schedule?.date, '')} ${safeText(schedule?.time_12, '')}`.trim() || 'Sin horario';
  const shouldHighlightWhatsApp = Boolean(whatsappContactHref) && isMovingOrderStatus(order.status);
  void buildWhatsAppOrderSummary;
  const whatsappSummary = buildCleanWhatsAppOrderSummary({
    order,
    items,
    advisorLabel,
  });

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Orden"
        title={`Orden ${formatOrderDisplayNumber(order.id)}`}
        description={client?.full_name?.trim() || 'Cliente sin nombre'}
      />

      <SectionCard
        title="Seguimiento"
        subtitle="Fase actual, cobro y acciones principales."
      >
        <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Fase operativa</div>
              <div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#F5F7FB]">{phaseLabel}</div>
            </div>
            <StatusBadge label={phaseLabel} tone={statusTone(order.status)} />
          </div>

          {operationalPhase(order) === 'cancelled' ? (
            <div className="mt-3 rounded-[12px] bg-[#261114] px-3 py-2 text-xs text-[#F0A6AE]">
              Pedido cancelado.
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-5 gap-1">
              {OPERATIONAL_PHASES.map((phase, index) => (
                <div
                  key={`${order.id}-${phase.key}`}
                  className={[
                    'h-1.5 rounded-full',
                    index <= phaseIndex ? 'bg-[#F0D000]' : 'bg-[#252B38]',
                  ].join(' ')}
                />
              ))}
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-[14px] bg-[#12151d] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[#8B93A7]">Entrega</div>
              <div className="mt-1 truncate font-medium text-[#F5F7FB]">{deliveryLabel}</div>
            </div>
            <div className="rounded-[14px] bg-[#12151d] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[#8B93A7]">Cobro</div>
              <div className="mt-1 truncate font-medium text-[#F5F7FB]">{paymentSummary.label}</div>
            </div>
            <div className="rounded-[14px] bg-[#12151d] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[#8B93A7]">Tipo</div>
              <div className="mt-1 font-medium text-[#F5F7FB]">{order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</div>
            </div>
            <div className="rounded-[14px] bg-[#12151d] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[#8B93A7]">Total</div>
              <div className="mt-1 font-semibold text-[#F0D000]">
                {formatBs(orderPricing.totalBs)} / {formatUsd(orderPricing.totalUsd)}
              </div>
            </div>
          </div>

          {(orderPricing.discountEnabled || orderPricing.hasInvoice) ? (
            <div className="mt-3 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs leading-5 text-[#AAB2C5]">
              <div className="flex items-center justify-between gap-3">
                <span>Subtotal</span>
                <span>{formatBs(orderPricing.subtotalBs)} / {formatUsd(orderPricing.subtotalUsd)}</span>
              </div>
              {orderPricing.discountEnabled ? (
                <div className="flex items-center justify-between gap-3 text-[#F7DA66]">
                  <span>Descuento{orderPricing.discountPct > 0 ? ` (${orderPricing.discountPct}%)` : ''}</span>
                  <span>-{formatBs(orderPricing.discountAmountBs)} / -{formatUsd(orderPricing.discountAmountUsd)}</span>
                </div>
              ) : null}
              {(orderPricing.discountEnabled || orderPricing.hasInvoice) ? (
                <div className="flex items-center justify-between gap-3">
                  <span>Subtotal neto</span>
                  <span>{formatBs(orderPricing.subtotalAfterDiscountBs)} / {formatUsd(orderPricing.subtotalAfterDiscountUsd)}</span>
                </div>
              ) : null}
              {orderPricing.hasInvoice ? (
                <div className="flex items-center justify-between gap-3 text-sky-300">
                  <span>IVA{orderPricing.invoiceTaxPct > 0 ? ` (${orderPricing.invoiceTaxPct}%)` : ''}</span>
                  <span>+{formatBs(orderPricing.invoiceTaxAmountBs)} / +{formatUsd(orderPricing.invoiceTaxAmountUsd)}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-1.5">
            <StatusBadge label={paymentSummary.label} tone={paymentSummary.tone} />
            {actionableEvents > 0 ? (
              <StatusBadge label={`${actionableEvents} por atender`} tone="warning" />
            ) : null}
            {schedule?.asap ? <StatusBadge label="Lo antes posible" tone="warning" /> : null}
          </div>
        </div>

        <div className="mt-3">
          <OrderDetailActions
            orderId={order.id}
            balanceUsd={toSafeNumber(reportableBalanceUsd, 0)}
            balanceBs={toSafeNumber(reportableBalanceBs, 0)}
            canCorrectOrder={canCorrectOrder}
            canDuplicateOrder={canDuplicateOrder}
            canReportPayment={canReportPayment}
            canRequestClientFund={canRequestClientFund}
            canCancelOrder={canCancelOrder}
            clientFundAvailableUsd={clientFundAvailableUsd}
            fundRequestSuggestedUsd={fundRequestSuggestedUsd}
            hasPendingFundRequest={hasPendingFundRequest}
            paymentMethod={orderPaymentMethod || null}
            moneyAccounts={moneyAccounts}
            activeBsRate={activeBsRate}
            snapshotBsRate={snapshotBsRate}
            deliveryReferenceDate={deliveryReferenceDate}
            whatsappSummary={whatsappSummary}
            whatsappContactHref={whatsappContactHref}
            preferWhatsApp={shouldHighlightWhatsApp}
            initialReportBoxOpen={openPaymentOnLoad}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Cliente y agenda"
        subtitle={formatDateTime(order.created_at)}
      >
        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Orden</span>
            <span className="text-[#F5F7FB]">{formatOrderDisplayNumber(order.id)}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Cliente</span>
            <span className="max-w-[60%] truncate text-right text-[#F5F7FB]">
              {client?.full_name?.trim() || 'Sin nombre'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Telefono</span>
            {whatsappContactHref ? (
              <a
                href={whatsappContactHref}
                target="_blank"
                rel="noreferrer"
                className="text-[#F0D000] underline underline-offset-2"
              >
                {contactPhoneRaw}
              </a>
            ) : (
              <span className="text-[#F5F7FB]">{client?.phone?.trim() || 'Sin telefono'}</span>
            )}
          </div>
        </div>
      </SectionCard>

      {order.extra_fields?.documents?.has_invoice ? (
        <SectionCard title="Factura" subtitle="Datos que acompanan el resumen y el cobro.">
          <div className="grid gap-2 text-sm text-[#AAB2C5]">
            <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <span>Razon social</span>
              <span className="max-w-[60%] truncate text-right text-[#F5F7FB]">
                {order.extra_fields.documents.invoice_snapshot?.company_name?.trim() || 'Sin dato'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <span>RIF/Cedula</span>
              <span className="max-w-[60%] truncate text-right text-[#F5F7FB]">
                {order.extra_fields.documents.invoice_snapshot?.tax_id?.trim() || 'Sin dato'}
              </span>
            </div>
            <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Direccion fiscal</div>
              <div className="mt-1 text-[#F5F7FB]">
                {order.extra_fields.documents.invoice_snapshot?.address?.trim() || 'Sin direccion fiscal'}
              </div>
            </div>
            {order.extra_fields.documents.invoice_data_note?.trim() ? (
              <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Nota factura</div>
                <div className="mt-1 text-[#F5F7FB]">{order.extra_fields.documents.invoice_data_note.trim()}</div>
              </div>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Entrega y notas" subtitle="Lectura rapida de operacion.">
        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Direccion</div>
            <div className="mt-1 text-[#F5F7FB]">
              {order.fulfillment === 'delivery'
                ? order.delivery_address?.trim() || 'Sin direccion'
                : 'Retiro en tienda'}
            </div>
          </div>
          <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Recibe</div>
            <div className="mt-1 text-[#F5F7FB]">
              {[order.receiver_name?.trim(), order.receiver_phone?.trim()]
                .filter(Boolean)
                .join(' | ') || 'Sin datos adicionales'}
            </div>
          </div>
          <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">GPS</div>
            <div className="mt-1 break-all text-[#F5F7FB]">
              {safeText(order.extra_fields?.delivery?.gps_url, 'Sin enlace')}
            </div>
          </div>
          <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Nota</div>
            <div className="mt-1 text-[#F5F7FB]">{order.notes?.trim() || 'Sin notas adicionales.'}</div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Pedido" subtitle={`${items.length} items cargados`}>
        {items.length === 0 ? (
          <EmptyBlock title="Sin items" detail="Todavia no hay productos visibles en esta orden." />
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => (
              <article
                key={item.id}
                className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#F5F7FB]">
                      {safeText(item.product_name_snapshot, 'Item')}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">Cantidad: {Number(item.qty || 0)}</div>
                  </div>
                  <div className="font-medium text-[#F0D000]">{formatBs(getLineTotalBs(item, detailFxRate))}</div>
                </div>
                {item.notes?.trim() ? (
                  <div className="mt-2 whitespace-pre-line rounded-[14px] bg-[#12151d] px-3 py-2 text-xs leading-5 text-[#AAB2C5]">
                    {item.notes.trim()}
                  </div>
                ) : null}
                {item.admin_price_override_usd != null ? (
                  <div className="mt-2 rounded-[14px] border border-[#554416] bg-[#161407] px-3 py-2 text-xs leading-5 text-[#F7DA66]">
                    Ajuste admin aplicado
                    {item.admin_price_override_reason?.trim() ? `: ${item.admin_price_override_reason.trim()}` : '.'}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Pago" subtitle="Estado de cobro y reportes.">
        <div className="mb-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Estado de pago</div>
              <div className="mt-1 text-base font-semibold text-[#F5F7FB]">{paymentSummary.label}</div>
              <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">{paymentSummary.detail}</div>
            </div>
            <StatusBadge label={paymentSummary.label} tone={paymentSummary.tone} />
          </div>
        </div>

        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Metodo</span>
            <span className="text-[#F5F7FB]">{safeText(payment?.method, 'Sin definir')}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Moneda</span>
            <span className="text-[#F5F7FB]">{safeText(payment?.currency, 'Sin definir')}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Abonado</span>
            <span className="text-[#F5F7FB]">{formatUsd(confirmedPaidUsd)}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Por validar</span>
            <span className="text-[#F5F7FB]">{formatUsd(pendingPaidUsd)}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Saldo</span>
            <span className="font-semibold text-[#F0D000]">{formatUsd(balanceUsd)}</span>
          </div>
          {balanceBs > 0 ? (
            <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <span>Saldo Bs</span>
              <span className="font-semibold text-[#F0D000]">{formatBs(balanceBs)}</span>
            </div>
          ) : null}
          {payment?.notes ? (
            <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Nota de pago</div>
              <div className="mt-1 text-[#F5F7FB]">{payment.notes}</div>
            </div>
          ) : null}
        </div>

        {payments.length > 0 || clientFundUsedUsd > 0.005 ? (
          <div className="mt-3 space-y-2.5">
            {clientFundUsedUsd > 0.005 ? (
              <article className="rounded-[18px] border border-emerald-500/25 bg-[#0D1712] px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">
                      Fondo aplicado · {formatUsd(clientFundUsedUsd)}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">
                      Saldo a favor debitado del fondo del cliente.
                    </div>
                  </div>
                  <StatusBadge label="Aplicado" tone="success" />
                </div>
                <div className="mt-2 grid gap-1 text-xs leading-5 text-[#AAB2C5]">
                  <div>Tipo: Fondo del cliente</div>
                  <div>Este monto ya cuenta como abonado en el saldo de la orden.</div>
                </div>
              </article>
            ) : null}

            {payments.map((paymentReport) => (
              <article
                key={paymentReport.id}
                className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">
                      {safeText(paymentReport.reported_currency_code, 'USD')}{' '}
                      {formatUsd(paymentReport.reported_amount_usd_equivalent)}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">
                      {formatDateTime(paymentReport.created_at)}
                    </div>
                  </div>
                  <StatusBadge
                    label={paymentLabel(paymentReport.status)}
                    tone={paymentTone(paymentReport.status)}
                  />
                </div>
                <div className="mt-2 grid gap-1 text-xs leading-5 text-[#AAB2C5]">
                  <div>
                    Monto reportado: {safeText(paymentReport.reported_currency_code, 'USD')}{' '}
                    {safeText(paymentReport.reported_amount, '0')}
                  </div>
                  <div>Referencia: {paymentReport.reference_code?.trim() || 'Sin referencia'}</div>
                  <div>{paymentReport.notes?.trim() || 'Sin nota adicional.'}</div>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Timeline" subtitle="Historial del pedido y eventos del proceso.">
        {timeline.length === 0 ? (
          <EmptyBlock
            title="Sin historial todavia"
            detail="Cuando esta orden reciba movimientos, el seguimiento aparecera aqui."
          />
        ) : (
          <div className="space-y-2.5">
            {timeline.map((event) => (
              <article
                key={event.id}
                className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#F5F7FB]">{event.title}</div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{formatDateTime(event.createdAt)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <StatusBadge label={event.title} tone={event.tone} />
                    {event.requiresAction ? (
                      <StatusBadge label="Requiere accion" tone="warning" />
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">{event.message}</div>
                {event.detailLines.length > 0 ? (
                  <div className="mt-2 grid gap-1 text-xs leading-5 text-[#AAB2C5]">
                    {event.detailLines.map((line) => (
                      <div key={`${event.id}-${line}`}>{line}</div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

