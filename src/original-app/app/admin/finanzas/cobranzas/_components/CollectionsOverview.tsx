import Link from '@/components/navigation/ContextLink';
import { queryAction } from '@/components/ui/QueryControls';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { normalizePhone } from '@/lib/phone/normalize-phone';
import {
  collectionHref, collectionSources, collectionStages,
  type CollectionFilters, type CollectionOrder, type CollectionsOverview as Overview,
} from '@/lib/admin-finance/collections-model';
import CollectionRefresh from './CollectionRefresh';
import CollectionFiltersForm from './CollectionFiltersForm';

const money = (n: number) => new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
const date = (s: string | null) => s ? s.split('-').reverse().join('/') : '—';

const action = queryAction;
function OrderActions({ order }: { order: CollectionOrder }) {
  const phone = normalizePhone(order.clientPhone);
  return <div className="flex flex-wrap gap-1.5">
    <Link className={action} prefetch={false} href={`/app/admin/ordenes?openOrder=${order.id}&tab=pagos`}>Ver pagos</Link>
    {phone ? <a className={action} href={`https://wa.me/${phone.slice(1)}`} target="_blank" rel="noopener noreferrer" aria-label={`Contactar al cliente de la orden ${formatOrderDisplayNumber(order.id)}`}>WhatsApp</a>
      : <span className="self-center text-[11px] text-[#B7B7C2]">Sin teléfono</span>}
  </div>;
}
function People({ order }: { order: CollectionOrder }) {
  return <><div className="text-zinc-200">{order.creatorName}</div>
    {order.advisorId && order.advisorId !== order.creatorId && <div className="mt-0.5 text-[11px] text-zinc-400">Asesor: {order.advisorName ?? 'Sin nombre'}</div>}</>;
}
function Review({ order }: { order: CollectionOrder }) {
  return order.reviewCount > 0 ? <div className="mt-1 text-[11px] text-amber-200">{money(order.reviewUsd)} por verificar</div> : null;
}
export default function CollectionsOverview({ data, filters }: { data: Overview; filters: CollectionFilters }) {
  return <div className="space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><h1 className="text-xl font-semibold text-white">Cobranzas</h1><p className="mt-1 text-xs text-zinc-400">{data.totals.orders} órdenes · por fecha de {filters.basis === 'created' ? 'creación' : 'entrega'} · saldo actual</p></div>
      <CollectionRefresh asOf={data.asOf} />
    </header>
    <section aria-label="Totales de todas las órdenes filtradas" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {[
        ['Total con impuesto', data.totals.totalUsd, false], ['Pagos aplicados', data.totals.coveredUsd, false],
        ['Pendiente', data.totals.pendingUsd, true], ['Pagos por verificar', data.totals.reviewUsd, false],
      ].map(([label, amount, highlight]) => <article key={String(label)} className={`rounded-xl border p-3 ${highlight ? 'border-[#FFFF00]/40 bg-[#FFFF00]/5' : 'border-zinc-800 bg-[#111117]'}`}>
        <p className="text-xs text-zinc-400">{label}</p><p className={`mt-1 text-base font-semibold tabular-nums ${highlight ? 'text-[#FFFF00]' : 'text-white'}`}>{money(Number(amount))}</p>
      </article>)}
    </section>
    <CollectionFiltersForm key={JSON.stringify(filters)} filters={filters} people={data.people} todayIso={data.asOf} />
    <details className="text-xs text-zinc-400"><summary className="cursor-pointer py-1">Cómo comparar las cifras</summary>
      <p className="mt-1">Estos totales abarcan todas las páginas de los filtros elegidos, no solo las filas visibles. Inicio y Órdenes usan fecha programada; aquí se usa creación o entrega. Pagos aplicados se limita al total de cada orden: no incluye excedentes a favor del cliente ni sustituye el saldo pendiente canónico. Las comisiones son obligaciones con el asesor al corte de cálculo, no deuda actual del cliente.</p>
    </details>
    {data.totals.reviewCount > 0 && <p className="rounded-lg border border-amber-200/20 bg-amber-200/5 px-3 py-2 text-xs text-amber-100">Hay {data.totals.reviewCount} pagos por verificar. No están descontados del pendiente: revisa el reporte antes de volver a cobrar.</p>}
    <div className="flex flex-wrap justify-between gap-2 text-xs text-zinc-400">
      <span>Saldos vigentes al momento de esta consulta, sin actualización automática. Canceladas no suman deuda.</span>
      <Link href="/app/admin/finanzas/cartera" prefetch={false} className="underline">Ver puntualidad de cobros</Link>
    </div>
    {data.orders.length === 0 ? <div className="rounded-xl border border-zinc-800 p-6 text-center text-sm text-zinc-400">No hay órdenes que coincidan con estos filtros.</div> : <>
      <div className="hidden overflow-x-auto rounded-xl border border-zinc-800 xl:block">
        <table className="w-full text-left text-xs"><caption className="sr-only">Órdenes y saldos actuales. Los totales superiores abarcan todas las páginas.</caption>
          <thead className="bg-[#19191f] text-zinc-400"><tr>{['Orden / fecha', 'Cliente', 'Creada por / asesor', 'Total', 'Cubierto', 'Pendiente', 'Acciones'].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{data.orders.map(o => <tr key={o.id} className="border-t border-zinc-800 align-top">
            <td className="px-3 py-3"><Link href={`/app/admin/ordenes?openOrder=${o.id}&tab=pagos`} prefetch={false} className="font-semibold text-yellow-200">#{formatOrderDisplayNumber(o.id)}</Link><div className="mt-1 text-zinc-400">{date(filters.basis === 'created' ? o.createdDate : o.deliveredDate)}</div><div className="mt-1 text-[11px] text-[#B7B7C2]">{collectionStages[o.stage as keyof typeof collectionStages] ?? o.stage}</div></td>
            <td className="max-w-52 px-3 py-3"><div className="font-medium text-white">{o.clientName}</div><div className="mt-1 text-[11px] text-zinc-400">{o.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} · {collectionSources[o.source as keyof typeof collectionSources] ?? o.source}</div></td>
            <td className="max-w-44 px-3 py-3"><People order={o} /></td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{money(o.totalUsd)}</td><td className="whitespace-nowrap px-3 py-3 tabular-nums">{money(o.coveredUsd)}</td>
            <td className="whitespace-nowrap px-3 py-3 tabular-nums"><span className={o.pendingUsd > 0.005 ? 'font-semibold text-yellow-200' : 'text-emerald-200'}>{o.stage === 'cancelled' ? 'Cancelada' : money(o.pendingUsd)}</span><Review order={o} /></td>
            <td className="px-3 py-3"><OrderActions order={o} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:hidden">{data.orders.map(o => <article key={o.id} className="min-w-0 rounded-xl border border-zinc-800 bg-[#111117] p-3 text-xs">
        <div className="flex items-start justify-between gap-2"><div><Link href={`/app/admin/ordenes?openOrder=${o.id}&tab=pagos`} prefetch={false} className="font-semibold text-yellow-200">#{formatOrderDisplayNumber(o.id)}</Link> <span className="text-white">{o.clientName}</span></div><span className="whitespace-nowrap font-semibold text-yellow-200">{o.stage === 'cancelled' ? 'Cancelada' : money(o.pendingUsd)}</span></div>
        <div className="my-2 text-[11px] text-zinc-400">{date(filters.basis === 'created' ? o.createdDate : o.deliveredDate)} · {o.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} · {collectionStages[o.stage as keyof typeof collectionStages] ?? o.stage}</div>
        <People order={o} /><div className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-zinc-400"><span>Total {money(o.totalUsd)}</span><span>Cubierto {money(o.coveredUsd)}</span><span>Pendiente {money(o.pendingUsd)}</span></div><Review order={o} /><div className="mt-2"><OrderActions order={o} /></div>
      </article>)}</div>
    </>}
    <nav aria-label="Páginas de cobranzas" className="flex items-center justify-between gap-2 text-xs text-zinc-400">
      {data.page > 1 ? <Link className={action} prefetch={false} href={collectionHref(filters, { page: data.page - 1 })}>Anterior</Link> : <span />}
      <span>Página {data.page} de {data.pages} · {data.totals.orders} órdenes</span>
      {data.page < data.pages ? <Link className={action} prefetch={false} href={collectionHref(filters, { page: data.page + 1 })}>Siguiente</Link> : <span />}
    </nav>
  </div>;
}
