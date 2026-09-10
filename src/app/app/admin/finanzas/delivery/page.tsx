import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadDeliveryOverview, type DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';
import { deliveryFilters, deliveryHref, deliveryOrderHref } from '@/lib/admin-finance/delivery-model';
import { AdminKpi, AdminPagination, AdminReadError, adminInput, adminPanel } from '../../_components/AdminReadUi';

const usd = new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD' });
const date = new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
const modes = { internal: 'Interno', external: 'Externo', unassigned: 'Sin asignar' };
const statuses = { open: 'Abierta', partial: 'Parcial', discrepancy: 'Con diferencia' };
export default async function AdminDeliveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  let filters;
  try { filters = deliveryFilters(await searchParams); } catch (error) {
    return <AdminReadError title="Delivery" message={error instanceof Error ? error.message : 'Fechas inválidas.'} />;
  }
  const result = await loadDeliveryOverview(ctx.supabase as unknown as DeliveryRpcClient, filters);
  if (result.status === 'error') return <AdminReadError title="Delivery no disponible" message={result.message} />;
  const data = result.data;
  const missing = data.summary.deliveries - data.summary.costed;
  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Delivery</h1><p className="mt-1 text-xs text-[#9B9BA7]">Entregas realizadas · {date.format(new Date(data.asOf))}</p></div><Link href="/app/counter" prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">Operar en Mostrador →</Link></header>
    <form className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-[#B9B9C4]">Desde<input type="date" name="from" defaultValue={filters.from} required className={adminInput} /></label>
      <label className="grid gap-1 text-xs text-[#B9B9C4]">Hasta<input type="date" name="to" defaultValue={filters.to} required className={adminInput} /></label>
      <label className="grid gap-1 text-xs text-[#B9B9C4]">Servicio<select name="mode" defaultValue={filters.mode} className={adminInput}><option value="all">Todos</option><option value="internal">Interno</option><option value="external">Externo</option><option value="unassigned">Sin asignar</option></select></label>
      <label className="grid min-w-0 flex-1 gap-1 text-xs text-[#B9B9C4]">Orden, cliente o responsable<input name="q" maxLength={80} defaultValue={filters.q} className={adminInput} /></label>
      <button className={`${adminInput} font-semibold`}>Consultar</button>
    </form>
    <section aria-label="Indicadores de entregas" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <AdminKpi label="Entregas" value={data.summary.deliveries} hint={`${data.summary.internal} internas · ${data.summary.external} externas · ${data.summary.unassigned} sin asignar`} />
      <AdminKpi label="Costo guardado" value={usd.format(data.summary.knownCostUsd)} hint={missing ? `Subtotal parcial: faltan ${missing} costos` : 'Costo del servicio; no es pago realizado'} />
      <AdminKpi label="Cobertura de costos" value={`${data.summary.costed}/${data.summary.deliveries}`} hint="Sin costo guardado no significa costo cero" />
      <AdminKpi label="Liquidaciones en esta página" value={`${data.settlements.length}${data.nextSettlementCursor ? '+' : ''}`} hint="Pendientes de todos los períodos" />
    </section>
    {data.undatedDeliveries > 0 ? <p role="status" className="text-xs text-orange-200">{data.undatedDeliveries} entregas históricas no tienen evento de entrega fechable y quedan fuera de cualquier período.</p> : null}
    <section className={adminPanel} aria-labelledby="delivery-orders"><h2 id="delivery-orders" className="text-sm font-semibold">Detalle del período</h2>
      <div className="mt-3 divide-y divide-[#292937]">{data.rows.map(row => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0"><Link href={deliveryOrderHref(row)} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-white underline">#{row.orderNumber} · {row.clientName}</Link><p className="text-xs text-[#A3A3AE]">{modes[row.mode]} · {row.responsible} · {date.format(new Date(row.deliveredAt))}</p></div>
        <div className="text-right"><p className="text-sm font-semibold tabular-nums">{row.costUsd === null ? 'Sin costo guardado' : usd.format(row.costUsd)}</p><p className="mt-1 text-xs text-[#9B9BA7]">{row.costSource ? 'Fuente registrada' : 'Sin fuente de costo'}</p></div>
      </article>)}{!data.rows.length ? <p className="py-5 text-sm text-[#9B9BA7]">No hay entregas en esta página. Ajusta los filtros o vuelve a la primera página.</p> : null}</div>
      <AdminPagination page={filters.page} total={data.summary.deliveries} href={page => deliveryHref(filters, { page })} />
    </section>
    <section id="liquidaciones" className={adminPanel}><h2 className="text-sm font-semibold">Retornos y liquidaciones pendientes</h2><p className="mt-1 text-xs text-[#9B9BA7]">No se filtran por fecha de entrega. Consulta el efectivo y los cambios en cada detalle.</p>
      <div className="mt-3 divide-y divide-[#292937]">{data.settlements.map(row => <Link key={row.id} href={`/app/admin/finanzas/delivery/${row.id}`} prefetch={false} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p>#{row.orderNumber} · {row.responsible}</p><p className="mt-1 text-xs text-[#9B9BA7]">Salida {date.format(new Date(row.dispatchedAt))}</p></div><span className="text-orange-200">{statuses[row.status]} →</span></Link>)}{!data.settlements.length ? <p className="py-4 text-sm text-[#9B9BA7]">Sin liquidaciones abiertas en esta página.</p> : null}</div>
      <nav aria-label="Páginas de liquidaciones" className="flex gap-4 text-xs">{filters.settlementBefore ? <Link href={`${deliveryHref(filters, { settlementBefore: '', settlementId: '' })}#liquidaciones`} prefetch={false} className="inline-flex min-h-11 items-center underline">Más recientes</Link> : null}{data.nextSettlementCursor ? <Link href={`${deliveryHref(filters, { settlementBefore: data.nextSettlementCursor.dispatchedAt, settlementId: String(data.nextSettlementCursor.id) })}#liquidaciones`} prefetch={false} className="inline-flex min-h-11 items-center underline">Más antiguas →</Link> : null}</nav>
    </section>
    <details className={`${adminPanel} text-xs text-[#B9B9C4]`}><summary className="cursor-pointer">Alcance de las cifras</summary><p className="mt-3">La fecha corresponde al último evento de entrega de una orden actualmente entregada. El costo proviene del registro guardado en la orden; no se reconstruye con tarifas actuales. No representa el cargo al cliente, un pago al repartidor ni un margen certificado. Los importes de custodia se consultan por moneda en el detalle de liquidación.</p></details>
  </div>;
}
