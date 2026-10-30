import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { formatOrderDisplayNumber, getOrderStatusLabel } from '@/lib/orders/order-labels';
import {
  getKitchenDayRange,
  getKitchenShiftDateBounds,
  kitchenPrepMetric,
  summarizeKitchenPrepMetrics,
} from '@/lib/kitchen/operations';
import { ModulePreference } from '../../ModulePreference';

type HistorySearchParams = Promise<{ date?: string | string[] }>;

type RawHistoryOrder = {
  id: number;
  status: string;
  fulfillment: 'pickup' | 'delivery';
  kitchen_started_at: string | null;
  ready_at: string | null;
  client:
    | { full_name: string | null }[]
    | { full_name: string | null }
    | null;
};

type RawPrepEtaEvent = {
  order_id: number | string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function formatMinutes(value: number | null) {
  if (value == null) return '--';
  return `${value.toLocaleString('es-VE', { maximumFractionDigits: 1 })} min`;
}

export default async function KitchenHistoryPage({
  searchParams,
}: {
  searchParams: HistorySearchParams;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!isMasterOrAdminRole(ctx.roles) && !ctx.roles.includes('kitchen')) {
    redirect(resolveHomePath(ctx.roles));
  }

  const today = getKitchenShiftDateBounds(new Date()).max;
  const rawDate = (await searchParams).date;
  const requestedDate = Array.isArray(rawDate) ? rawDate[0] : rawDate;
  let dayKey = today;
  let range = getKitchenDayRange(today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || ''))) {
    try {
      const requestedRange = getKitchenDayRange(String(requestedDate));
      dayKey = String(requestedDate);
      range = requestedRange;
    } catch {
      // Keep today's canonical Caracas range for malformed calendar dates.
    }
  }

  const { data: ordersData, error: ordersError } = await ctx.supabase
    .from('orders')
    .select('id,status,fulfillment,kitchen_started_at,ready_at,client:clients(full_name)')
    .gte('ready_at', range.startISO)
    .lt('ready_at', range.endISO)
    .neq('status', 'cancelled')
    .order('ready_at', { ascending: false })
    .limit(200);

  if (ordersError) throw new Error(`No se pudo cargar el historial de Cocina: ${ordersError.message}`);

  const rawOrders = (ordersData ?? []) as unknown as RawHistoryOrder[];
  const orderIds = rawOrders.map((order) => Number(order.id));
  const { data: etaEventsData, error: etaEventsError } = orderIds.length
    ? await ctx.supabase
        .from('order_timeline_events')
        .select('order_id,payload,created_at')
        .in('order_id', orderIds)
        .in('event_type', ['kitchen_taken', 'kitchen_eta_updated', 'kitchen_delayed_prep'])
        .order('created_at', { ascending: false })
        .limit(600)
    : { data: [], error: null };

  if (etaEventsError) throw new Error(`No se pudieron reconstruir los ETA de Cocina: ${etaEventsError.message}`);

  const etaEventsByOrder = new Map<number, RawPrepEtaEvent[]>();
  for (const event of (etaEventsData ?? []) as unknown as RawPrepEtaEvent[]) {
    const orderId = Number(event.order_id);
    const events = etaEventsByOrder.get(orderId) ?? [];
    events.push(event);
    etaEventsByOrder.set(orderId, events);
  }

  const history = rawOrders.map((order) => {
    const client = Array.isArray(order.client) ? order.client[0] ?? null : order.client;
    const readyAtMs = new Date(String(order.ready_at || '')).getTime();
    const etaEvent = (etaEventsByOrder.get(Number(order.id)) ?? []).find(
      (event) => new Date(event.created_at).getTime() <= readyAtMs,
    );
    const prepEta = Number(etaEvent?.payload?.prep_eta_minutes);
    const metric = kitchenPrepMetric({
      startedAt: order.kitchen_started_at,
      readyAt: order.ready_at,
      etaMinutes: Number.isFinite(prepEta) && prepEta > 0 ? prepEta : null,
    });
    return {
      id: Number(order.id),
      clientName: client?.full_name?.trim() || 'Cliente',
      status: order.status,
      fulfillment: order.fulfillment,
      readyAt: order.ready_at,
      metric,
    };
  });
  const summary = summarizeKitchenPrepMetrics(
    history.flatMap((order) => order.metric ? [order.metric] : []),
  );

  return (
    <main className="kitchen-app min-h-screen bg-[#08090D] text-[#F5F5F7]">
      <ModulePreference moduleKey="kitchen" />
      <div className="mx-auto min-h-screen w-full max-w-[720px] px-3">
        <header className="kitchen-safe-header sticky top-0 z-20 -mx-3 border-b border-[#242433] bg-[#08090D]/95 px-3 pb-3 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS · Cocina</div>
              <h1 className="mt-1 text-xl font-black">Historial diario y ETA</h1>
            </div>
            <Link href="/app/kitchen" className="flex h-10 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-sm font-semibold">
              Volver
            </Link>
          </div>
          <form className="mt-3 flex items-end gap-2" action="/app/kitchen/history">
            <label className="min-w-0 flex-1 text-xs text-[#B7B7C2]">
              <span className="mb-1 block">Fecha operativa</span>
              <input
                type="date"
                name="date"
                defaultValue={dayKey}
                max={today}
                className="h-11 w-full rounded-xl border border-[#303041] bg-[#0B0B10] px-3 text-base text-white"
              />
            </label>
            <button type="submit" className="h-11 rounded-xl bg-[#FEEF00] px-4 text-sm font-black text-black">
              Consultar
            </button>
          </form>
        </header>

        <section className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-4">
          <MetricCard label="Preparadas" value={String(history.length)} />
          <MetricCard label="Promedio real" value={formatMinutes(summary.averageActualMinutes)} />
          <MetricCard label="A tiempo" value={summary.onTimePct == null ? '--' : `${summary.onTimePct}%`} />
          <MetricCard
            label="Desviación ETA"
            value={summary.averageVarianceMinutes == null
              ? '--'
              : `${summary.averageVarianceMinutes > 0 ? '+' : ''}${formatMinutes(summary.averageVarianceMinutes)}`}
          />
        </section>

        <section className="kitchen-safe-content space-y-3 pb-5">
          {history.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#303041] bg-[#101018] px-4 py-10 text-center text-sm text-[#8A8A96]">
              No hay pedidos preparados en esta fecha.
            </div>
          ) : null}
          {history.map((order) => (
            <article key={order.id} className="rounded-2xl border border-[#2A2A38] bg-[#101018] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-black text-[#FEEF00]">Orden #{formatOrderDisplayNumber(order.id)}</div>
                  <div className="mt-1 truncate text-sm font-semibold">{order.clientName}</div>
                  <div className="mt-1 text-xs text-[#8A8A96]">Lista {formatDateTime(order.readyAt)}</div>
                </div>
                <span className="rounded-full border border-[#303041] px-2 py-1 text-xs text-[#C9C9D4]">
                  {getOrderStatusLabel(order.status, order.fulfillment)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <MetricCell label="Compromiso" value={formatMinutes(order.metric?.committedMinutes ?? null)} />
                <MetricCell label="Real" value={formatMinutes(order.metric?.actualMinutes ?? null)} />
                <MetricCell
                  label="Resultado"
                  value={order.metric?.varianceMinutes == null
                    ? '--'
                    : order.metric.onTime
                      ? `${Math.abs(order.metric.varianceMinutes)} min antes`
                      : `+${order.metric.varianceMinutes} min`}
                  tone={order.metric?.onTime == null ? 'muted' : order.metric.onTime ? 'good' : 'warn'}
                />
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#2A2A38] bg-[#121218] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[#8A8A96]">{label}</div>
      <div className="mt-1 text-lg font-black text-[#FEEF00]">{value}</div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'good' | 'warn';
}) {
  const toneClass = tone === 'good' ? 'text-emerald-200' : tone === 'warn' ? 'text-red-200' : 'text-[#F5F5F7]';
  return (
    <div className="rounded-xl border border-[#242433] bg-[#0B0B10] px-2 py-2">
      <div className="text-[10px] uppercase tracking-[0.1em] text-[#8A8A96]">{label}</div>
      <div className={`mt-1 text-sm font-black ${toneClass}`}>{value}</div>
    </div>
  );
}
