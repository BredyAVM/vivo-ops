import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type SearchParams = Promise<{
  day?: string;
  bucket?: string;
}>;

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string;
  created_at: string;
  delivery_address: string | null;
  notes: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
    payment?: {
      client_fund_used_usd?: number | string | null;
    } | null;
  } | null;
  client: { full_name: string | null; phone: string | null } | null;
};

type RawOrderRow = Omit<OrderRow, 'client'> & {
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type PaymentRow = {
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reported_amount_usd_equivalent: number | string;
};

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function formatDayHeader(dayKey: string) {
  return new Date(`${dayKey}T12:00:00-04:00`).toLocaleDateString('es-VE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Caracas',
  });
}

function getDateKey(date: Date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function getIsoDayKey(value: string) {
  return new Date(value).toLocaleDateString('en-CA', {
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

function tone(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'created' || status === 'queued' || status === 'ready') return 'warning';
  if (status === 'delivered') return 'success';
  if (status === 'cancelled') return 'danger';
  return 'neutral';
}

function isDayKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getAgendaDayKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const scheduledDay = order.extra_fields?.schedule?.date;
  return isDayKey(scheduledDay) ? String(scheduledDay) : getIsoDayKey(order.created_at);
}

function getAgendaTime24(order: Pick<OrderRow, 'extra_fields'>) {
  return String(order.extra_fields?.schedule?.time_24 || '').trim();
}

function getAgendaSortKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const dayKey = getAgendaDayKey(order);
  const timeKey = order.extra_fields?.schedule?.asap ? '00:00' : getAgendaTime24(order) || '99:99';

  return `${dayKey}|${timeKey}|${order.created_at}`;
}

function getAgendaTimeLabel(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';

  const time12 = String(schedule?.time_12 || '').trim();
  return time12 || formatDate(order.created_at);
}

function isOpenStatus(status: string) {
  return !['delivered', 'cancelled'].includes(status);
}

function isOverdueOrder(order: OrderRow, selectedDayKey: string) {
  if (!isOpenStatus(order.status)) return false;
  if (selectedDayKey !== getDateKey(new Date())) return false;
  if (order.extra_fields?.schedule?.asap) return false;

  const time24 = getAgendaTime24(order);
  if (!time24) return false;

  const now = new Date();
  const currentKey = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return time24 < currentKey;
}

function getPaymentState(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
  const reports = paymentReportsByOrderId.get(order.id) ?? [];
  const totalUsd = toSafeNumber(order.total_usd, 0);
  const clientFundUsd = toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0);
  const confirmedUsd =
    reports
      .filter((report) => report.status === 'confirmed')
      .reduce((sum, report) => sum + toSafeNumber(report.reported_amount_usd_equivalent, 0), 0) +
    clientFundUsd;
  const pendingUsd = reports
    .filter((report) => report.status === 'pending')
    .reduce((sum, report) => sum + toSafeNumber(report.reported_amount_usd_equivalent, 0), 0);
  const balanceUsd = Math.max(0, Number((totalUsd - confirmedUsd).toFixed(2)));
  const reportableBalanceUsd = Math.max(0, Number((totalUsd - confirmedUsd - pendingUsd).toFixed(2)));

  return {
    confirmedUsd,
    pendingUsd,
    balanceUsd,
    reportableBalanceUsd,
    hasRejected: reports.some((report) => report.status === 'rejected'),
  };
}

function isUnpaidOrder(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
  if (order.status === 'cancelled') return false;
  return getPaymentState(order, paymentReportsByOrderId).balanceUsd > 0.005;
}

function getGroupKey(
  order: OrderRow,
  paymentReportsByOrderId: Map<number, PaymentRow[]>,
  selectedDayKey: string,
) {
  if (isOverdueOrder(order, selectedDayKey)) return 'overdue';
  if (isUnpaidOrder(order, paymentReportsByOrderId)) return 'unpaid';
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) return 'asap';
  if (order.status === 'delivered' || order.status === 'cancelled') return 'closed';
  return 'upcoming';
}

