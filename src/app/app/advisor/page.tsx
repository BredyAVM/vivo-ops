import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, MetricCard, PageIntro, QuickLink, SectionCard, StatusBadge } from './advisor-ui';

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string;
  created_at: string;
  delivery_address: string | null;
  client: { full_name: string | null; phone: string | null }[] | { full_name: string | null; phone: string | null } | null;
};

type PaymentRow = {
  id: number;
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reported_amount_usd_equivalent: number | string;
  created_at: string | null;
};

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function statusTone(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'created' || status === 'queued' || status === 'pending') return 'warning';
  if (status === 'delivered' || status === 'confirmed') return 'success';
  if (status === 'cancelled' || status === 'rejected') return 'danger';
  return 'neutral';
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
    pending: 'Por validar',
    rejected: 'Rechazado',
  };

  return labels[status] ?? status;
}

export default async function AdvisorHomePage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [{ data: ordersData }, { data: paymentsData }] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(
        'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, client:clients!orders_client_id_fkey(full_name, phone)'
      )
      .eq('attributed_advisor_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(12),
    ctx.supabase
      .from('payment_reports')
      .select('id, order_id, status, reported_amount_usd_equivalent, created_at')
      .eq('created_by_user_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  const orders = ((ordersData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));
  const payments = (paymentsData ?? []) as PaymentRow[];

  const attentionOrders = orders.filter((order) => ['created', 'queued', 'ready'].includes(order.status));
  const deliveryOrders = orders.filter((order) => order.status === 'out_for_delivery');
  const closedToday = orders.filter((order) => order.status === 'delivered');
  const pendingPayments = payments.filter((payment) => payment.status === 'pending');
  const visibleSales = orders.reduce((sum, order) => sum + Number(order.total_usd || 0), 0);

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Centro de trabajo"
        title="Lo urgente primero"
        description="Desde aqui el asesor entra a crear pedido, revisar entregas, reportar pagos y seguir lo que aun esta en movimiento."
        action={
          <Link
            href="/app/advisor/new"
            className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-sm font-semibold text-[#17191E]"
          >
            Crear pedido
          </Link>
        }
      />

      <section className="grid grid-cols-2 gap-3">
        <MetricCard label="Por mover" value={String(attentionOrders.length)} detail="Pedidos que piden accion del asesor." />
        <MetricCard label="En entrega" value={String(deliveryOrders.length)} detail="Pedidos que siguen afuera." />
        <MetricCard label="Cobro por validar" value={String(pendingPayments.length)} detail="Reportes que aun no han sido aprobados." />
        <MetricCard label="Venta visible" value={formatUsd(visibleSales)} detail="Lectura rapida de lo ya cargado." />
      </section>

      <section className="grid grid-cols-2 gap-3">
        <QuickLink href="/app/advisor/new" title="Nuevo pedido" detail="Cliente, entrega, pago e items." tone="primary" />
        <QuickLink href="/app/advisor/orders" title="Seguir pedidos" detail="Ver por prioridad y estado." />
        <QuickLink href="/app/advisor/payments" title="Reportar pagos" detail="Revisar lo pendiente y lo confirmado." />
        <QuickLink href="/app/advisor/orders" title="Clientes recientes" detail="Usar clientes de las ultimas ordenes." />
      </section>

      <SectionCard
        title="Prioridades"
        subtitle="Tarjetas cortas para decidir la siguiente accion sin perder tiempo."
        action={
          <Link href="/app/advisor/orders" className="text-sm font-medium text-[#CCD3E2]">
            Ver todo
          </Link>
        }
      >
        {attentionOrders.length === 0 ? (
          <EmptyBlock title="Nada urgente por ahora" detail="Cuando entre un pedido creado, en cola o listo para salir, aparecera aqui." href="/app/advisor/new" cta="Crear pedido" />
        ) : (
          <div className="space-y-2.5">
            {attentionOrders.slice(0, 4).map((order) => (
              <article key={order.id} className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
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
                  <span>{formatDate(order.created_at)}</span>
                  <span className="font-medium text-[#F0D000]">{formatUsd(order.total_usd)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Seguimiento rapido" subtitle="Lo mas reciente en pagos y cierres.">
        <div className="grid gap-3">
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">Pagos pendientes</div>
              <StatusBadge label={String(pendingPayments.length)} tone={pendingPayments.length > 0 ? 'warning' : 'success'} />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
              {pendingPayments.length > 0
                ? `Ultimo reporte: ${formatDate(pendingPayments[0].created_at)}`
                : 'No hay reportes pendientes por validar.'}
            </div>
          </div>
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">Entregadas recientes</div>
              <StatusBadge label={String(closedToday.length)} tone="success" />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
              {closedToday.length > 0
                ? `${closedToday[0].client?.full_name?.trim() || closedToday[0].order_number} fue la ultima orden cerrada visible.`
                : 'Aun no hay entregas cerradas en esta vista.'}
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
