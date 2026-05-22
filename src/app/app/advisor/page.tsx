import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, SectionCard, StatusBadge } from './advisor-ui';

type SearchParams = Promise<{
  day?: string;
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

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function formatDateLabel(value: Date) {
  return value.toLocaleDateString('es-VE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Caracas',
  });
}

function formatShortDay(value: Date) {
  return value.toLocaleDateString('es-VE', {
    weekday: 'short',
    timeZone: 'America/Caracas',
  });
}

function formatDayNumber(value: Date) {
  return value.toLocaleDateString('es-VE', {
    day: '2-digit',
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

function buildCalendarDays(activeKey: string) {
  const base = new Date(`${activeKey}T12:00:00-04:00`);
  return Array.from({ length: 6 }, (_, idx) => {
    const current = new Date(base);
    current.setDate(base.getDate() + idx - 1);
    return {
      key: getDateKey(current),
      label: formatShortDay(current).replace('.', ''),
      dayNumber: formatDayNumber(current),
      isToday: getDateKey(new Date()) === getDateKey(current),
    };
  });
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
  return time12 || new Date(order.created_at).toLocaleString('es-VE', {
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
    ready: 'Lista',
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

function paymentAttentionLabel(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
  if (order.status === 'cancelled') return null;

  const state = getPaymentState(order, paymentReportsByOrderId);
  if (state.balanceUsd <= 0.005) return null;
  if (state.pendingUsd > 0.005 && state.reportableBalanceUsd <= 0.005) return 'Por validar';
  if (state.confirmedUsd > 0.005 || state.pendingUsd > 0.005) {
    return `Saldo ${formatUsd(state.reportableBalanceUsd > 0.005 ? state.reportableBalanceUsd : state.balanceUsd)}`;
  }
  return 'Sin pago';
}

function isUnpaidOrder(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
  if (order.status === 'cancelled') return false;
  return getPaymentState(order, paymentReportsByOrderId).balanceUsd > 0.005;
}

function latestReviewEvent(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
  return reviewEventByOrderId.get(order.id)?.event_type || null;
}

function needsAdvisorReview(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
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

function priorityScore(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>, selectedDayKey: string) {
  if (isOverdueOrder(order, selectedDayKey)) return 0;
  if (isUnpaidOrder(order, paymentReportsByOrderId)) return 1;
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) return 2;
  if (order.status === 'created' || order.status === 'queued') return 3;
  return 4;
}

type OperationalPhase = 'new' | 'kitchen' | 'ready' | 'route' | 'closed' | 'cancelled';

const OPERATIONAL_PHASES: Array<{ key: OperationalPhase; label: string; shortLabel: string }> = [
  { key: 'new', label: 'Nuevas', shortLabel: 'Nuevas' },
  { key: 'kitchen', label: 'Cocina', shortLabel: 'Cocina' },
  { key: 'ready', label: 'Listas', shortLabel: 'Listas' },
  { key: 'route', label: 'Camino', shortLabel: 'Camino' },
  { key: 'closed', label: 'Entregadas', shortLabel: 'Entregadas' },
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

function paymentStatusBadge(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>) {
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

export default async function AdvisorHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());

  const { data: ordersData } = await ctx.supabase
    .from('orders')
    .select(
      'id, order_number, status, queued_needs_reapproval, fulfillment, total_usd, created_at, delivery_address, notes, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
    )
    .eq('attributed_advisor_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(300);

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
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

  const { data: timelineData } = orderIds.length
    ? await ctx.supabase
        .from('order_timeline_events')
        .select('order_id, event_type, created_at')
        .in('order_id', orderIds)
        .in('event_type', REVIEW_EVENT_TYPES)
        .order('created_at', { ascending: false })
        .limit(400)
    : { data: [] };
  const reviewEventByOrderId = new Map<number, TimelineEventRow>();
  for (const event of (timelineData ?? []) as TimelineEventRow[]) {
    const orderId = Number(event.order_id);
    if (!Number.isFinite(orderId) || reviewEventByOrderId.has(orderId)) continue;
    reviewEventByOrderId.set(orderId, event);
  }

  const agendaOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  const openOrders = agendaOrders.filter((order) => isOpenStatus(order.status));
  const unpaidOrders = agendaOrders.filter((order) => isUnpaidOrder(order, paymentReportsByOrderId));
  const overdueOrders = agendaOrders.filter((order) => isOverdueOrder(order, selectedDayKey));
  const asapOrders = agendaOrders.filter(
    (order) => order.extra_fields?.schedule?.asap && isOpenStatus(order.status)
  );
  const deliveredOrders = agendaOrders.filter((order) => order.status === 'delivered');
  const returnedOrders = agendaOrders.filter((order) => needsAdvisorReview(order, reviewEventByOrderId));
  const pendingApprovalOrders = agendaOrders.filter((order) => needsInitialApproval(order));
  const pendingReapprovalOrders = agendaOrders.filter((order) => needsReapproval(order));
  const attentionOrders = [...agendaOrders]
    .filter((order) => isOpenStatus(order.status))
    .filter(
      (order) =>
        needsAdvisorReview(order, reviewEventByOrderId) ||
        needsInitialApproval(order) ||
        needsReapproval(order) ||
        attentionLabels(order, paymentReportsByOrderId, selectedDayKey).length > 0
    )
    .sort((a, b) => {
      const reviewDiff =
        Number(needsAdvisorReview(b, reviewEventByOrderId)) - Number(needsAdvisorReview(a, reviewEventByOrderId));
      if (reviewDiff !== 0) return reviewDiff;
      const scoreDiff =
        priorityScore(a, paymentReportsByOrderId, selectedDayKey) -
        priorityScore(b, paymentReportsByOrderId, selectedDayKey);
      if (scoreDiff !== 0) return scoreDiff;
      return getAgendaSortKey(a).localeCompare(getAgendaSortKey(b));
    })
    .slice(0, 4);
  const phaseCounts = OPERATIONAL_PHASES.map((phase) => ({
    ...phase,
    count: agendaOrders.filter((order) => operationalPhase(order) === phase.key).length,
  }));

  const calendarDays = buildCalendarDays(selectedDayKey);
  return (
    <div className="space-y-4">
      <section className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-2">
          {calendarDays.map((day) => {
            const isActive = day.key === selectedDayKey;

            return (
              <Link
                key={day.key}
                href={`/app/advisor?day=${day.key}`}
                className={[
                  'min-w-[76px] rounded-[18px] border px-3 py-3 text-center',
                  isActive
                    ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                    : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
                ].join(' ')}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em]">{day.label}</div>
                <div className="mt-1 text-lg font-semibold">{day.dayNumber}</div>
                <div className="mt-1 text-[10px]">{day.isToday ? 'Hoy' : 'Agenda'}</div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
              Seguimiento
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#F5F7FB]">
              {formatDateLabel(new Date(`${selectedDayKey}T12:00:00-04:00`))}
            </h2>
          </div>
          <div className="text-right text-xs leading-5 text-[#AAB2C5]">
            <div>{agendaOrders.length} pedidos</div>
            <div>{openOrders.length} abiertos</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-1.5">
          {phaseCounts.map((phase) => (
            <Link
              key={phase.key}
              href={`/app/advisor/orders?day=${selectedDayKey}&bucket=phase_${phase.key}`}
              className="min-w-0 rounded-[14px] border border-[#232632] bg-[#0F131B] px-1.5 py-2 text-center transition active:scale-[0.99]"
            >
              <div className="text-lg font-semibold text-[#F5F7FB]">{phase.count}</div>
              <div className="mt-0.5 text-[9px] font-semibold uppercase leading-3 tracking-normal text-[#8B93A7]">
                {phase.shortLabel}
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=overdue`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{overdueOrders.length}</span> hora atrasada
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=unpaid`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{unpaidOrders.length}</span> cobro
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=asap`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{asapOrders.length}</span> ASAP
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=delivered`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{deliveredOrders.length}</span> entregadas
          </Link>
        </div>
      </section>

      {(returnedOrders.length > 0 || pendingApprovalOrders.length > 0 || pendingReapprovalOrders.length > 0) ? (
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=returned`}
            className={[
              'rounded-[18px] border px-3.5 py-3',
              returnedOrders.length > 0 ? 'border-[#5E2229] bg-[#171118]' : 'border-[#232632] bg-[#0F131B]',
            ].join(' ')}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Devueltas</div>
            <div className="mt-1 text-2xl font-semibold text-[#F5F7FB]">{returnedOrders.length}</div>
            <div className="mt-1 text-xs leading-4 text-[#AAB2C5]">Requieren correccion del asesor.</div>
          </Link>

          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=approval`}
            className={[
              'rounded-[18px] border px-3.5 py-3',
              pendingApprovalOrders.length > 0 ? 'border-[#564511] bg-[#151208]' : 'border-[#232632] bg-[#0F131B]',
            ].join(' ')}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Por aprobar</div>
            <div className="mt-1 text-2xl font-semibold text-[#F5F7FB]">{pendingApprovalOrders.length}</div>
            <div className="mt-1 text-xs leading-4 text-[#AAB2C5]">Esperan revision de master/admin.</div>
          </Link>

          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=reapproval`}
            className={[
              'rounded-[18px] border px-3.5 py-3',
              pendingReapprovalOrders.length > 0 ? 'border-[#564511] bg-[#151208]' : 'border-[#232632] bg-[#0F131B]',
            ].join(' ')}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Re-aprobacion</div>
            <div className="mt-1 text-2xl font-semibold text-[#F5F7FB]">{pendingReapprovalOrders.length}</div>
            <div className="mt-1 text-xs leading-4 text-[#AAB2C5]">Cambios enviados para validar.</div>
          </Link>
        </section>
      ) : null}

      {attentionOrders.length > 0 ? (
        <SectionCard
          title="Atencion"
          subtitle="Pedidos con algo que puede frenar la operacion."
          action={
            <Link
              href={`/app/advisor/orders?day=${selectedDayKey}&bucket=priority`}
              className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-sm font-medium text-[#F5F7FB]"
            >
              Ver todo
            </Link>
          }
        >
          <div className="space-y-2.5">
            {attentionOrders.map((order) => {
              const labels = attentionLabels(order, paymentReportsByOrderId, selectedDayKey);
              const reviewBadge = needsAdvisorReview(order, reviewEventByOrderId)
                ? { label: 'Devuelta', tone: 'danger' as const }
                : needsReapproval(order)
                  ? { label: 'Re-aprobación', tone: 'warning' as const }
                  : needsInitialApproval(order)
                    ? { label: 'Por aprobar', tone: 'neutral' as const }
                    : null;

              return (
                <Link
                  key={order.id}
                  href={`/app/advisor/orders/${order.id}`}
                  className="block rounded-[18px] border border-[#2A3040] bg-[#0F131B] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">
                        {order.client?.full_name?.trim() || order.order_number}
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {getAgendaTimeLabel(order)} · {operationalPhaseLabel(order)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-semibold text-[#F0D000]">{formatUsd(order.total_usd)}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {reviewBadge ? <StatusBadge label={reviewBadge.label} tone={reviewBadge.tone} /> : null}
                    {labels.map((label) => (
                      <StatusBadge key={`${order.id}-${label.label}`} label={label.label} tone={label.tone} />
                    ))}
                  </div>
                </Link>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Pedidos del dia"
        subtitle="Lectura por fase, cobro y hora."
        action={
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=priority`}
            className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-sm font-medium text-[#F5F7FB]"
          >
            Lista
          </Link>
        }
      >
        {agendaOrders.length === 0 ? (
          <EmptyBlock
            title="Sin pedidos agendados"
            detail="Este dia no tiene pedidos visibles para este asesor."
            href="/app/advisor/new"
            cta="Crear pedido"
          />
        ) : (
          <div className="space-y-2.5">
            {agendaOrders.map((order) => {
              const phaseIndex = operationalPhaseIndex(order);
              const paymentBadge = paymentStatusBadge(order, paymentReportsByOrderId);
              const reviewBadge = needsAdvisorReview(order, reviewEventByOrderId)
                ? { label: 'Devuelta', tone: 'danger' as const }
                : needsReapproval(order)
                  ? { label: 'Re-aprobación', tone: 'warning' as const }
                  : needsInitialApproval(order)
                    ? { label: 'Por aprobar', tone: 'neutral' as const }
                    : null;
              const labels = attentionLabels(order, paymentReportsByOrderId, selectedDayKey).filter(
                (label) => label.label !== 'Cobro pendiente'
              );

              return (
                <Link
                  key={order.id}
                  href={`/app/advisor/orders/${order.id}`}
                  className="block rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                >
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
                    <StatusBadge label={operationalPhaseLabel(order)} tone={statusTone(order.status)} />
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {reviewBadge ? <StatusBadge label={reviewBadge.label} tone={reviewBadge.tone} /> : null}
                      {paymentBadge ? <StatusBadge label={paymentBadge.label} tone={paymentBadge.tone} /> : null}
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
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
