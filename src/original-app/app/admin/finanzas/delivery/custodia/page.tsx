import Link from 'next/link';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { requireAdminContext } from '@/lib/auth';
import { deliveryFilters } from '@/lib/admin-finance/delivery-model';
import { loadDeliveryOverview, type DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';
import { AdminReadError, adminPanel } from '../../../_components/AdminReadUi';
export default async function DeliveryCustodyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  let filters, data;
  try {
    filters = deliveryFilters(await searchParams);
    const result = await loadDeliveryOverview(ctx.supabase as unknown as DeliveryRpcClient, filters);
    if (result.status === 'error') throw new Error(result.message);
    data = result.data;
  } catch (error) { return <AdminReadError title="Custodia no disponible" message={error instanceof Error ? error.message : 'Error al consultar retornos.'} />; }
  return <div className="space-y-4"><Link href="/app/admin/finanzas/delivery" className="inline-flex min-h-11 items-center text-sm underline">← Servicios y pagos</Link>
      <h1 className="text-xl font-semibold">Cobros y cambios en custodia</h1><p className="text-xs text-[#B9B9C4]">Dinero de clientes y cambios pendientes de devolver. No es el pago por hacer deliveries. Incluye todos los períodos.</p>
      <section className={adminPanel}>{data.settlements.map(row => <Link key={row.id} href={`/app/admin/finanzas/delivery/${row.id}`} prefetch={false} className="flex min-h-14 items-center justify-between gap-3 border-b border-[#292937] py-3 text-sm"><span>#{formatOrderDisplayNumber(row.orderId)} · {row.responsible}</span><span>{row.status === 'open' ? 'Abierta' : row.status === 'partial' ? 'Parcial' : 'Con diferencia'} →</span></Link>)}
        {!data.settlements.length ? <p className="text-sm">No hay retornos pendientes en esta página.</p> : null}
        <nav className="flex gap-4 text-xs">{filters.settlementBefore ? <Link href="/app/admin/finanzas/delivery/custodia" className="inline-flex min-h-11 items-center underline">Más recientes</Link> : null}
          {data.nextSettlementCursor ? <Link href={`/app/admin/finanzas/delivery/custodia?${new URLSearchParams({ settlementBefore: data.nextSettlementCursor.dispatchedAt, settlementId: String(data.nextSettlementCursor.id) })}`} className="inline-flex min-h-11 items-center underline">Más antiguas →</Link> : null}</nav>
      </section></div>;
}