type OperationalPhase = 'new' | 'kitchen' | 'ready' | 'route' | 'closed' | 'cancelled';

const OPERATIONAL_PHASES: Array<{ key: OperationalPhase; label: string }> = [
  { key: 'new', label: 'Nuevas' },
  { key: 'kitchen', label: 'Cocina' },
  { key: 'ready', label: 'Listas' },
  { key: 'route', label: 'Camino' },
  { key: 'closed', label: 'Entregadas' },
];

function operationalPhase(order: OrderRow): OperationalPhase {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'delivered') return 'closed';
  if (order.status === 'out_for_delivery') return 'route';
  if (order.status === 'ready') return 'ready';
  if (order.status === 'confirmed' || order.status === 'in_kitchen') return 'kitchen';
  return 'new';
}

function operationalPhaseIndex(order: OrderRow) {
  const phase = operationalPhase(order);
  if (phase === 'cancelled') return 0;
  return Math.max(0, OPERATIONAL_PHASES.findIndex((item) => item.key === phase));
}

function operationalPhaseLabel(order: OrderRow) {
  if (order.status === 'ready' && order.fulfillment === 'pickup') return 'Lista para retiro';
  if (order.status === 'ready') return 'Lista para salir';
  if (order.status === 'out_for_delivery') return 'En camino';
  return statusLabel(order.status);
}

function phaseLabelForBucket(bucket: string) {
  if (!bucket.startsWith('phase_')) return null;
  const phaseKey = bucket.replace('phase_', '') as OperationalPhase;
  return OPERATIONAL_PHASES.find((phase) => phase.key === phaseKey)?.label ?? null;
}

function titleForBucket(bucket: string) {
  const phaseLabel = phaseLabelForBucket(bucket);
  if (phaseLabel) return phaseLabel;
  if (bucket === 'overdue') return 'Atrasadas';
  if (bucket === 'open') return 'Pendientes';
  if (bucket === 'unpaid') return 'Sin pago';
  if (bucket === 'delivered') return 'Entregadas';
  if (bucket === 'asap') return 'Lo antes posible';
  if (bucket === 'priority') return 'Prioridad del dia';
  return 'Pedidos del dia';
}

function subtitleForBucket(bucket: string) {
  const phaseLabel = phaseLabelForBucket(bucket);
  if (phaseLabel) return `Pedidos del dia en fase ${phaseLabel.toLowerCase()}.`;
  if (bucket === 'overdue') return 'Ordenes con hora operativa atrasada.';
  if (bucket === 'open') return 'Ordenes que siguen activas.';
  if (bucket === 'unpaid') return 'Pendientes de cobro o con pago rechazado.';
  if (bucket === 'delivered') return 'Cierres del dia activo.';
  if (bucket === 'asap') return 'Urgencias sin hora fija.';
  if (bucket === 'priority') return 'Lectura por prioridad operativa.';
  return 'Agenda compacta del dia activo.';
}

function paymentBadge(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
  if (order.status === 'cancelled') return null;
  const state = getPaymentState(order, paymentReportsByOrderId);
  if (state.hasRejected) return { label: 'Pago rechazado', tone: 'danger' as const };
  if (state.balanceUsd <= 0.005) return { label: 'Pagado', tone: 'success' as const };
  if (state.pendingUsd > 0.005 && state.reportableBalanceUsd <= 0.005) {
    return { label: 'Pago por validar', tone: 'warning' as const };
  }
  if (state.confirmedUsd > 0.005 || state.pendingUsd > 0.005) {
    return {
      label: `Saldo ${formatUsd(state.reportableBalanceUsd > 0.005 ? state.reportableBalanceUsd : state.balanceUsd)}`,
      tone: 'warning' as const,
    };
  }
  return { label: 'Cobro pendiente', tone: 'warning' as const };
}

