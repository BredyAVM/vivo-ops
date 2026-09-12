import Link from 'next/link';
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
  const editHref = `/app/master/ops?${new URLSearchParams({ openOrder: String(orderId), returnTo: '/app/admin/autorizaciones', ...(r.date ? { focusDate: r.date } : {}) })}`;
  return <div className="space-y-4">
    <header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-xl font-semibold">Orden #{r.id} · {r.client}</h1><p className="mt-1 text-xs text-[#B9B9C4]">{r.advisor} · {r.date || 'Sin fecha'} {r.time} · {r.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</p></div><Link href="/app/admin/autorizaciones" prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">← Autorizaciones</Link></header>
    <section aria-label="Estado financiero actual" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[['Total', r.totalUsd], ['Abonado confirmado', r.confirmedUsd], ['Fondo aplicado', r.fundUsedUsd], ['Pendiente', r.pendingUsd]].map(([label, value]) => <article key={String(label)} className={adminPanel}><h2 className="text-xs text-[#9B9BA7]">{label}</h2><p className="mt-1 text-lg font-semibold tabular-nums">{usd(Number(value))}</p></article>)}</section>
    {r.reportedUsd > 0 || r.overpaidUsd > 0 ? <p className="text-xs text-orange-200">{r.reportedUsd > 0 ? `${usd(r.reportedUsd)} reportados sin confirmar. ` : ''}{r.overpaidUsd > 0 ? `${usd(r.overpaidUsd)} a favor en la orden.` : ''} Aprobar la orden no confirma pagos.</p> : null}
    <section className={adminPanel}><h2 className="text-sm font-semibold">Pedido vigente</h2><ul className="mt-2 divide-y divide-[#292937]">{r.items.map(i => <li key={i.id} className="flex justify-between gap-3 py-3"><div><p className="text-sm">{i.qty} × {i.name}</p>{i.notes ? <p className="mt-1 whitespace-pre-line text-xs text-[#9B9BA7]">{i.notes}</p> : null}</div><p className="text-sm tabular-nums">{usd(i.totalUsd)}</p></li>)}</ul>{r.address ? <p className="mt-3 text-sm">Entrega: {r.address}</p> : null}{r.notes ? <p className="mt-2 whitespace-pre-line text-sm text-[#B9B9C4]">{r.notes}</p> : null}</section>
    {r.changes.length ? <section className={adminPanel}><h2 className="text-sm font-semibold">Cambios registrados</h2><div className="mt-2 space-y-3">{r.changes.map(c => <details key={c.id} open={c.id === r.changes[0].id && r.action === 'reapprove'}><summary className="min-h-11 cursor-pointer py-3 text-sm">{c.title} · {c.actor}</summary><p className="text-xs text-[#9B9BA7]">{c.message}</p>{c.details.length ? <dl className="mt-3 space-y-2">{c.details.map((d, i) => <div key={`${d.field}:${i}`} className="text-sm"><dt className="font-semibold">{d.label}</dt><dd className="mt-1 break-words text-[#B9B9C4]">{d.before || 'Sin indicar'} → {d.after || 'Sin indicar'}</dd></div>)}</dl> : <p className="mt-2 text-xs text-orange-200">Este cambio histórico no conserva detalle antes/después. Revisa los datos vigentes; no se reconstruye un importe anterior.</p>}</details>)}</div></section> : r.action === 'reapprove' ? <p className="text-sm text-orange-200">No hay detalle histórico del cambio. Revisa el pedido vigente antes de ratificarlo.</p> : null}
    <section className={`${adminPanel} space-y-3`}><Link href={editHref} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#444450] px-4 text-sm">Modificar, devolver o revisar operación →</Link>
      {r.action ? <OrderReviewForm key={r.snapshot} orderId={r.id} snapshot={r.snapshot} action={r.action} /> : <p className="text-sm text-[#B9B9C4]">La orden no tiene una aprobación pendiente en su estado actual.</p>}
    </section>
  </div>;
}
