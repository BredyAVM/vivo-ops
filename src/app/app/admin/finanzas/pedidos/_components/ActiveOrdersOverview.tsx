import Link from 'next/link';
import {
  ACTIVE_ORDER_WINDOWS, activeOrderWindow, filterActiveOrders, summarizeActiveOrders,
  type ActiveOrder, type ActiveOrdersFilters, type ActiveOrdersOverview as Overview, type ActiveOrderWindow,
} from '@/lib/admin-finance/active-orders-model';
import { getOrderStatusLabel } from '@/lib/orders/order-labels';

const basePath = '/app/admin/finanzas/pedidos';
const windowLabels: Record<ActiveOrderWindow, string> = {
  all: 'Todos', past: 'Fecha pasada', today: 'Hoy', next7: 'Próximos 7 días', later: 'Más adelante', unscheduled: 'Sin fecha',
};
const moneyFormat = new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dayFormat = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Caracas' });
const cutoffFormat = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
const control = 'min-h-11 rounded-xl border border-[#30303D] bg-[#111117] px-3 text-sm text-white focus-visible:outline-2 focus-visible:outline-[#FEEF00]';

function href(filters: ActiveOrdersFilters, patch: Partial<ActiveOrdersFilters> = {}) {
  const next = { ...filters, page: 1, ...patch };
  const params = new URLSearchParams({ agenda: next.window, pago: next.payment, q: next.q, page: String(next.page) });
  return `${basePath}?${params}`;
}
function schedule(order: ActiveOrder) {
  return order.scheduledDate ? `${dayFormat.format(new Date(`${order.scheduledDate}T12:00:00Z`))}${order.scheduledTime ? ` · ${order.scheduledTime}` : ''}` : 'Sin fecha';
}
function orderHref(order: ActiveOrder) {
  return `/app/master/ops?openOrder=${order.id}&tab=pagos`;
}
function OrderAlerts({ order, today }: { order: ActiveOrder; today: string }) {
  const labels = [
    order.needsReview ? 'Reaprobación pendiente' : null,
    order.scheduledDate && order.scheduledDate < today ? 'Revisar agenda' : null,
    order.pendingReportsCount > 0 ? `${order.pendingReportsCount} pago(s) por validar` : null,
    order.pendingUsd > order.totalUsd ? 'Saldo superior al total: revisar' : null,
  ].filter(Boolean);
  return labels.length ? <p className="mt-1 text-xs text-orange-200">{labels.join(' · ')}</p> : null;
}

