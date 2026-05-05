import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../../advisor-ui';
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
    delivery?: {
      gps_url?: string | null;
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
      total_bs?: number | string | null;
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

type MoneyAccountRow = {
  id: number;
  name: string | null;
  currency_code: string | null;
  is_active: boolean | null;
};

type MoneyAccountPaymentRuleRow = {
  money_account_id: number | string | null;
  payment_method_code: string | null;
  can_view_account: boolean | null;
  can_share_with_client: boolean | null;
  can_report_payment: boolean | null;
  is_active: boolean | null;
};

const ADVISOR_REPORT_PAYMENT_METHODS = new Set(['payment_mobile', 'transfer', 'zelle']);

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

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    created: 'Por confirmar',
    queued: 'En cola',
    confirmed: 'En cocina',
    in_kitchen: 'Preparando',
    ready: 'Lista para salir',
    out_for_delivery: 'En camino',
    delivered: 'Entregada',
    cancelled: 'Cancelada',
  };
  return labels[status] ?? status;
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
  const labels: Record<string, string> = {
    pending: 'pendiente',
    payment_mobile: 'pago movil',
    transfer: 'transferencia',
    cash_usd: 'efectivo USD',
    cash_ves: 'efectivo Bs',
    zelle: 'zelle',
    mixed: 'mixto',
  };

  const key = String(value || '').trim();
  return labels[key] || 'pendiente';
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
  if (balanceUsd <= 0.005) {
    return {
      label: 'Pagado',
      tone: 'success' as const,
      detail: `Cobro completo por ${formatUsd(totalUsd)}.`,
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

function lineTextWhatsAppStyle(item: OrderItemRow) {
  const relatedProduct = Array.isArray(item.product) ? item.product[0] ?? null : item.product;
  const normalizedName = safeText(item.product_name_snapshot, 'Item');
  const isDelivery = normalizedName.toLowerCase().startsWith('delivery');
  const unitsPerService = Math.max(0, Number(relatedProduct?.units_per_service || 0));

  if (isDelivery) {
    return `- ${formatQuantityLabel(item.qty)} ${normalizedName}: ${formatUsd(item.line_total_usd)}`;
  }

  if (unitsPerService > 0) {
    const cleanName = normalizedName.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    const units = Number((Number(item.qty || 0) * unitsPerService).toFixed(2));
    const servicePrefix = relatedProduct?.type === 'service' ? 'Serv. ' : '';
    return `- ${formatQuantityLabel(item.qty)} ${servicePrefix}${cleanName} (${formatQuantityLabel(units)} und): ${formatUsd(item.line_total_usd)}`;
  }

  return `- ${formatQuantityLabel(item.qty)} ${normalizedName}: ${formatUsd(item.line_total_usd)}`;
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
  const totalBs = order.extra_fields?.pricing?.total_bs;

  parts.push('*Presupuesto*');
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
      parts.push(lineTextWhatsAppStyle(item));
      for (const detail of getVisibleEditableDetailLines(item.notes)) {
        parts.push(`- ${detail}`);
      }
    }
  }

  parts.push('');
  parts.push(
    `*TOTAL:* ${totalBs != null ? `${formatBs(totalBs)} / ` : ''}${formatUsd(order.total_usd)}`,
  );
  parts.push('');
  parts.push(`*Entrega:* ${order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`);
  parts.push(`*Dia de entrega:* ${deliveryText(order.extra_fields?.schedule)}`);

  if (order.fulfillment === 'delivery' && order.delivery_address?.trim()) {
    parts.push(`*Direccion:* ${order.delivery_address.trim()}`);
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
  const parts: string[] = [];
  const totalBs = order.extra_fields?.pricing?.total_bs;
  const check = '\u2705';
  const primaryBullet = '\u25AA';
  const secondaryBullet = '\u25AB';

  parts.push('*Presupuesto*');
  parts.push('');
  parts.push(`${check} *Asesor:* ${advisorLabel}`);
  parts.push('');
  parts.push(`${check} *Cliente:* ${order.client?.full_name?.trim() || 'Cliente'}`);

  if (order.client?.phone?.trim()) {
    parts.push('');
    parts.push(`${check} *Telefono:* ${order.client.phone.trim()}`);
  }

  parts.push('');
  parts.push(`${check} *Pedido:*`);
  parts.push('');

  if (items.length === 0) {
    parts.push('- Sin items cargados');
  } else {
    for (const item of items) {
      parts.push(lineTextWhatsAppStyle(item).replace(/^- /, `${primaryBullet} `));
      for (const detail of getVisibleEditableDetailLines(item.notes)) {
        parts.push(`   ${secondaryBullet} ${detail}`);
      }
    }
  }

  parts.push('');
  parts.push(`*TOTAL:* ${totalBs != null ? `${formatBs(totalBs)} / ` : ''}${formatUsd(order.total_usd)}`);
  parts.push('');
  parts.push(`${check} *Entrega:* ${order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}`);
  parts.push('');
  parts.push(`${check} *Forma de pago:* ${paymentMethodCopyLabel(order.extra_fields?.payment?.method)}`);
  parts.push('');
  parts.push(`${check} *Estatus de pago:* Pendiente`);
  parts.push('');
  parts.push(`${check} *Dia de entrega:* ${deliveryDayText(order.extra_fields?.schedule)}`);

  const deliveryHour = deliveryHourText(order.extra_fields?.schedule);
  if (deliveryHour) {
    parts.push('');
    parts.push(`${check} *Hora:* ${deliveryHour}`);
  }

  if (order.fulfillment === 'delivery' && order.delivery_address?.trim()) {
    parts.push('');
    parts.push(`${check} *Direccion:* ${order.delivery_address.trim()}`);
  }

  if (order.notes?.trim()) {
    parts.push('');
    parts.push(`*Notas:* ${order.notes.trim()}`);
  }

  return parts.join('\n');
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
  };

  return messages[eventType] || 'Sin detalle adicional.';
}

