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
  return time12 || formatDate(order.created_at);
}

function titleForBucket(bucket: string) {
  if (bucket === 'open') return 'Pendientes del día';
  if (bucket === 'unpaid') return 'Sin pago reportado';
  if (bucket === 'delivered') return 'Entregadas del día';
  if (bucket === 'alerts') return 'Alertas operativas';
  return 'Pedidos del día';
}

function subtitleForBucket(bucket: string) {
  if (bucket === 'open') return 'Órdenes que siguen abiertas para este día.';
  if (bucket === 'unpaid') return 'Órdenes donde falta registrar el pago o el reporte fue rechazado.';
  if (bucket === 'delivered') return 'Cierres registrados en el día activo.';
  if (bucket === 'alerts') return 'Eventos que merecen atención del asesor.';
  return 'Agenda compacta del día activo.';
}

export default async function AdvisorOrdersPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const bucket = params.bucket ?? 'today';

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

  const dayOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  const filteredOrders = dayOrders.filter((order) => {
    const reports = paymentStatusByOrderId.get(order.id) ?? [];
    const unpaid = reports.length === 0 || reports.every((status) => status === 'rejected');
    const alert =
      ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(order.status) || unpaid;

    if (bucket === 'open') return !['delivered', 'cancelled'].includes(order.status);
    if (bucket === 'unpaid') return order.status !== 'cancelled' && unpaid;
    if (bucket === 'delivered') return order.status === 'delivered';
    if (bucket === 'alerts') return alert;
    return true;
  });

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

      <SectionCard title="Lista del día" subtitle={selectedDayKey}>
        {filteredOrders.length === 0 ? (
          <EmptyBlock
            title="Sin elementos para este filtro"
            detail="Prueba otro día o vuelve a la agenda principal."
            href={`/app/advisor?day=${selectedDayKey}`}
            cta="Ir al home"
          />
        ) : (
          <div className="space-y-2.5">
            {filteredOrders.map((order) => {
              const reports = paymentStatusByOrderId.get(order.id) ?? [];
              const unpaid = reports.length === 0 || reports.every((status) => status === 'rejected');

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
                      <StatusBadge label={statusLabel(order.status)} tone={tone(order.status)} />
                      {unpaid ? <StatusBadge label="Falta pago" tone="warning" /> : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-xs leading-5 text-[#AAB2C5]">
                    <div>
                      {order.fulfillment === 'delivery'
                        ? order.delivery_address?.trim() || 'Delivery sin dirección'
                        : 'Retiro en tienda'}
                    </div>
                    <div>{order.notes?.trim() || 'Sin notas adicionales.'}</div>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                    <span>{getAgendaTimeLabel(order)}</span>
                    <span className="font-medium text-[#F0D000]">Abrir / {formatUsd(order.total_usd)}</span>
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
