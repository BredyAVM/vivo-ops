import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import {
  OPERATIONAL_PHASES,
  type OperationalPhase,
  getOperationalPhase,
  getOperationalPhaseIndex,
  getOperationalStatusLabel,
  getPaymentMethodLabel,
} from '@/lib/orders/order-labels';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import AdvisorCalendarStrip from '../AdvisorCalendarStrip';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type SearchParams = Promise<{
  day?: string;
  bucket?: string;
}>;

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  queued_needs_reapproval?: boolean | null;
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string;
  created_at: string;
  delivery_address: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
    payment?: {
      method?: string | null;
      currency?: string | null;
      client_fund_used_usd?: number | string | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
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
  reported_amount: number | string | null;
  reported_currency_code: string | null;
  reported_amount_usd_equivalent: number | string;
};

type PaymentState = {
  confirmedUsd: number;
  confirmedBs: number;
  pendingUsd: number;
  pendingBs: number;
  balanceUsd: number;
  balanceBs: number;
  reportableBalanceUsd: number;
  reportableBalanceBs: number;
  totalBs: number;
  hasRejected: boolean;
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

type TimelineEventRow = {
  order_id: number | string | null;
  event_type: string | null;
  created_at: string | null;
};

const REVIEW_EVENT_TYPES = [
  'order_returned_to_review',
  'order_changes_rejected',
  'order_changes_approved',
  'order_reapproved',
  'order_approved',
] as const;

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function formatBs(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `Bs ${amount.toFixed(2)}` : 'Bs 0.00';
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function paymentMethodLabel(method: string | null | undefined) {
  return getPaymentMethodLabel(method);
}

function getOrderTotalUsd(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalUsd;
}

function getOrderFxRate(order: OrderRow) {
  return getOrderMoneySnapshot(order).fxRate;
}

function getOrderTotalBs(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalBs;
}

function usdToOrderBs(order: OrderRow, amountUsd: number) {
  const fxRate = getOrderFxRate(order);
  return fxRate > 0 ? amountUsd * fxRate : 0;
}

function getPaymentAmountBs(report: PaymentRow, order: OrderRow) {
  const currency = String(report.reported_currency_code || '').toUpperCase();
  if (currency === 'VES') return toSafeNumber(report.reported_amount, 0);
  return usdToOrderBs(order, toSafeNumber(report.reported_amount_usd_equivalent, 0));
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function getDateKey(date: Date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function getCaracasDayRange(dayKey: string) {
  const start = new Date(`${dayKey}T00:00:00-04:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

function getIsoDayKey(value: string) {
  return new Date(value).toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
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

  const currentKey = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Caracas',
  });
  return time24 < currentKey;
}

function getPaymentState(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>): PaymentState {
  const reports = paymentReportsByOrderId.get(order.id) ?? [];
  const totalUsd = getOrderTotalUsd(order);
  const clientFundUsd = toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0);
  let confirmedUsd = clientFundUsd;
  let confirmedBs = usdToOrderBs(order, clientFundUsd);
  let pendingUsd = 0;
  let pendingBs = 0;
  let hasRejected = false;

  for (const report of reports) {
    if (report.status === 'confirmed') {
      confirmedUsd += toSafeNumber(report.reported_amount_usd_equivalent, 0);
      confirmedBs += getPaymentAmountBs(report, order);
    } else if (report.status === 'pending') {
      pendingUsd += toSafeNumber(report.reported_amount_usd_equivalent, 0);
      pendingBs += getPaymentAmountBs(report, order);
    } else if (report.status === 'rejected') {
      hasRejected = true;
    }
  }

  const balanceUsd = Math.max(0, Number((totalUsd - confirmedUsd).toFixed(2)));
  const reportableBalanceUsd = Math.max(0, Number((totalUsd - confirmedUsd - pendingUsd).toFixed(2)));
  const totalBs = getOrderTotalBs(order);
  const balanceBs =
    totalBs > 0 ? Math.max(0, Number((totalBs - confirmedBs).toFixed(2))) : usdToOrderBs(order, balanceUsd);
  const reportableBalanceBs = Math.max(0, Number((balanceBs - pendingBs).toFixed(2)));

  return {
    confirmedUsd,
    confirmedBs,
    pendingUsd,
    pendingBs,
    balanceUsd,
    balanceBs,
    reportableBalanceUsd,
    reportableBalanceBs,
    totalBs,
    hasRejected,
  };
}

function getCanonicalPaymentState(state: RawOrderFinancialStateRow): PaymentState {
  const pendingUsd = toSafeNumber(state.pending_reports_usd, 0);
  const pendingBs = toSafeNumber(state.pending_reports_bs_snapshot, 0);
  const balanceUsd = toSafeNumber(state.pending_usd, 0);
  const balanceBs = toSafeNumber(state.pending_bs, 0);

  return {
    confirmedUsd: toSafeNumber(state.confirmed_paid_usd, 0),
    confirmedBs: toSafeNumber(state.confirmed_paid_bs_snapshot, 0),
    pendingUsd,
    pendingBs,
    balanceUsd,
    balanceBs,
    reportableBalanceUsd: Math.max(0, Number((balanceUsd - pendingUsd).toFixed(2))),
    reportableBalanceBs: Math.max(0, Number((balanceBs - pendingBs).toFixed(2))),
    totalBs: toSafeNumber(state.total_bs, 0),
    hasRejected: toSafeNumber(state.rejected_reports_count, 0) > 0,
  };
}

function getStoredPaymentState(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  return paymentStateByOrderId.get(order.id) ?? {
    confirmedUsd: 0,
    confirmedBs: 0,
    pendingUsd: 0,
    pendingBs: 0,
    balanceUsd: 0,
    balanceBs: 0,
    reportableBalanceUsd: 0,
    reportableBalanceBs: 0,
    totalBs: getOrderTotalBs(order),
    hasRejected: false,
  };
}

function isUnpaidOrder(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  if (order.status === 'cancelled') return false;
  return getStoredPaymentState(order, paymentStateByOrderId).balanceUsd > 0.005;
}

function latestReviewEvent(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
  return reviewEventByOrderId.get(order.id)?.event_type || null;
}

function needsAdvisorReview(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
  if (!isOpenStatus(order.status)) return false;
  return ['order_returned_to_review', 'order_changes_rejected'].includes(
    String(latestReviewEvent(order, reviewEventByOrderId) || '')
  );
}

function needsInitialApproval(order: OrderRow) {
  return order.status === 'created';
}

function needsReapproval(order: OrderRow) {
  return order.status === 'queued' && Boolean(order.queued_needs_reapproval);
}

function operationalPhase(order: OrderRow): OperationalPhase {
  return getOperationalPhase(order.status);
}

function operationalPhaseIndex(order: OrderRow) {
  return getOperationalPhaseIndex(order.status);
}

function operationalPhaseLabel(order: OrderRow) {
  return getOperationalStatusLabel(order);
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
  if (bucket === 'returned') return 'Devueltas';
  if (bucket === 'approval') return 'Por aprobar';
  if (bucket === 'reapproval') return 'Re-aprobación';
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
  if (bucket === 'returned') return 'Ordenes devueltas por master/admin para corregir.';
  if (bucket === 'approval') return 'Ordenes esperando aprobacion de master/admin.';
  if (bucket === 'reapproval') return 'Ordenes modificadas esperando re-aprobacion.';
  if (bucket === 'unpaid') return 'Pendientes de cobro o con pago rechazado.';
  if (bucket === 'delivered') return 'Cierres del dia activo.';
  if (bucket === 'asap') return 'Urgencias sin hora fija.';
  if (bucket === 'priority') return 'Lectura por prioridad operativa.';
  return 'Agenda compacta del dia activo.';
}

function paymentBadge(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  if (order.status === 'cancelled') return null;
  const state = getStoredPaymentState(order, paymentStateByOrderId);
  if (state.hasRejected) return { label: 'Pago rechazado', tone: 'danger' as const };
  if (state.balanceUsd <= 0.005) return { label: 'Pagado', tone: 'success' as const };
  if (state.pendingUsd > 0.005 && state.reportableBalanceUsd <= 0.005) {
    return { label: 'Pago por validar', tone: 'warning' as const };
  }
  if (state.confirmedUsd > 0.005 || state.pendingUsd > 0.005) {
    return {
      label: `Saldo ${formatBs(state.reportableBalanceBs > 0.005 ? state.reportableBalanceBs : state.balanceBs)}`,
      tone: 'warning' as const,
    };
  }
  return { label: `Saldo ${formatBs(state.balanceBs)}`, tone: 'warning' as const };
}

function attentionLabels(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>, selectedDayKey: string) {
  const labels: Array<{ label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = [];
  const payment = getStoredPaymentState(order, paymentStateByOrderId);

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
  const dayRange = getCaracasDayRange(selectedDayKey);
  const orderSelect =
    'id, order_number, status, queued_needs_reapproval, fulfillment, total_usd, created_at, delivery_address, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)';

  const [scheduledOrdersResult, createdOrdersResult] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .eq('extra_fields->schedule->>date', selectedDayKey)
      .order('created_at', { ascending: false })
      .limit(180),
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .gte('created_at', dayRange.startISO)
      .lt('created_at', dayRange.endISO)
      .order('created_at', { ascending: false })
      .limit(180),
  ]);

  const orderById = new Map<number, OrderRow>();
  for (const order of ([...(scheduledOrdersResult.data ?? []), ...(createdOrdersResult.data ?? [])] as RawOrderRow[])) {
    orderById.set(Number(order.id), {
      ...order,
      client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
    });
  }
  const orders = Array.from(orderById.values());

  const orderIds = orders.map((order) => order.id);
  const paymentOrderIds = orders.filter((order) => order.status !== 'cancelled').map((order) => order.id);
  const reviewOrderIds = orders.filter((order) => isOpenStatus(order.status)).map((order) => order.id);
  const { data: activeRateData } = orderIds.length
    ? await ctx.supabase
        .from('exchange_rates')
        .select('rate_bs_per_usd')
        .eq('is_active', true)
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const activeRateBsPerUsd = toSafeNumber((activeRateData as { rate_bs_per_usd?: number | string } | null)?.rate_bs_per_usd, 0);

  const [financialStateResult, timelineData] = orderIds.length
    ? await Promise.all([
      paymentOrderIds.length
        ? (ctx.supabase as any).rpc('get_orders_financial_state', {
            p_order_ids: paymentOrderIds,
            p_operation_date: null,
            p_active_bs_rate: activeRateBsPerUsd > 0 ? activeRateBsPerUsd : null,
          })
        : Promise.resolve({ data: [], error: null }),
      reviewOrderIds.length
        ? ctx.supabase
            .from('order_timeline_events')
            .select('order_id, event_type, created_at')
            .in('order_id', reviewOrderIds)
            .in('event_type', REVIEW_EVENT_TYPES)
            .order('created_at', { ascending: false })
            .limit(240)
        : Promise.resolve({ data: [] }),
    ]).then(([financialResult, timelineResult]) => [
      financialResult,
      timelineResult.data ?? [],
    ] as const)
    : [{ data: [], error: null }, []] as const;
  const financialStateRows = (financialStateResult.data ?? []) as RawOrderFinancialStateRow[];
  const financialStateByOrderId = new Map<number, RawOrderFinancialStateRow>();
  for (const state of financialStateRows) {
    const orderId = Number(state.order_id);
    if (Number.isFinite(orderId)) financialStateByOrderId.set(orderId, state);
  }

  const { data: fallbackPaymentsData } =
    financialStateResult.error && paymentOrderIds.length
      ? await ctx.supabase
          .from('payment_reports')
          .select('order_id, status, reported_amount, reported_currency_code, reported_amount_usd_equivalent')
          .in('order_id', paymentOrderIds)
      : { data: [] };
  if (financialStateResult.error) {
    console.warn('get_orders_financial_state skipped in advisor orders', financialStateResult.error.message);
  }
  const paymentReports = (fallbackPaymentsData ?? []) as PaymentRow[];

  const paymentReportsByOrderId = new Map<number, PaymentRow[]>();
  for (const report of paymentReports) {
    const current = paymentReportsByOrderId.get(report.order_id) ?? [];
    current.push(report);
    paymentReportsByOrderId.set(report.order_id, current);
  }
  const paymentStateByOrderId = new Map<number, PaymentState>();
  for (const order of orders) {
    const canonicalState = financialStateByOrderId.get(order.id);
    paymentStateByOrderId.set(
      order.id,
      canonicalState ? getCanonicalPaymentState(canonicalState) : getPaymentState(order, paymentReportsByOrderId)
    );
  }

  const reviewEventByOrderId = new Map<number, TimelineEventRow>();
  for (const event of (timelineData ?? []) as TimelineEventRow[]) {
    const orderId = Number(event.order_id);
    if (!Number.isFinite(orderId) || reviewEventByOrderId.has(orderId)) continue;
    reviewEventByOrderId.set(orderId, event);
  }

  const dayOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  const filteredOrders = dayOrders.filter((order) => {
    const unpaid = isUnpaidOrder(order, paymentStateByOrderId);
    const overdue = isOverdueOrder(order, selectedDayKey);
    const asap = Boolean(order.extra_fields?.schedule?.asap) && isOpenStatus(order.status);

    if (bucket === 'overdue') return overdue;
    if (bucket === 'open') return isOpenStatus(order.status);
    if (bucket === 'returned') return needsAdvisorReview(order, reviewEventByOrderId);
    if (bucket === 'approval') return needsInitialApproval(order);
    if (bucket === 'reapproval') return needsReapproval(order);
    if (bucket === 'unpaid') return unpaid;
    if (bucket === 'delivered') return order.status === 'delivered';
    if (bucket === 'asap') return asap;
    if (bucket.startsWith('phase_')) return operationalPhase(order) === bucket.replace('phase_', '');
    return true;
  });

  const visibleOrders =
    bucket === 'priority'
      ? [...filteredOrders].sort((a, b) => {
          const attentionDiff =
            attentionLabels(b, paymentStateByOrderId, selectedDayKey).length -
            attentionLabels(a, paymentStateByOrderId, selectedDayKey).length;
          if (attentionDiff !== 0) return attentionDiff;
          return getAgendaSortKey(a).localeCompare(getAgendaSortKey(b));
        })
      : filteredOrders;
  const bucketLinks = [
    { key: 'priority', label: 'Prioridad' },
    { key: 'returned', label: 'Devueltas' },
    { key: 'approval', label: 'Por aprobar' },
    { key: 'reapproval', label: 'Re-aprobar' },
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
      <AdvisorCalendarStrip
        selectedDayKey={selectedDayKey}
        todayKey={getDateKey(new Date())}
      />

      <PageIntro
        eyebrow="Agenda"
        title={titleForBucket(bucket)}
        description={subtitleForBucket(bucket)}
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
              const unpaid = isUnpaidOrder(order, paymentStateByOrderId);
              const paymentState = getStoredPaymentState(order, paymentStateByOrderId);
              const paymentStatus = paymentBadge(order, paymentStateByOrderId);
              const canReportMorePayment = unpaid && paymentState.reportableBalanceUsd > 0.005;
              const phaseIndex = operationalPhaseIndex(order);
              const paymentMethod = paymentMethodLabel(order.extra_fields?.payment?.method);
              const reviewBadge = needsAdvisorReview(order, reviewEventByOrderId)
                ? { label: 'Devuelta', tone: 'danger' as const }
                : needsReapproval(order)
                  ? { label: 'Re-aprobación', tone: 'warning' as const }
                  : needsInitialApproval(order)
                    ? { label: 'Por aprobar', tone: 'neutral' as const }
                    : null;
              const labels = attentionLabels(order, paymentStateByOrderId, selectedDayKey).filter(
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
                        <div className="mt-1 text-xs font-semibold text-[#F0D000]">{formatBs(paymentState.totalBs)}</div>
                        <div className="mt-0.5 text-[11px] text-[#8B93A7]">{formatUsd(getOrderTotalUsd(order))}</div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <StatusBadge label={operationalPhaseLabel(order)} tone={tone(order.status)} />
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {reviewBadge ? <StatusBadge label={reviewBadge.label} tone={reviewBadge.tone} /> : null}
                        {paymentStatus ? <StatusBadge label={paymentStatus.label} tone={paymentStatus.tone} /> : null}
                      </div>
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

                    <div className="mt-3 grid grid-cols-2 gap-2 rounded-[14px] bg-[#0B1017] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[11px] text-[#8B93A7]">Metodo esperado</div>
                        <div className="mt-0.5 truncate text-xs font-medium text-[#F5F7FB]">{paymentMethod}</div>
                      </div>
                      <div className="min-w-0 text-right">
                        <div className="text-[11px] text-[#8B93A7]">Saldo por cobrar</div>
                        <div className="mt-0.5 truncate text-xs font-medium text-[#F5F7FB]">
                          {paymentState.balanceUsd > 0.005 ? formatBs(paymentState.balanceBs) : 'Pagado'}
                        </div>
                      </div>
                    </div>

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
