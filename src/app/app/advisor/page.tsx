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
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
  } | null;
  client: { full_name: string | null; phone: string | null }[] | { full_name: string | null; phone: string | null } | null;
};

type PaymentRow = {
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
};

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
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

function formatDateTime(value: string) {
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

function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || 'Asesor';
}

function isDayKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getAgendaDayKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const scheduledDay = order.extra_fields?.schedule?.date;
  return isDayKey(scheduledDay) ? String(scheduledDay) : getIsoDayKey(order.created_at);
}

function getAgendaSortKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const schedule = order.extra_fields?.schedule;
  const dayKey = getAgendaDayKey(order);
  const timeKey = schedule?.asap ? '00:00' : String(schedule?.time_24 || '').trim() || '99:99';

  return `${dayKey}|${timeKey}|${order.created_at}`;
}

function getAgendaTimeLabel(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';

  const time12 = String(schedule?.time_12 || '').trim();
  return time12 || formatDateTime(order.created_at);
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

export default async function AdvisorHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  const selectedDayKey = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());

  const [{ data: ordersData }, { data: paymentsData }] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(
        'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
      )
      .eq('attributed_advisor_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(300),
    ctx.supabase
      .from('payment_reports')
      .select('order_id, status')
      .eq('created_by_user_id', ctx.user.id),
  ]);

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));
  const paymentReports = (paymentsData ?? []) as PaymentRow[];

  const paymentStatusByOrderId = new Map<number, PaymentRow['status'][]>();
  for (const report of paymentReports) {
    const current = paymentStatusByOrderId.get(report.order_id) ?? [];
    current.push(report.status);
    paymentStatusByOrderId.set(report.order_id, current);
  }

  const agendaOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));
  const openOrders = agendaOrders.filter((order) => !['delivered', 'cancelled'].includes(order.status));
  const unpaidOrders = agendaOrders.filter((order) => {
    if (order.status === 'cancelled') return false;
    const reports = paymentStatusByOrderId.get(order.id) ?? [];
    return reports.length === 0 || reports.every((status) => status === 'rejected');
  });
  const deliveredOrders = agendaOrders.filter((order) => order.status === 'delivered');
  const alertsCount = new Set([
    ...agendaOrders
      .filter((order) => ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(order.status))
      .map((order) => order.id),
    ...unpaidOrders.map((order) => order.id),
  ]).size;
  const calendarDays = buildCalendarDays(selectedDayKey);
  const advisorName = firstName(profile?.full_name?.trim() || ctx.user.user_metadata?.full_name || ctx.user.email || 'Asesor');

  return (
    <div className="space-y-4">
      <section className="flex items-center justify-between gap-3 rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">Hoy</div>
          <div className="mt-1 truncate text-sm font-medium text-[#F5F7FB]">
            {formatDateLabel(new Date(`${selectedDayKey}T12:00:00-04:00`))}
          </div>
        </div>
        <Link
          href="/app/advisor/inbox?filter=pending"
          className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#F5F7FB]"
          aria-label={`Notificaciones de ${advisorName}`}
        >
          <span className="text-lg">!</span>
          <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold text-[#17191E]">
            {alertsCount}
          </span>
        </Link>
      </section>

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
                  isActive ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
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
        <Link href={`/app/advisor/orders?day=${selectedDayKey}&bucket=today`} className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">Pedidos de hoy</div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{agendaOrders.length}</div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Base diaria para leer la agenda.</div>
        </Link>
        <Link href={`/app/advisor/orders?day=${selectedDayKey}&bucket=open`} className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">Pendientes</div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{openOrders.length}</div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Aun no cerradas ni entregadas.</div>
        </Link>
        <Link href={`/app/advisor/orders?day=${selectedDayKey}&bucket=unpaid`} className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">Sin pago reportado</div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{unpaidOrders.length}</div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Ordenes donde falta registrar el cobro.</div>
        </Link>
        <Link href={`/app/advisor/orders?day=${selectedDayKey}&bucket=delivered`} className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">Entregadas</div>
          <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{deliveredOrders.length}</div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">Cierres visibles del dia activo.</div>
        </Link>
      </section>

      <SectionCard
        title="Agenda"
        subtitle={formatDateLabel(new Date(`${selectedDayKey}T12:00:00-04:00`))}
      >
        {agendaOrders.length === 0 ? (
          <EmptyBlock title="Sin pedidos agendados" detail="Este dia no tiene pedidos visibles para este asesor." href="/app/advisor/new" cta="Crear pedido" />
        ) : (
          <div className="space-y-2.5">
            {agendaOrders.slice(0, 6).map((order) => (
              <Link
                key={order.id}
                href={`/app/advisor/orders?day=${selectedDayKey}`}
                className="block rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#F5F7FB]">
                      {order.client?.full_name?.trim() || order.order_number}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
                  </div>
                  <StatusBadge label={statusLabel(order.status)} tone={statusTone(order.status)} />
                </div>
                <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
                  {order.fulfillment === 'delivery' ? order.delivery_address?.trim() || 'Delivery sin direccion' : 'Retiro en tienda'}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                  <span>{getAgendaTimeLabel(order)}</span>
                  <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
