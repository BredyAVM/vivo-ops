import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { loadExpenseReview } from '@/lib/admin-finance/authorizations-data';
import { AdminReadError, adminPanel } from '../../../_components/AdminReadUi';
import ExpenseDecisionForm from './ExpenseDecisionForm';

export const dynamic = 'force-dynamic';
export default async function ExpenseReviewPage({ params }: { params: Promise<{ movementId: string }> }) {
  await requireAdminContext();
  const movementId = Number((await params).movementId);
  if (!Number.isSafeInteger(movementId) || movementId <= 0) notFound();
  let review;
  try { review = await loadExpenseReview(movementId); } catch {
    return <AdminReadError title="Revisar egreso" message="No se pudo cargar el movimiento. Actualiza la página o vuelve a Autorizaciones." />;
  }
  const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
  const statusLabels: Record<string, string> = { pending: 'Pendiente', confirmed: 'Confirmado', rejected: 'Rechazado', voided: 'Anulado' };
  const sameCurrency = new Set(review.rows.map(r => r.currency)).size === 1;
  const onlyOutflows = review.rows.every(r => r.direction === 'outflow');
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Revisar egreso #{movementId}</h1><Link href="/app/admin/autorizaciones?tipo=expense" prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">← Autorizaciones</Link></header>
    <section className={adminPanel}><h2 className="text-xs text-[#B9B9C4]">{onlyOutflows ? 'Salida registrada · incluye comisión' : 'Importes de la operación'}</h2><p className="mt-1 text-xl font-semibold tabular-nums">{sameCurrency && onlyOutflows ? `${review.rows[0].currency} ${money.format(review.rows.reduce((sum, r) => sum + r.amount, 0))}` : 'Revisar entradas y salidas por separado'}</p><p className="mt-1 text-xs text-[#9B9BA7]">Aprobar registra la salida en VIVO; no ejecuta un pago bancario.</p></section>
    <div className="grid gap-3 lg:grid-cols-2">{review.rows.map(row => <article key={row.id} className={`${adminPanel} space-y-3`}>
      <div className="flex flex-wrap justify-between gap-2"><h2 className="text-sm font-semibold">{row.type === 'fee_charge' ? 'Comisión' : row.direction === 'outflow' ? 'Salida' : 'Entrada'} #{row.id}</h2><span className="text-xs">{statusLabels[row.status] ?? row.status}</span></div>
      <p className="text-sm font-semibold tabular-nums">{row.accountName} · {row.currency} {money.format(row.amount)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm"><dt className="text-[#9B9BA7]">Concepto</dt><dd className="break-words">{row.description || 'No registrado'}</dd>
        <dt className="text-[#9B9BA7]">Fecha</dt><dd>{row.date}</dd><dt className="text-[#9B9BA7]">Registró</dt><dd>{row.creator}<span className="block text-xs text-[#9B9BA7]">{date.format(new Date(row.createdAt))}</span></dd>
        <dt className="text-[#9B9BA7]">Beneficiario</dt><dd>{row.counterparty || 'No registrado'}</dd><dt className="text-[#9B9BA7]">Referencia</dt><dd className="break-all">{row.reference || 'No registrada'}</dd>
        {row.rate !== null ? <><dt className="text-[#9B9BA7]">Tasa / USD</dt><dd>{money.format(row.rate)} · USD {money.format(row.amountUsd)}</dd></> : null}
      </dl>
      {row.approvalReason ? <p className="text-xs text-orange-200">{row.approvalReason}</p> : null}
      {row.notes ? <p className="break-words text-sm text-[#B9B9C4]">{row.notes}</p> : null}
      {row.reviewedAt ? <p className="text-xs text-[#B9B9C4]">Revisó {row.reviewer} · {date.format(new Date(row.reviewedAt))}{row.rejectionReason ? ` · ${row.rejectionReason}` : ''}</p> : null}
      <Link href={`/app/admin/finanzas/cuentas/${row.accountId}?vista=movements&estado=all&desde=${row.date}&hasta=${row.date}`} prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">Ver historial de cuenta →</Link>
    </article>)}</div>
    <section className={adminPanel}>{review.eligible ? <ExpenseDecisionForm key={review.snapshot} movementId={movementId} snapshot={review.snapshot} /> : <div className="space-y-2"><p className="text-sm">Este movimiento ya fue resuelto o requiere su proceso de origen. No se puede aprobar como un egreso simple.</p><Link href="/app/master/dashboard?adminSection=accounts" prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">Abrir revisión financiera vigente →</Link></div>}</section>
  </div>;
}
