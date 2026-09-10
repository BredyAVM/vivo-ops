import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { getCaracasDateKey } from '@/lib/admin-finance/period';
import { loadDeliverySettlement, type DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';
import { AdminReadError, adminPanel } from '../../../_components/AdminReadUi';

const amounts = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
const states: Record<string, string> = { open: 'Abierta', partial: 'Parcial', discrepancy: 'Con diferencia', settled: 'Liquidada', voided: 'Anulada', not_required: 'No requiere liquidación' };
const entries: Record<string, string> = { expected_collection: 'Cobro esperado', customer_collection: 'Cobro declarado', cash_return: 'Efectivo devuelto', cash_change_out: 'Cambio enviado', cash_change_returned: 'Cambio devuelto', digital_change_due: 'Cambio digital previsto', digital_change_completed: 'Cambio digital completado', custody_adjustment: 'Ajuste de custodia' };
export default async function DeliverySettlementPage({ params }: { params: Promise<{ settlementId: string }> }) {
  const ctx = await requireAdminContext();
  const { settlementId } = await params;
  if (!/^[1-9]\d*$/.test(settlementId) || !Number.isSafeInteger(Number(settlementId))) notFound();
  const result = await loadDeliverySettlement(ctx.supabase as unknown as DeliveryRpcClient, Number(settlementId));
  if (result.status === 'error') return <AdminReadError title="Liquidación no disponible" message={result.message} />;
  const data = result.data;
  const orderHref = `/app/master/ops?${new URLSearchParams({ openOrder: String(data.orderId), focusDate: getCaracasDateKey(new Date(data.dispatchedAt)), tab: 'delivery' })}`;
  return <div className="space-y-5">
    <header><Link href="/app/admin/finanzas/delivery#liquidaciones" prefetch={false} className="inline-flex min-h-11 items-center text-xs underline">← Delivery</Link><h1 className="text-xl font-semibold">Liquidación · Orden #{data.orderNumber}</h1><p className="mt-2 text-sm text-[#B9B9C4]">{data.client} · {data.responsible} · {states[data.status]}</p></header>
    <div className="flex flex-wrap gap-4 text-sm"><Link href={orderHref} prefetch={false} className="inline-flex min-h-11 items-center underline">Abrir orden</Link><Link href="/app/counter" prefetch={false} className="inline-flex min-h-11 items-center underline">Gestionar retorno en Mostrador →</Link></div>
    {!data.collectionFinalized && !['not_required','voided'].includes(data.status) ? <p role="status" className="text-sm text-orange-200">El cobro aún no está finalizado. Un saldo declarado de cero no confirma que todo el dinero haya retornado.</p> : null}
    <section aria-label="Importes por moneda" className="grid gap-3 lg:grid-cols-2">{data.currencies.map(row => <article key={row.currency} className={adminPanel}><h2 className="text-sm font-semibold">{row.currency === 'VES' ? 'Bolívares (VES)' : 'Dólares (USD)'}</h2><dl className="mt-3 space-y-3 text-sm">{[
      ['Cobro esperado', row.expectedCollection], ['Cobro declarado', row.customerCollection], ['Efectivo devuelto', row.cashReturned], ['Cobrado aún en custodia', row.custodyOutstanding], ['Cambio enviado', row.cashChangeSent], ['Cambio devuelto', row.cashChangeReturned], ['Cambio digital pendiente', row.digitalChangeOutstanding],
    ].map(([label, value]) => <div key={String(label)} className="flex justify-between gap-4"><dt className="text-[#B9B9C4]">{label}</dt><dd className="font-semibold tabular-nums">{amounts.format(Number(value))}</dd></div>)}</dl></article>)}</section>
    {!data.currencies.length ? <p className="text-sm text-[#B9B9C4]">No hay líneas monetarias registradas en esta liquidación.</p> : null}
    <section className={adminPanel}><h2 className="text-sm font-semibold">Registro de liquidación</h2><p className="mt-1 text-xs text-[#9B9BA7]">Últimas {data.entries.length} entradas; los importes superiores usan el historial completo.</p><div className="mt-3 divide-y divide-[#292937]">{data.entries.map(row => <article key={row.id} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><div><p>{entries[row.type] ?? row.type}</p><p className="mt-1 text-xs text-[#9B9BA7]">{dates.format(new Date(row.createdAt))} · {row.actor}{row.account ? ` · ${row.account}` : ''}{row.reference ? ` · ${row.reference}` : ''}</p></div><p className="font-semibold tabular-nums">{row.currency} {amounts.format(row.amount)}</p></article>)}</div></section>
  </div>;
}