function attentionLabels(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>, selectedDayKey: string) {
  const labels: Array<{ label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = [];
  const payment = getPaymentState(order, paymentReportsByOrderId);

  if (isOverdueOrder(order, selectedDayKey)) labels.push({ label: 'Hora atrasada', tone: 'danger' });
  if (payment.hasRejected) labels.push({ label: 'Pago rechazado', tone: 'danger' });
  else if (payment.balanceUsd > 0.005) labels.push({ label: 'Cobro pendiente', tone: 'warning' });
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) {
    labels.push({ label: 'Lo antes posible', tone: 'warning' });
  }
  if (order.status === 'created' || order.status === 'queued') {
    labels.push({ label: 'Pendiente de avance', tone: 'neutral' });
  }

  return labels;
}

export default async function AdvisorOrdersPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const bucket = params.bucket ?? 'priority';

  const { data: ordersData } = await ctx.supabase
    .from('orders')
    .select(
      'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, notes, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
    )
    .eq('attributed_advisor_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(300);

  const orders = ((ordersData ?? []) as RawOrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));

  const orderIds = orders.map((order) => order.id);
  const { data: paymentsData } = orderIds.length
    ? await ctx.supabase
        .from('payment_reports')
        .select('order_id, status, reported_amount_usd_equivalent')
        .in('order_id', orderIds)
    : { data: [] };
  const paymentReports = (paymentsData ?? []) as PaymentRow[];

  const paymentReportsByOrderId = new Map<number, PaymentRow[]>();
  for (const report of paymentReports) {
    const current = paymentReportsByOrderId.get(report.order_id) ?? [];
    current.push(report);
    paymentReportsByOrderId.set(report.order_id, current);
  }

  const dayOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  const filteredOrders = dayOrders.filter((order) => {
    const unpaid = isUnpaidOrder(order, paymentReportsByOrderId);
    const overdue = isOverdueOrder(order, selectedDayKey);
    const asap = Boolean(order.extra_fields?.schedule?.asap) && isOpenStatus(order.status);

    if (bucket === 'overdue') return overdue;
    if (bucket === 'open') return isOpenStatus(order.status);
    if (bucket === 'unpaid') return unpaid;
    if (bucket === 'delivered') return order.status === 'delivered';
    if (bucket === 'asap') return asap;
    if (bucket.startsWith('phase_')) return operationalPhase(order) === bucket.replace('phase_', '');
    return true;
  });

  const grouped = {
    overdue: filteredOrders.filter((order) => getGroupKey(order, paymentReportsByOrderId, selectedDayKey) === 'overdue'),
    unpaid: filteredOrders.filter((order) => getGroupKey(order, paymentReportsByOrderId, selectedDayKey) === 'unpaid'),
    asap: filteredOrders.filter((order) => getGroupKey(order, paymentReportsByOrderId, selectedDayKey) === 'asap'),
    upcoming: filteredOrders.filter((order) => getGroupKey(order, paymentReportsByOrderId, selectedDayKey) === 'upcoming'),
    closed: filteredOrders.filter((order) => getGroupKey(order, paymentReportsByOrderId, selectedDayKey) === 'closed'),
  };

  const visibleOrders =
    bucket === 'priority'
      ? [...filteredOrders].sort((a, b) => {
          const attentionDiff =
            attentionLabels(b, paymentReportsByOrderId, selectedDayKey).length -
            attentionLabels(a, paymentReportsByOrderId, selectedDayKey).length;
          if (attentionDiff !== 0) return attentionDiff;
          return getAgendaSortKey(a).localeCompare(getAgendaSortKey(b));
        })
      : filteredOrders;
  const bucketLinks = [
    { key: 'priority', label: 'Prioridad' },
    { key: 'phase_new', label: 'Nuevas' },
    { key: 'phase_kitchen', label: 'Cocina' },
    { key: 'phase_ready', label: 'Listas' },
    { key: 'phase_route', label: 'Camino' },
    { key: 'phase_closed', label: 'Entregadas' },
    { key: 'overdue', label: 'Atrasadas' },
    { key: 'unpaid', label: 'Cobro' },
    { key: 'asap', label: 'ASAP' },
    { key: 'open', label: 'Activas' },
  ] as const;

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Agenda"
        title={titleForBucket(bucket)}
        description={`${subtitleForBucket(bucket)} ${formatDayHeader(selectedDayKey)}.`}
        action={
          <Link
            href={`/app/advisor?day=${selectedDayKey}`}
            className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
          >
            Volver
          </Link>
        }
      />

      <section className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {bucketLinks.map((item) => {
            const active = bucket === item.key;
            return (
              <Link
                key={item.key}
                href={`/app/advisor/orders?day=${selectedDayKey}&bucket=${item.key}`}
                className={[
                  'inline-flex h-10 items-center rounded-[14px] border px-3.5 text-sm font-medium transition',
                  active
                    ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                    : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </section>

      <SectionCard
        title="Ordenes"
        subtitle="Fase operativa, cobro y alertas del dia."
        action={visibleOrders.length > 0 ? <StatusBadge label={String(visibleOrders.length)} tone="neutral" /> : null}
      >
        {visibleOrders.length === 0 ? (
          <EmptyBlock title="Sin ordenes" detail="No hay elementos en esta vista para el dia activo." />
        ) : (
          <div className="space-y-2.5">
            {visibleOrders.map((order) => {
              const unpaid = isUnpaidOrder(order, paymentReportsByOrderId);
              const paymentState = getPaymentState(order, paymentReportsByOrderId);
              const paymentStatus = paymentBadge(order, paymentReportsByOrderId);
              const canReportMorePayment = unpaid && paymentState.reportableBalanceUsd > 0.005;
              const phaseIndex = operationalPhaseIndex(order);
              const labels = attentionLabels(order, paymentReportsByOrderId, selectedDayKey).filter(
                (label) => label.label !== 'Cobro pendiente'
              );

              return (
                <article
                  key={order.id}
                  className="advisor-fade-in rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                >
                  <Link href={`/app/advisor/orders/${order.id}`} className="block">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#F5F7FB]">
                          {order.client?.full_name?.trim() || order.order_number}
                        </div>
                        <div className="mt-1 truncate text-xs text-[#8B93A7]">
                          {order.order_number} · {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-[#F5F7FB]">{getAgendaTimeLabel(order)}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{formatUsd(order.total_usd)}</div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <StatusBadge label={operationalPhaseLabel(order)} tone={tone(order.status)} />
                      {paymentStatus ? <StatusBadge label={paymentStatus.label} tone={paymentStatus.tone} /> : null}
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

                    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                      <span className="min-w-0 truncate">
                        {order.fulfillment === 'delivery'
                          ? order.delivery_address?.trim() || 'Delivery sin direccion'
                          : 'Retiro en tienda'}
                      </span>
                      {labels.length > 0 ? (
                        <span className="shrink-0 text-[#F7DA66]">{labels[0]?.label}</span>
                      ) : null}
                    </div>
                  </Link>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {isOpenStatus(order.status) ? (
                      <Link
                        href={`/app/advisor/new?fromOrder=${order.id}`}
                        className="inline-flex h-9 items-center justify-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                      >
                        Modificar
                      </Link>
                    ) : (
                      <Link
                        href={`/app/advisor/new?duplicateFrom=${order.id}`}
                        className="inline-flex h-9 items-center justify-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                      >
                        Repetir
                      </Link>
                    )}
                    {unpaid ? (
                      <Link
                        href={
                          canReportMorePayment
                            ? `/app/advisor/orders/${order.id}?reportPayment=1`
                            : `/app/advisor/orders/${order.id}`
                        }
                        className="inline-flex h-9 items-center justify-center rounded-[12px] bg-[#F0D000] px-3 text-xs font-semibold text-[#17191E]"
                      >
                        {canReportMorePayment ? 'Reportar pago' : 'Ver pago'}
                      </Link>
                    ) : (
                      <Link
                        href={`/app/advisor/orders/${order.id}`}
                        className="inline-flex h-9 items-center justify-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                      >
                        Abrir
                      </Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
