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

function priorityScore(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>, selectedDayKey: string) {
  if (isOverdueOrder(order, selectedDayKey)) return 0;
  if (isUnpaidOrder(order, paymentReportsByOrderId)) return 1;
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) return 2;
  if (order.status === 'created' || order.status === 'queued') return 3;
  return 4;
}

export default async function AdvisorHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());

  const [{ data: ordersData }, { data: paymentsData }] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(
        'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, notes, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
      )
      .eq('attributed_advisor_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(300),
    ctx.supabase
      .from('payment_reports')
      .select('order_id, status, reported_amount_usd_equivalent')
      .eq('created_by_user_id', ctx.user.id),
  ]);

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));
  const paymentReports = (paymentsData ?? []) as PaymentRow[];

  const paymentReportsByOrderId = new Map<number, PaymentRow[]>();
  for (const report of paymentReports) {
    const current = paymentReportsByOrderId.get(report.order_id) ?? [];
    current.push(report);
    paymentReportsByOrderId.set(report.order_id, current);
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
  const urgentOrders = [...agendaOrders]
    .filter((order) => isOpenStatus(order.status))
    .sort((a, b) => {
      const scoreDiff =
        priorityScore(a, paymentReportsByOrderId, selectedDayKey) -
        priorityScore(b, paymentReportsByOrderId, selectedDayKey);
      if (scoreDiff !== 0) return scoreDiff;
      return getAgendaSortKey(a).localeCompare(getAgendaSortKey(b));
    })
    .slice(0, 3);

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

      <section className="grid grid-cols-2 gap-3">
        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=today`}
          className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
            Pedidos del dia
          </div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">
            {agendaOrders.length}
          </div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Lectura completa de la agenda.</div>
        </Link>
        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=overdue`}
          className="rounded-[22px] border border-[#5E2229] bg-[#261114] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#F0A6AE]">
            Vencidas
          </div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">
            {overdueOrders.length}
          </div>
          <div className="mt-1 text-xs leading-5 text-[#D9A5AD]">Las que ya debieron moverse.</div>
        </Link>
        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=unpaid`}
          className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
            Sin pago
          </div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">
            {unpaidOrders.length}
          </div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Falta registrar o corregir cobro.</div>
        </Link>
        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=asap`}
          className="rounded-[22px] border border-[#564511] bg-[#2A2209] px-4 py-3"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#F7DA66]">
            Lo antes posible
          </div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">
            {asapOrders.length}
          </div>
          <div className="mt-1 text-xs leading-5 text-[#D9C178]">Urgencia sin hora fija.</div>
        </Link>
      </section>

      <SectionCard
        title="Urgente"
        subtitle="Las 3 cosas que merecen atencion primero."
        action={
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=priority`}
            className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-sm font-medium text-[#F5F7FB]"
          >
            Ver todo
          </Link>
        }
      >
        {urgentOrders.length === 0 ? (
          <EmptyBlock
            title="Sin urgencias visibles"
            detail="Hoy no hay pendientes prioritarios por arriba del resto."
          />
        ) : (
          <div className="space-y-2.5">
            {urgentOrders.map((order) => {
              const unpaid = isUnpaidOrder(order, paymentReportsByOrderId);
              const paymentLabel = paymentAttentionLabel(order, paymentReportsByOrderId);
              const overdue = isOverdueOrder(order, selectedDayKey);
              const asap = Boolean(order.extra_fields?.schedule?.asap);

              return (
                <article
                  key={order.id}
                  className="rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">
                        {order.client?.full_name?.trim() || order.order_number}
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge label={statusLabel(order.status)} tone={statusTone(order.status)} />
                      {overdue ? <StatusBadge label="Vencida" tone="danger" /> : null}
                      {!overdue && paymentLabel ? <StatusBadge label={paymentLabel} tone="warning" /> : null}
                      {!overdue && !unpaid && asap ? <StatusBadge label="ASAP" tone="warning" /> : null}
                    </div>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
                    {order.fulfillment === 'delivery'
                      ? order.delivery_address?.trim() || 'Delivery sin direccion'
                      : 'Retiro en tienda'}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                    <span>{getAgendaTimeLabel(order)}</span>
                    <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Link
                      href={`/app/advisor/orders/${order.id}`}
                      className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                    >
                      Ver
                    </Link>
                    <Link
                      href={`/app/advisor/new?fromOrder=${order.id}`}
                      className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                    >
                      Editar
                    </Link>
                    {unpaid ? (
                      <Link
                        href={`/app/advisor/orders/${order.id}?reportPayment=1`}
                        className="inline-flex h-9 items-center rounded-[12px] bg-[#F0D000] px-3 text-xs font-semibold text-[#17191E]"
                      >
                        Pago
                      </Link>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Agenda del dia"
        subtitle={formatDateLabel(new Date(`${selectedDayKey}T12:00:00-04:00`))}
        action={
          <StatusBadge
            label={`${openOrders.length} abiertas / ${deliveredOrders.length} cerradas`}
            tone="neutral"
          />
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
            {agendaOrders.slice(0, 6).map((order) => {
              const paymentLabel = paymentAttentionLabel(order, paymentReportsByOrderId);

              return (
                <Link
                  key={order.id}
                  href={`/app/advisor/orders/${order.id}`}
                  className="block rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">
                        {order.client?.full_name?.trim() || order.order_number}
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge label={statusLabel(order.status)} tone={statusTone(order.status)} />
                      {paymentLabel ? <StatusBadge label={paymentLabel} tone="warning" /> : null}
                    </div>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
                    {order.fulfillment === 'delivery'
                      ? order.delivery_address?.trim() || 'Delivery sin direccion'
                      : 'Retiro en tienda'}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                    <span>{getAgendaTimeLabel(order)}</span>
                    <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
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
