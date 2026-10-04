import Link from '@/components/navigation/ContextLink';
import BackLink from '@/components/navigation/BackLink';
import { queryAction } from '@/components/ui/QueryControls';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminOrderReview } from '@/lib/admin-finance/order-review-data';
import { AdminReadError, adminPanel } from '../../../_components/AdminReadUi';
import OrderReviewForm from './OrderReviewForm';
export const dynamic = 'force-dynamic';
export default async function AdminOrderReviewPage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireAdminContext();
  const orderId = Number((await params).orderId); if (!Number.isSafeInteger(orderId) || orderId <= 0) notFound();
  let r;
  try { r = await loadAdminOrderReview(orderId); } catch { return <AdminReadError title="Revisar orden" message="No se pudo cargar la revisión completa. No se ha aprobado la orden." />; }
  const usd = (value: number) => new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD' }).format(value);
  const editHref = `/app/admin/ordenes?${new URLSearchParams({ openOrder: String(orderId), ...(r.date ? { focusDate: r.date } : {}) })}`;
  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap justify-between gap-2"><div className="min-w-0"><h1 className="break-words text-lg font-semibold text-[#DEDEE6]">Orden #{formatOrderDisplayNumber(r.id)} · {r.client}</h1><p className="mt-1 text-xs text-[#B9B9C4]">{r.advisor} · {r.date || 'Sin fecha'} {r.time} · {r.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</p></div><BackLink fallbackHref="/app/admin/autorizaciones" className={queryAction}>← Volver</BackLink></header>
    <section aria-label="Estado financiero actual" className="grid grid-cols-2 gap-2 lg:grid-cols-4">{[['Total', r.totalUsd], ['Abonado confirmado', r.confirmedUsd], ['Fondo aplicado', r.fundUsedUsd], ['Pendiente', r.pendingUsd]].map(([label, value]) => <article key={String(label)} className={`${adminPanel} min-w-0`}><h2 className="text-[11px] text-[#B7B7C2]">{label}</h2><p className="mt-1 break-words text-sm font-semibold tabular-nums text-[#DEDEE6]">{usd(Number(value))}</p></article>)}</section>
    {r.reportedUsd > 0 || r.overpaidUsd > 0 ? <p className="text-xs text-orange-200">{r.reportedUsd > 0 ? `${usd(r.reportedUsd)} reportados sin confirmar. ` : ''}{r.overpaidUsd > 0 ? `${usd(r.overpaidUsd)} a favor en la orden.` : ''} Aprobar la orden no confirma pagos.</p> : null}
    <section className={adminPanel}><h2 className="text-sm font-semibold">Pedido vigente</h2><ul className="mt-2 divide-y divide-[#292937]">{r.items.map(i => <li key={i.id} className="flex flex-wrap justify-between gap-2 py-2"><div className="min-w-0 flex-1"><p className="break-words text-xs">{i.qty} × {i.name}</p>{i.notes ? <p className="mt-1 whitespace-pre-line break-words text-xs text-[#B7B7C2]">{i.notes}</p> : null}</div><p className="text-xs tabular-nums">{usd(i.totalUsd)}</p></li>)}</ul>{r.address ? <p className="mt-2 break-words text-xs">Entrega: {r.address}</p> : null}{r.notes ? <p className="mt-2 whitespace-pre-line break-words text-xs text-[#B9B9C4]">{r.notes}</p> : null}</section>
    {r.changes.length ? <section className={adminPanel}><h2 className="text-sm font-semibold">Cambios registrados</h2><div className="mt-2 space-y-2">{r.changes.map(c => <details key={c.id} open={c.id === r.changes[0].id && r.action === 'reapprove'}><summary className="min-h-11 cursor-pointer content-center break-words text-xs md:min-h-8">{c.title} · {c.actor}</summary><p className="break-words text-xs text-[#B7B7C2]">{c.message}</p>{c.details.length ? <dl className="mt-2 divide-y divide-[#292937]">{c.details.map((d, i) => <div key={`${d.field}:${i}`} className="py-2 text-xs"><dt className="font-medium">{d.label}</dt><dd className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2"><div className="min-w-0 break-words text-[#B9B9C4]"><span className="block text-[11px] text-[#B7B7C2]">Antes</span>{d.before || 'Sin indicar'}</div><div className="min-w-0 break-words text-[#DEDEE6]"><span className="block text-[11px] text-[#B7B7C2]">Ahora</span>{d.after || 'Sin indicar'}</div></dd></div>)}</dl> : <p className="mt-2 text-xs text-orange-200">Este cambio histórico no conserva detalle antes/después. Revisa los datos vigentes; no se reconstruye un importe anterior.</p>}</details>)}</div></section> : r.action === 'reapprove' ? <p className="text-xs text-orange-200">No hay detalle histórico del cambio. Revisa el pedido vigente antes de ratificarlo.</p> : null}
    <section className={`${adminPanel} space-y-2`}><Link href={editHref} prefetch={false} className={queryAction}>Modificar, devolver o revisar operación →</Link>
      {r.action ? <OrderReviewForm key={r.snapshot} orderId={r.id} snapshot={r.snapshot} action={r.action} /> : <p className="text-xs text-[#B9B9C4]">La orden no tiene una aprobación pendiente en su estado actual.</p>}
    </section>
  </div>;
}