export default function ActiveOrdersOverview({ overview, filters }: { overview: Overview; filters: ActiveOrdersFilters }) {
  const result = filterActiveOrders(overview, filters);
  const totals = result.summary;
  const filtered = filters.window !== 'all' || filters.payment !== 'all' || Boolean(filters.q);
  const cards = [
    { label: 'Por entregar', value: String(totals.orders), help: 'Pedidos aprobados aún no entregados, incluso los cubiertos completamente.' },
    { label: 'Contratado', value: moneyFormat.format(totals.totalUsd), help: 'Total contractual con impuesto. Aún no es facturación entregada.' },
    { label: 'Cubierto', value: moneyFormat.format(totals.coveredUsd), help: 'Total menos saldo canónico, limitado al total. Incluye abonos, fondos aplicados y ajustes; no es caja del día.' },
    { label: 'Por cobrar', value: moneyFormat.format(totals.pendingUsd), help: 'Saldo actual de estos pedidos, separado de la cartera entregada. No es una promesa de fecha de pago.' },
  ];
  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-white">Pedidos por entregar</h1>
        <p className="mt-1 text-xs text-[#A3A3AE]">Saldo actual · USD · {cutoffFormat.format(new Date(overview.asOf))}</p></div>
      <div className="flex flex-wrap gap-2">
        <Link href="/app/admin/finanzas/cartera" prefetch={false} className={`${control} inline-flex items-center`}>Cartera entregada →</Link>
        <form action={basePath} method="get">
          <input type="hidden" name="agenda" value={filters.window} /><input type="hidden" name="pago" value={filters.payment} />
          <input type="hidden" name="q" value={filters.q} /><input type="hidden" name="page" value={result.page} />
          <button type="submit" className={control}>Actualizar</button>
        </form>
      </div>
    </header>
    <section aria-label="Indicadores de pedidos seleccionados">
      {filtered ? <p className="mb-2 text-xs text-[#A3A3AE]">Selección: {totals.orders} de {overview.summary.orders} pedidos</p> : null}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{cards.map(card => <article key={card.label} title={card.help} className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-3 sm:p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#A3A3AE]">{card.label}</h2>
        <p className={`mt-2 break-words text-xl font-semibold tracking-tight tabular-nums sm:text-2xl ${card.label === 'Por cobrar' ? 'text-[#FEEF00]' : 'text-white'}`}>{card.value}</p>
      </article>)}</div>
      <p className="mt-2 text-xs text-[#A3A3AE]">Agrupados por entrega programada; no por fecha prometida de pago. Cubierto incluye abonos y fondos aplicados.</p>
    </section>
    <nav aria-label="Agenda de entrega" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {ACTIVE_ORDER_WINDOWS.map(window => {
        const orders = window === 'all' ? overview.orders : overview.orders.filter(order => activeOrderWindow(order.scheduledDate, overview.asOfDate) === window);
        const bucket = summarizeActiveOrders(orders);
        return <Link key={window} href={href(filters, { window, payment: 'all', q: '' })} prefetch={false}
          aria-current={filters.window === window ? 'page' : undefined}
          className={`min-w-0 rounded-xl border p-3 focus-visible:outline-2 focus-visible:outline-[#FEEF00] ${filters.window === window ? 'border-[#FEEF00]/70 bg-[#FEEF00]/5' : 'border-[#292937] bg-[#111117]'}`}>
          <span className="text-xs text-[#B7B7C2]">{windowLabels[window]} · {bucket.orders}</span>
          <p className="mt-1 font-semibold text-white tabular-nums">{moneyFormat.format(bucket.pendingUsd)}</p>
          <span className="text-[10px] text-[#A3A3AE]">por cobrar</span>
        </Link>;
      })}
    </nav>
    <form key={`${filters.window}:${filters.payment}:${filters.q}`} action={basePath} method="get" className="flex flex-wrap gap-2">
      <input type="hidden" name="agenda" value={filters.window} />
      <label className="min-w-0 flex-1 basis-52"><span className="sr-only">Buscar pedido, cliente o asesor</span>
        <input name="q" defaultValue={filters.q} maxLength={80} placeholder="Pedido, cliente o asesor" className={`${control} w-full`} /></label>
      <label><span className="sr-only">Estado del pago</span>
        <select name="pago" defaultValue={filters.payment} className={control}>
          <option value="all">Todos los pagos</option><option value="pending">Con saldo por cobrar</option>
          <option value="covered">Cubiertos</option><option value="review">Pagos por validar</option>
        </select></label>
      <button type="submit" className={`${control} font-semibold`}>Filtrar</button>
      {filtered ? <Link href={basePath} prefetch={false} className={`${control} inline-flex items-center`}>Limpiar</Link> : null}
    </form>
    {totals.pendingReportsCount > 0 ? <Link href={href(filters, { payment: 'review' })} prefetch={false} className="block rounded-xl border border-orange-300/20 bg-orange-300/5 p-3 text-sm text-orange-200">
      {totals.pendingReportsCount} pagos por validar · {moneyFormat.format(totals.pendingReportsUsd)} — aún no reducen el saldo →
    </Link> : null}
    {totals.reviewOrders || totals.unscheduledOrders ? <p className="text-xs text-orange-200">{totals.reviewOrders} pedidos requieren reaprobación · {totals.unscheduledOrders} sin fecha válida. Sus importes permanecen visibles.</p> : null}
    {result.orders.length === 0 ? <p className="rounded-2xl border border-[#292937] p-6 text-sm text-[#B7B7C2]">{overview.summary.orders === 0 ? 'No hay pedidos aprobados pendientes de entrega.' : 'No hay pedidos con estos filtros.'}</p> : <>
      <div className="hidden overflow-x-auto rounded-2xl border border-[#292937] lg:block">
        <table className="w-full text-left text-sm"><caption className="sr-only">Pedidos seleccionados: importes USD. Los totales incluyen todas las páginas.</caption>
          <thead className="bg-[#191920] text-xs text-[#A3A3AE]"><tr>{['Pedido / cliente', 'Agenda', 'Etapa', 'Contratado', 'Cubierto', 'Por cobrar'].map((label, index) => <th key={label} scope="col" className={`px-3 py-3 ${index > 2 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-[#292937]">{result.orders.map(order => <tr key={order.id} className="bg-[#111117]">
            <td className="max-w-64 px-3 py-3"><Link href={orderHref(order)} prefetch={false} className="font-semibold text-white hover:text-[#FEEF00]">{order.orderNumber} →</Link><p className="break-words text-[#C8C8D0]">{order.clientName}</p><p className="text-xs text-[#A3A3AE]">{order.advisorName}</p><OrderAlerts order={order} today={overview.asOfDate} /></td>
            <td className="px-3 py-3 text-[#C8C8D0]">{schedule(order)}<p className="text-xs text-[#A3A3AE]">{order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</p></td>
            <td className="px-3 py-3 text-[#C8C8D0]">{getOrderStatusLabel(order.status)}</td>
            <td className="px-3 py-3 text-right text-white tabular-nums">{moneyFormat.format(order.totalUsd)}</td>
            <td className="px-3 py-3 text-right text-emerald-200 tabular-nums">{moneyFormat.format(order.coveredUsd)}</td>
            <td className="px-3 py-3 text-right font-semibold text-[#FEEF00] tabular-nums">{moneyFormat.format(order.pendingUsd)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="grid gap-3 lg:hidden">{result.orders.map(order => <Link key={order.id} href={orderHref(order)} prefetch={false} className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-3 focus-visible:outline-2 focus-visible:outline-[#FEEF00]">
        <div className="flex items-start justify-between gap-2"><p className="min-w-0 break-words font-semibold text-white">{order.orderNumber} · {order.clientName}</p><span className="text-xs text-[#B7B7C2]">{getOrderStatusLabel(order.status)} →</span></div>
        <p className="mt-1 text-xs text-[#A3A3AE]">{schedule(order)} · {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</p>
        <p className="mt-1 text-xs text-[#A3A3AE]">{order.advisorName}</p>
        <dl className="mt-3 grid grid-cols-3 gap-2">{[['Contratado', order.totalUsd], ['Cubierto', order.coveredUsd], ['Por cobrar', order.pendingUsd]].map(([label, amount]) => <div key={label} className="min-w-0"><dt className="text-[10px] text-[#A3A3AE]">{label}</dt><dd className={`break-words text-sm font-semibold tabular-nums ${label === 'Por cobrar' ? 'text-[#FEEF00]' : 'text-white'}`}>{moneyFormat.format(Number(amount))}</dd></div>)}</dl>
        <OrderAlerts order={order} today={overview.asOfDate} />
      </Link>)}</div>
    </>}
    <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#A3A3AE]">
      {result.page > 1 ? <Link href={href(filters, { page: result.page - 1 })} prefetch={false} className={`${control} inline-flex items-center`}>← Anterior</Link> : <span />}
      <p>{totals.orders} pedidos · Página {result.page} de {result.pages}</p>
      {result.page < result.pages ? <Link href={href(filters, { page: result.page + 1 })} prefetch={false} className={`${control} inline-flex items-center`}>Siguiente →</Link> : <span />}
    </footer>
    <details className="text-xs text-[#A3A3AE]"><summary className="cursor-pointer py-2">Qué incluyen estos números</summary>
      <p className="mt-2 max-w-3xl leading-relaxed">Pedidos aprobados en cola, cocina, listos o en camino. Contratado incluye impuesto; aún no es facturación entregada. Cubierto es la obligación saldada según el cálculo financiero de la orden, no efectivo ingresado hoy. Los pagos por validar no se descuentan. Una fecha pasada pide revisar la agenda, no significa crédito vencido. Los pedidos devueltos a creación, cancelados o entregados están excluidos.</p>
    </details>
  </div>;
}