function eventTone(eventType: string): TimelineEvent['tone'] {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected') return 'danger';
  if (ACTION_EVENT_TYPES.has(eventType) || eventType.includes('delayed')) return 'warning';
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
  const shouldMatchOrderPaymentMethod = ADVISOR_REPORT_PAYMENT_METHODS.has(orderPaymentMethod);

  const [
    itemsResult,
    paymentsResult,
    timelineResult,
    legacyResult,
    moneyAccountsResult,
    moneyAccountRulesResult,
    exchangeRateResult,
  ] = await Promise.all([
      ctx.supabase
        .from('order_items')
        .select('id, product_id, qty, product_name_snapshot, line_total_usd, notes, product:products(type, units_per_service)')
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
        .order('created_at', { ascending: false }),
      ctx.supabase
        .from('order_events')
        .select('id, order_id, event_type, event_group, title, message, severity, payload, created_at, event, meta')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false }),
      ctx.supabase
        .from('money_accounts')
        .select('id, name, currency_code, is_active')
        .eq('is_active', true)
        .order('name', { ascending: true }),
      ctx.supabase
        .from('money_account_payment_rules')
        .select(
          'money_account_id, payment_method_code, can_view_account, can_share_with_client, can_report_payment, is_active'
        )
        .eq('role', 'advisor')
        .eq('is_active', true)
        .eq('can_report_payment', true)
        .in(
          'payment_method_code',
          shouldMatchOrderPaymentMethod ? [orderPaymentMethod] : Array.from(ADVISOR_REPORT_PAYMENT_METHODS)
        ),
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
  const rawTimeline = dedupeEvents([
    ...((timelineResult.data ?? []) as RawTimelineEvent[]),
    ...((legacyResult.data ?? []) as RawTimelineEvent[]),
  ]);

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
        requiresAction: ACTION_EVENT_TYPES.has(eventType),
      } satisfies TimelineEvent;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const confirmedPaidUsd =
    payments
      .filter((paymentReport) => paymentReport.status === 'confirmed')
      .reduce((sum, paymentReport) => sum + Number(paymentReport.reported_amount_usd_equivalent || 0), 0) +
    Number(order.extra_fields?.payment?.client_fund_used_usd || 0);
  const pendingPaidUsd = payments
    .filter((paymentReport) => paymentReport.status === 'pending')
    .reduce((sum, paymentReport) => sum + Number(paymentReport.reported_amount_usd_equivalent || 0), 0);
  const balanceUsd = Math.max(0, Number(order.total_usd || 0) - confirmedPaidUsd);
  const client = order.client && !Array.isArray(order.client) ? order.client : null;
  const contactPhoneRaw = order.receiver_phone?.trim() || client?.phone?.trim() || '';
  const whatsappPhone = normalizePhoneForWhatsApp(contactPhoneRaw);
  const contactName = order.receiver_name?.trim() || client?.full_name?.trim() || 'cliente';
  const whatsappContactHref = whatsappPhone
    ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(`Hola ${contactName}, te escribimos por tu pedido #${order.id} en VIVO OPS.`)}`
    : '';
  const schedule = order.extra_fields?.schedule;
  const payment = order.extra_fields?.payment;
  const advisorReportRules = ((moneyAccountRulesResult.data ?? []) as MoneyAccountPaymentRuleRow[]).filter(
    (rule) =>
      Boolean(rule.is_active) &&
      Boolean(rule.can_report_payment) &&
      ADVISOR_REPORT_PAYMENT_METHODS.has(String(rule.payment_method_code || ''))
  );
  const reportMethodsByAccountId = new Map<number, string[]>();

  for (const rule of advisorReportRules) {
    const accountId = Number(rule.money_account_id || 0);
    const method = String(rule.payment_method_code || '');
    if (!Number.isFinite(accountId) || accountId <= 0 || !ADVISOR_REPORT_PAYMENT_METHODS.has(method)) continue;

    const methods = reportMethodsByAccountId.get(accountId) ?? [];
    if (!methods.includes(method)) methods.push(method);
    reportMethodsByAccountId.set(accountId, methods);
  }

  const moneyAccounts = ((moneyAccountsResult.data ?? []) as MoneyAccountRow[])
    .filter((account) => Boolean(account.is_active) && reportMethodsByAccountId.has(Number(account.id)))
    .map((account) => ({
      id: Number(account.id),
      name: safeText(account.name, 'Cuenta'),
      currencyCode: safeText(account.currency_code, 'USD'),
      isActive: Boolean(account.is_active),
      paymentMethodCodes: reportMethodsByAccountId.get(Number(account.id)) ?? [],
    }));
  const activeBsRate = toSafeNumber(exchangeRateResult.data?.rate_bs_per_usd, 0);
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
    balanceUsd > 0.005 &&
    pendingPaidUsd <= 0.005 &&
    moneyAccounts.length > 0 &&
    order.status !== 'cancelled' &&
    latestPaymentEvent?.eventType !== 'payment_confirmed';
  const canCorrectOrder =
    order.status !== 'delivered' &&
    order.status !== 'cancelled' &&
    (latestReviewEvent?.eventType === 'order_returned_to_review' ||
      latestReviewEvent?.eventType === 'order_changes_rejected' ||
      order.status === 'created' ||
      order.status === 'queued' ||
      order.status === 'confirmed' ||
      order.status === 'in_kitchen' ||
      order.status === 'ready');
  const canDuplicateOrder = order.status !== 'cancelled';
  const actionableEvents = timeline.filter((event) => event.requiresAction).length;
  const openPaymentOnLoad = resolvedSearchParams.reportPayment === '1';
  const paymentSummary = getPaymentSummary(
    toSafeNumber(order.total_usd, 0),
    toSafeNumber(confirmedPaidUsd, 0),
    toSafeNumber(pendingPaidUsd, 0),
    toSafeNumber(balanceUsd, 0),
  );
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
        title={`Orden #${order.id}`}
        description={client?.full_name?.trim() || safeText(order.order_number, 'Sin localizador')}
      />

      <SectionCard
        title="Mover ahora"
        subtitle="Acciones y lectura rapida para operar este pedido desde el telefono."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Estado del pedido</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">{statusLabel(order.status)}</div>
              <StatusBadge label={statusLabel(order.status)} tone={statusTone(order.status)} />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
              {schedule?.asap
                ? 'Entrega lo antes posible.'
                : `${safeText(schedule?.date, '')} ${safeText(schedule?.time_12, '')}`.trim() || 'Sin horario cargado.'}
            </div>
          </div>
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Cobro</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">{paymentSummary.label}</div>
              <StatusBadge label={paymentSummary.label} tone={paymentSummary.tone} />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">{paymentSummary.detail}</div>
          </div>
        </div>
        <div className="mt-3">
          <OrderDetailActions
            orderId={order.id}
            balanceUsd={toSafeNumber(balanceUsd, 0)}
            canCorrectOrder={canCorrectOrder}
            canDuplicateOrder={canDuplicateOrder}
            canReportPayment={canReportPayment}
            moneyAccounts={moneyAccounts}
            activeBsRate={activeBsRate}
            whatsappSummary={whatsappSummary}
            whatsappContactHref={whatsappContactHref}
            preferWhatsApp={shouldHighlightWhatsApp}
            initialReportBoxOpen={openPaymentOnLoad}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Resumen"
        subtitle={formatDateTime(order.created_at)}
        action={
          <div className="flex flex-col items-end gap-1.5">
            <StatusBadge label={statusLabel(order.status)} tone={statusTone(order.status)} />
            {actionableEvents > 0 ? (
              <StatusBadge label={`${actionableEvents} por atender`} tone="warning" />
            ) : null}
          </div>
        }
      >
        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Orden</span>
            <span className="text-[#F5F7FB]">#{order.id}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Localizador</span>
            <span className="max-w-[60%] truncate text-right text-[#F5F7FB]">
              {safeText(order.order_number, 'Sin localizador')}
            </span>
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
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Entrega</span>
            <span className="text-right text-[#F5F7FB]">
              {schedule?.asap
                ? 'Lo antes posible'
                : `${safeText(schedule?.date, '')} ${safeText(schedule?.time_12, '')}`.trim() ||
                  'Sin horario'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Tipo</span>
            <span className="text-[#F5F7FB]">
              {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Total</span>
            <span className="font-semibold text-[#F0D000]">{formatUsd(order.total_usd)}</span>
          </div>
        </div>
      </SectionCard>

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
                  <div className="font-medium text-[#F0D000]">{formatUsd(item.line_total_usd)}</div>
                </div>
                {item.notes?.trim() ? (
                  <div className="mt-2 whitespace-pre-line rounded-[14px] bg-[#12151d] px-3 py-2 text-xs leading-5 text-[#AAB2C5]">
                    {item.notes.trim()}
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
          {payment?.notes ? (
            <div className="rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Nota de pago</div>
              <div className="mt-1 text-[#F5F7FB]">{payment.notes}</div>
            </div>
          ) : null}
        </div>

        {payments.length > 0 ? (
          <div className="mt-3 space-y-2.5">
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

