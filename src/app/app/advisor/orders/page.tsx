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
};

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
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

function isUnpaidOrder(order: OrderRow, paymentStatusByOrderId: Map<number, PaymentRow['status'][]>) {
  if (order.status === 'cancelled') return false;
  const reports = paymentStatusByOrderId.get(order.id) ?? [];
  return reports.length === 0 || reports.every((status) => status === 'rejected');
}

function getGroupKey(
  order: OrderRow,
  paymentStatusByOrderId: Map<number, PaymentRow['status'][]>,
  selectedDayKey: string,
) {
  if (isOverdueOrder(order, selectedDayKey)) return 'overdue';
  if (isUnpaidOrder(order, paymentStatusByOrderId)) return 'unpaid';
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) return 'asap';
  if (order.status === 'delivered' || order.status === 'cancelled') return 'closed';
  return 'upcoming';
}

function titleForBucket(bucket: string) {
  if (bucket === 'overdue') return 'Vencidas';
  if (bucket === 'open') return 'Pendientes';
  if (bucket === 'unpaid') return 'Sin pago';
  if (bucket === 'delivered') return 'Entregadas';
  if (bucket === 'asap') return 'Lo antes posible';
  if (bucket === 'priority') return 'Prioridad del dia';
  return 'Pedidos del dia';
}

function subtitleForBucket(bucket: string) {
  if (bucket === 'overdue') return 'Ordenes que ya debieron moverse.';
  if (bucket === 'open') return 'Ordenes que siguen activas.';
  if (bucket === 'unpaid') return 'Pendientes de cobro o con pago rechazado.';
  if (bucket === 'delivered') return 'Cierres del dia activo.';
  if (bucket === 'asap') return 'Urgencias sin hora fija.';
  if (bucket === 'priority') return 'Lectura por prioridad operativa.';
  return 'Agenda compacta del dia activo.';
}

export default async function AdvisorOrdersPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const bucket = params.bucket ?? 'priority';

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
      .select('order_id, status')
      .eq('created_by_user_id', ctx.user.id),
  ]);

  const orders = ((ordersData ?? []) as RawOrderRow[]).map((order) => ({
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

  const dayOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  const filteredOrders = dayOrders.filter((order) => {
    const unpaid = isUnpaidOrder(order, paymentStatusByOrderId);
    const overdue = isOverdueOrder(order, selectedDayKey);
    const asap = Boolean(order.extra_fields?.schedule?.asap) && isOpenStatus(order.status);

    if (bucket === 'overdue') return overdue;
    if (bucket === 'open') return isOpenStatus(order.status);
    if (bucket === 'unpaid') return unpaid;
    if (bucket === 'delivered') return order.status === 'delivered';
    if (bucket === 'asap') return asap;
    return true;
  });

  const grouped = {
    overdue: filteredOrders.filter((order) => getGroupKey(order, paymentStatusByOrderId, selectedDayKey) === 'overdue'),
    unpaid: filteredOrders.filter((order) => getGroupKey(order, paymentStatusByOrderId, selectedDayKey) === 'unpaid'),
    asap: filteredOrders.filter((order) => getGroupKey(order, paymentStatusByOrderId, selectedDayKey) === 'asap'),
    upcoming: filteredOrders.filter((order) => getGroupKey(order, paymentStatusByOrderId, selectedDayKey) === 'upcoming'),
    closed: filteredOrders.filter((order) => getGroupKey(order, paymentStatusByOrderId, selectedDayKey) === 'closed'),
  };

  const sections: Array<{
    key: keyof typeof grouped;
    title: string;
    subtitle: string;
    rows: OrderRow[];
  }> = [
    { key: 'overdue', title: 'Vencidas', subtitle: 'Mover primero.', rows: grouped.overdue },
    { key: 'unpaid', title: 'Sin pago', subtitle: 'Cobro pendiente o rechazado.', rows: grouped.unpaid },
    { key: 'asap', title: 'Lo antes posible', subtitle: 'Sin hora fija.', rows: grouped.asap },
    { key: 'upcoming', title: 'Proximas', subtitle: 'Siguen en la agenda.', rows: grouped.upcoming },
    { key: 'closed', title: 'Cerradas', subtitle: 'Ya entregadas o canceladas.', rows: grouped.closed },
  ];

  return (
    <div className="space-y-4">
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

      {sections.map((section) => (
        <SectionCard
          key={section.key}
          title={section.title}
          subtitle={section.subtitle}
          action={section.rows.length > 0 ? <StatusBadge label={String(section.rows.length)} tone="neutral" /> : null}
        >
          {section.rows.length === 0 ? (
            <EmptyBlock title="Sin ordenes" detail="No hay elementos en esta bandeja para el dia activo." />
          ) : (
            <div className="space-y-2.5">
              {section.rows.map((order) => {
                const unpaid = isUnpaidOrder(order, paymentStatusByOrderId);
                const overdue = isOverdueOrder(order, selectedDayKey);
                const asap = Boolean(order.extra_fields?.schedule?.asap) && isOpenStatus(order.status);

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
                        <StatusBadge label={statusLabel(order.status)} tone={tone(order.status)} />
                        {overdue ? <StatusBadge label="Vencida" tone="danger" /> : null}
                        {!overdue && unpaid ? <StatusBadge label="Sin pago" tone="warning" /> : null}
                        {!overdue && !unpaid && asap ? <StatusBadge label="ASAP" tone="warning" /> : null}
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 text-xs leading-5 text-[#AAB2C5]">
                      <div>
                        {order.fulfillment === 'delivery'
                          ? order.delivery_address?.trim() || 'Delivery sin direccion'
                          : 'Retiro en tienda'}
                      </div>
                      <div>{order.notes?.trim() || 'Sin notas adicionales.'}</div>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                      <span>{getAgendaTimeLabel(order)}</span>
                      <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        href={`/app/advisor/orders/${order.id}`}
                        className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                      >
                        Ver
                      </Link>
                      {isOpenStatus(order.status) ? (
                        <Link
                          href={`/app/advisor/new?fromOrder=${order.id}`}
                          className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                        >
                          Editar
                        </Link>
                      ) : null}
                      <Link
                        href={`/app/advisor/new?duplicateFrom=${order.id}`}
                        className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                      >
                        Repetir
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
      ))}
    </div>
  );
}
