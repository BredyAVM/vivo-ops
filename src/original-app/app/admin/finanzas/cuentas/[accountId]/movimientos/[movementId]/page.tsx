import Link from '@/components/navigation/ContextLink';
import BackLink from '@/components/navigation/BackLink';
import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { readAccountMovementDetail } from '@/lib/admin-finance/movement-detail-data';
import { movementReturnHref, movementVoidBlock, positiveMovementId } from '@/lib/admin-finance/movement-detail-model';
import { formatOrderConcept, formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import VoidMovementForm from './VoidMovementForm';

const statusLabels = { pending: 'Pendiente', confirmed: 'Confirmado', rejected: 'Rechazado', voided: 'Anulado' };
const typeLabels: Record<string, string> = { order_payment: 'Pago de pedido', fee_charge: 'Comisión', expense_payment: 'Egreso', change_given: 'Cambio', transfer: 'Traspaso', transfer_in: 'Traspaso recibido', transfer_out: 'Traspaso enviado', deposit: 'Ingreso', withdrawal: 'Retiro', other_income: 'Otro ingreso', adjustment: 'Ajuste' };
const number = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (amount: number, currency: string) => `${currency === 'VES' ? 'Bs' : 'USD'} ${number.format(amount)}`;

export default async function AccountMovementPage({ params, searchParams }: {
  params: Promise<{ accountId: string; movementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminContext();
  const ids = await params;
  const accountId = positiveMovementId(ids.accountId);
  const movementId = positiveMovementId(ids.movementId);
  if (!accountId || !movementId) notFound();
  const query = await searchParams;
  const back = movementReturnHref(accountId, typeof query.volver === 'string' ? query.volver : undefined);
  let detail;
  try { detail = await readAccountMovementDetail(ctx.supabase, accountId, movementId); }
  catch (error) {
    return <section className="space-y-3 text-xs"><BackLink fallbackHref={back} /><p role="alert" className="text-red-200">{error instanceof Error ? error.message : 'No se pudo verificar el movimiento.'}</p></section>;
  }
  if (!detail) notFound();
  const { movement, movements, accountNames, fingerprint } = detail;
  const blocked = movementVoidBlock(movements);
  const closure = movements.map(row => row.reference?.match(/^closure-(\d+)$/)?.[1]).find(Boolean);
  return <section className="min-w-0 space-y-4 text-xs text-[#BCBCC8]">
    <BackLink fallbackHref={back} />
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#292937] pb-3">
      <div className="min-w-0"><h1 className="text-base font-semibold text-[#D5D5DD]">{typeLabels[movement.type] ?? 'Movimiento'} · {statusLabels[movement.status]}</h1><p className="mt-1 break-words">{formatOrderConcept(movement.counterparty ?? movement.description ?? accountNames[accountId], movement.orderId)} · {movement.date}</p></div>
      <p className="text-base font-medium tabular-nums [overflow-wrap:anywhere]">{movement.direction === 'inflow' ? '+' : '−'} {money(movement.amount, movement.currency)}</p>
    </header>
    <dl className="grid grid-cols-1 gap-2 rounded-xl border border-[#292937] bg-[#111117] p-3 sm:grid-cols-2">
      <div><dt className="text-[#81818E]">Referencia</dt><dd className="break-words">{movement.reference ?? 'Sin referencia'}</dd></div>
      <div><dt className="text-[#81818E]">Pedido</dt><dd>{movement.orderId ? <Link prefetch={false} className="underline" href={`/app/admin/ordenes?openOrder=${movement.orderId}&tab=pagos`}>#{formatOrderDisplayNumber(movement.orderId)} →</Link> : 'Sin pedido vinculado'}</dd></div>
      {movement.description ? <div><dt className="text-[#81818E]">Concepto</dt><dd className="break-words">{formatOrderConcept(movement.description, movement.orderId)}</dd></div> : null}
      {movement.rate !== null ? <div><dt className="text-[#81818E]">Tasa registrada</dt><dd>{number.format(movement.rate)} Bs/USD{movement.usd !== null ? ` · ${money(movement.usd, 'USD')}` : ''}</dd></div> : null}
      {movement.voidReason ? <div><dt className="text-[#81818E]">Motivo de anulación</dt><dd className="break-words">{movement.voidReason}</dd></div> : null}
    </dl>
    {movements.length > 1 ? <section aria-label="Operación vinculada" className="rounded-xl border border-[#292937] bg-[#111117] p-3">
      <h2 className="mb-2 font-medium text-[#D5D5DD]">Operación completa · {movements.length} movimientos</h2>
      <ul className="divide-y divide-[#292937]">{movements.map(row => <li key={row.id} className="grid min-w-0 gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0"><p className="break-words">{accountNames[row.accountId]} · {typeLabels[row.type] ?? row.type} · {statusLabels[row.status]}</p>{row.orderId ? <Link prefetch={false} href={`/app/admin/ordenes?openOrder=${row.orderId}&tab=pagos`} className="text-[11px] underline">Pedido #{formatOrderDisplayNumber(row.orderId)}</Link> : null}</div>
        <span className="tabular-nums [overflow-wrap:anywhere]">{row.direction === 'inflow' ? '+' : '−'} {money(row.amount, row.currency)}</span>
      </li>)}</ul>
    </section> : null}
    {movement.notes ? <details className="rounded-lg border border-[#292937] p-3"><summary className="cursor-pointer">Notas</summary><p className="mt-2 whitespace-pre-wrap break-words">{movement.notes}</p></details> : null}
    <section aria-label="Acciones del movimiento" className="space-y-2">
      <h2 className="font-medium text-[#D5D5DD]">Acciones</h2>
      {blocked ? <p>{blocked}</p> : <VoidMovementForm accountId={accountId} movementId={movementId} fingerprint={fingerprint} movementCount={movements.length} />}
      {closure ? <Link prefetch={false} className="inline-flex min-h-8 items-center underline" href={`/app/admin/finanzas/cuentas/cierre/${closure}`}>Revisar cierre →</Link> : null}
    </section>
  </section>;
}
