import type { CommissionLiveCollection } from '@/lib/commissions/live-collections';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';

const money = (value: number) => `$${value.toFixed(2)}`;

export default function CollectionSummary({ state, initialPendingIds = [], error }: {
  state?: CommissionLiveCollection;
  initialPendingIds?: number[];
  error?: string | null;
}) {
  if (error || !state?.supported) return <p className="rounded-xl border border-amber-400/25 p-3 text-xs text-amber-200">
    {error ? 'No se pudo verificar la cobranza actual. Los importes históricos no habilitan nuevos pagos.' : 'Este cierre histórico requiere conciliación antes de habilitar cobranza adicional.'}
  </p>;
  const ids = new Set(initialPendingIds);
  const orders = state.orders.filter((o) => ids.has(o.orderId) || o.pendingUsd > 0);
  return <section className="space-y-3 rounded-2xl border border-sky-400/25 bg-sky-400/5 p-3">
    <div className="text-sm font-semibold text-sky-100">Cobranza actual · separada del acuerdo</div>
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      {[['Deuda de clientes',state.customerDebtUsd],['Disponible total',state.payableUsd],['Pagado al asesor',state.paidUsd],['Pendiente por pagar',state.pendingUsd]].map(([label,amount]) =>
        <div key={String(label)}><div className="text-[#A6A6B0]">{label}</div><div className="mt-1 font-semibold text-sky-100">{money(Number(amount))}</div></div>)}
    </div>
    <p className="text-[11px] leading-5 text-[#A6A6B0]">Acordado: {money(state.agreedPayableUsd)} · Retenido actualmente: {money(state.retainedUsd)}. El acuerdo y sus porcentajes no se recalculan al cobrar.</p>
    {state.transferredToClosureId ? <p className="text-xs text-sky-100">Saldo trasladado ({money(state.transferredCreditUsd ?? 0)}) a la liquidación #{state.transferredToClosureId}. No se paga de nuevo en este origen.</p> : null}
    {state.overpaidUsd > 0 ? <p className="text-xs text-amber-200">Revisar: hay {money(state.overpaidUsd)} pagados por encima de lo disponible actual. No se altera el historial.</p> : null}
    {orders.length ? <details>
      <summary className="cursor-pointer text-xs font-semibold text-sky-100">Ver seguimiento de órdenes ({orders.length})</summary>
      <div className="mt-2 divide-y divide-sky-400/15">{orders.map((o) => <div key={o.orderId} className="grid grid-cols-[1fr_auto] gap-2 py-2 text-xs">
        <div><span className="font-semibold">{formatOrderDisplayNumber(o.orderId)}</span> · {o.clientName}<div className="mt-1 text-[#A6A6B0]">Pagado validado: {money(o.confirmedPaidUsd)}</div></div>
        <span className={o.pendingUsd > 0 ? 'text-amber-200' : 'text-emerald-300'}>{o.pendingUsd > 0 ? `Pendiente ${money(o.pendingUsd)}` : 'Pagada'}</span>
      </div>)}</div>
    </details> : <p className="text-xs text-emerald-300">No hay órdenes pendientes de pago.</p>}
  </section>;
}
