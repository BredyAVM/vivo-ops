import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../../advisor-ui';
import OrderDetailActions from './OrderDetailActions';

type PageParams = Promise<{
  id: string;
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
  qty: number | string;
  product_name_snapshot: string | null;
  line_total_usd: number | string | null;
  notes: string | null;
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

const ACTION_EVENT_TYPES = new Set([
  'order_returned_to_review',
  'order_changes_rejected',
  'payment_rejected',
]);

function safeText(value: unknown, fallback = 'Sin dato') {
  const text = String(value ?? '').trim();
  return text || fallback;
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

function lineTextWhatsAppStyle(item: OrderItemRow) {
  return `• ${Number(item.qty || 0)} ${safeText(item.product_name_snapshot, 'Item')}: ${formatUsd(item.line_total_usd)}`;
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

function eventTitle(eventType: string, fallbackTitle: string) {
  const titles: Record<string, string> = {
    order_approved: 'Orden aprobada',
    order_returned_to_review: 'Orden devuelta',
    order_reapproved: 'Orden re-aprobada',
    order_changes_rejected: 'Cambios rechazados',
    order_changes_approved: 'Cambios aprobados',
    order_sent_to_kitchen: 'Enviada a cocina',
    kitchen_taken: 'Cocina tomo la orden',
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

export default async function AdvisorOrderDetailPage({ params }: { params: PageParams }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const resolved = await params;
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

  const [itemsResult, paymentsResult, timelineResult, legacyResult, moneyAccountsResult] =
    await Promise.all([
      ctx.supabase
        .from('order_items')
        .select('id, qty, product_name_snapshot, line_total_usd, notes')
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
    ]);

  const items = (itemsResult.data ?? []) as OrderItemRow[];
  const payments = (paymentsResult.data ?? []) as PaymentReportRow[];
  const rawTimeline = [
    ...((timelineResult.data ?? []) as RawTimelineEvent[]),
    ...((legacyResult.data ?? []) as RawTimelineEvent[]),
  ];

  const timeline: TimelineEvent[] = rawTimeline
    .map((event) => {
      const eventType = safeText(event.event_type ?? event.event, '');
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
        message: safeText(event.message, detailLines[0] || 'Sin detalle adicional.'),
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
  const schedule = order.extra_fields?.schedule;
  const payment = order.extra_fields?.payment;
  const moneyAccounts = ((moneyAccountsResult.data ?? []) as MoneyAccountRow[]).map((account) => ({
    id: Number(account.id),
    name: safeText(account.name, 'Cuenta'),
    currencyCode: safeText(account.currency_code, 'USD'),
    isActive: Boolean(account.is_active),
  }));
  const advisorLabel = safeText(
    ctx.user.user_metadata?.full_name ??
      ctx.user.user_metadata?.name ??
      ctx.user.email?.split('@')[0],
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
  const canRetryPayment = latestPaymentEvent?.eventType === 'payment_rejected' && balanceUsd > 0.005;
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
  const actionableEvents = timeline.filter((event) => event.requiresAction).length;
  const whatsappSummary = buildWhatsAppOrderSummary({
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
        action={
          <Link
            href="/app/advisor/orders"
            className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
          >
            Volver
          </Link>
        }
      />

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
            <span className="text-[#F5F7FB]">{client?.phone?.trim() || 'Sin telefono'}</span>
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

      <SectionCard
        title="Acciones"
        subtitle="Desde aqui corriges el pedido o vuelves a reportar el pago cuando haga falta."
      >
        <OrderDetailActions
          orderId={order.id}
          balanceUsd={toSafeNumber(balanceUsd, 0)}
          canCorrectOrder={canCorrectOrder}
          canRetryPayment={canRetryPayment}
          moneyAccounts={moneyAccounts}
          whatsappSummary={whatsappSummary}
        />
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
          <EmptyBlock title="Sin items" detail="Esta orden no tiene items visibles." />
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
            detail="Cuando esta orden reciba eventos, apareceran aqui."
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

