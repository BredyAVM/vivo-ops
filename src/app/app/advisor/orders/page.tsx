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

function getDayRange(key: string) {
  return {
    startIso: `${key}T00:00:00-04:00`,
    endIso: `${key}T23:59:59-04:00`,
  };
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

function titleForBucket(bucket: string) {
  if (bucket === 'open') return 'Pendientes del dia';
  if (bucket === 'unpaid') return 'Sin pago reportado';
  if (bucket === 'delivered') return 'Entregadas del dia';
  if (bucket === 'alerts') return 'Alertas operativas';
  return 'Pedidos del dia';
}

function subtitleForBucket(bucket: string) {
  if (bucket === 'open') return 'Ordenes que siguen abiertas para este dia.';
  if (bucket === 'unpaid') return 'Ordenes donde falta registrar el pago o el reporte fue rechazado.';
  if (bucket === 'delivered') return 'Cierres registrados en el dia activo.';
  if (bucket === 'alerts') return 'Eventos que merecen atencion del asesor.';
  return 'Agenda compacta del dia activo.';
}

export default async function AdvisorOrdersPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const bucket = params.bucket ?? 'today';
  const { startIso, endIso } = getDayRange(selectedDayKey);

  const [{ data: ordersData }, { data: paymentsData }] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(
        'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, notes, client:clients!orders_client_id_fkey(full_name, phone)'
      )
      .eq('attributed_advisor_id', ctx.user.id)
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: true }),
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

  const dayOrders = orders.filter((order) => getIsoDayKey(order.created_at) === selectedDayKey);
  const filteredOrders = dayOrders.filter((order) => {
    const reports = paymentStatusByOrderId.get(order.id) ?? [];
    const unpaid = reports.length === 0 || reports.every((status) => status === 'rejected');
    const alert = ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(order.status) || unpaid;

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
          <Link href={`/app/advisor?day=${selectedDayKey}`} className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Volver
          </Link>
        }
      />

      <SectionCard title="Lista del dia" subtitle={selectedDayKey}>
        {filteredOrders.length === 0 ? (
          <EmptyBlock title="Sin elementos para este filtro" detail="Prueba otro dia o vuelve a la agenda principal." href={`/app/advisor?day=${selectedDayKey}`} cta="Ir al home" />
        ) : (
          <div className="space-y-2.5">
            {filteredOrders.map((order) => {
              const reports = paymentStatusByOrderId.get(order.id) ?? [];
              const unpaid = reports.length === 0 || reports.every((status) => status === 'rejected');

              return (
                <article key={order.id} className="rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{order.client?.full_name?.trim() || order.order_number}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge label={statusLabel(order.status)} tone={tone(order.status)} />
                      {unpaid ? <StatusBadge label="Falta pago" tone="warning" /> : null}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs leading-5 text-[#AAB2C5]">
                    <div>{order.fulfillment === 'delivery' ? order.delivery_address?.trim() || 'Delivery sin direccion' : 'Retiro en tienda'}</div>
                    <div>{order.notes?.trim() || 'Sin notas adicionales.'}</div>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-[#8B93A7]">
                    <span>{formatDate(order.created_at)}</span>
                    <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
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
