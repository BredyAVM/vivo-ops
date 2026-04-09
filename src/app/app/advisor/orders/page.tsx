import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

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

function OrderCard({ order }: { order: OrderRow & { client: { full_name: string | null; phone: string | null } | null } }) {
  return (
    <article className="rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[#F5F7FB]">{order.client?.full_name?.trim() || order.order_number}</div>
          <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
        </div>
        <StatusBadge label={statusLabel(order.status)} tone={tone(order.status)} />
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
}

export default async function AdvisorOrdersPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data } = await ctx.supabase
    .from('orders')
    .select(
      'id, order_number, status, fulfillment, total_usd, created_at, delivery_address, notes, client:clients!orders_client_id_fkey(full_name, phone)'
    )
    .eq('attributed_advisor_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(40);

  const orders = ((data ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));

  const sections = [
    {
      title: 'Requieren accion',
      subtitle: 'Pedidos que hoy pueden trabarse si no se atienden.',
      rows: orders.filter((order) => ['created', 'queued', 'ready'].includes(order.status)),
    },
    {
      title: 'En proceso',
      subtitle: 'Pedidos que ya van avanzando.',
      rows: orders.filter((order) => ['confirmed', 'in_kitchen', 'out_for_delivery'].includes(order.status)),
    },
    {
      title: 'Cerradas',
      subtitle: 'Historico reciente del asesor.',
      rows: orders.filter((order) => ['delivered', 'cancelled'].includes(order.status)),
    },
  ];

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Bandeja"
        title="Pedidos del asesor"
        description="La lectura esta ordenada por prioridad para decidir rapido que crear, que empujar y que ya se cerro."
        action={
          <Link href="/app/advisor/new" className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-sm font-semibold text-[#17191E]">
            Nuevo
          </Link>
        }
      />

      {orders.length === 0 ? (
        <EmptyBlock title="Todavia no hay pedidos" detail="Cuando este asesor cree o reciba pedidos, apareceran aqui con prioridad clara." href="/app/advisor/new" cta="Crear primer pedido" />
      ) : (
        sections.map((section) => (
          <SectionCard key={section.title} title={section.title} subtitle={section.subtitle}>
            {section.rows.length === 0 ? (
              <EmptyBlock title="Sin elementos" detail="Esta bandeja esta vacia ahora mismo." />
            ) : (
              <div className="space-y-2.5">
                {section.rows.map((order) => (
                  <OrderCard key={order.id} order={order} />
                ))}
              </div>
            )}
          </SectionCard>
        ))
      )}
    </div>
  );
}
