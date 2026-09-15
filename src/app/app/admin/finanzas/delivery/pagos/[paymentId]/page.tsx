import Link from 'next/link';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { loadDeliveryPayment } from '@/lib/admin-finance/delivery-service-data';
import { AdminReadError, adminPanel } from '../../../../_components/AdminReadUi';
import VoidDeliveryPayment from './VoidDeliveryPayment';
export default async function DeliveryPaymentPage({ params }: { params: Promise<{ paymentId: string }> }) {
  let p;
  try {
    p = await loadDeliveryPayment((await params).paymentId);
  } catch (error) { return <AdminReadError title="Pago no disponible" message={error instanceof Error ? error.message : 'No se pudo cargar el registro.'} />; }
    const result = p.result as { movementId: number | null; currency: string; amount: number; rate: number | null; paymentDate: string; reference: string | null; linkedExisting: boolean; orderTotalUsd?: number; extraTotalUsd?: number; grossUsd?: number; deductionUsd?: number; deductions?: { id: string; concept: string; amount: number; balanceBefore: number; balanceAfter: number; orderId: number | null }[]; extras?: { id: string; date: string; concept: string; amount: number }[] };
    const evidence = p.evidence as { id: number; cost: number; service: { client: string; orderNumber: string; date: string } }[];
    return <div className="space-y-4"><Link href={`/app/admin/finanzas/delivery?from=${p.period_from}&to=${p.period_to}`} className="inline-flex min-h-11 items-center text-sm underline">← Relación de delivery</Link>
      <h1 className="text-lg font-semibold">{p.responsible_name} · pago neto ${Number(p.total_usd).toFixed(2)}</h1>
      <section className={adminPanel}><p className="text-sm">{p.period_from} al {p.period_to} · {evidence.length} entregas · {p.voided_at ? 'Anulado' : 'Pago vinculado'}</p>
        <p className="mt-2 text-sm">{result.movementId ? `Egreso #${result.movementId} · ${result.paymentDate} · ${result.currency} ${Number(result.amount).toFixed(2)}${result.rate ? ` · tasa ${result.rate}` : ''}` : `${result.paymentDate} · Liquidación por compensación, sin egreso.`}</p>
        <p className="mt-2 text-sm">Ganado ${Number(result.grossUsd ?? p.total_usd).toFixed(2)} − descuentos ${Number(result.deductionUsd ?? 0).toFixed(2)} = neto ${Number(p.total_usd).toFixed(2)}</p>
        {result.reference ? <p className="mt-2 text-xs">Referencia: {result.reference}</p> : null}
        <p className="mt-2 text-xs text-[#9B9BA7]">{result.movementId === null ? 'Lo ganado se aplicó a las deudas indicadas. No hubo movimiento de caja o banco.' : result.linkedExisting ? 'Vinculado a un egreso anterior; no se duplicó la salida de dinero.' : 'Egreso neto registrado en la cuenta. No constituye una transferencia bancaria automática.'}</p>
        {p.voided_at ? <p className="mt-3 text-sm text-orange-200">Motivo de anulación: {p.void_reason}</p> : <VoidDeliveryPayment id={p.request_id} linkedExisting={result.linkedExisting} noMovement={result.movementId === null} />}
      </section>
      <section className={adminPanel}><h2 className="text-sm font-semibold">Detalle confirmado al registrar</h2>{evidence.map(e => <div key={e.id} className="flex min-h-12 items-center justify-between gap-3 border-b border-[#292937] py-2 text-xs"><span>#{formatOrderDisplayNumber(e.id)} · {e.service.client} · {e.service.date}</span><span>${Number(e.cost).toFixed(2)}</span></div>)}</section>
      {result.extras?.length ? <section className={adminPanel}><h2 className="text-sm font-semibold">Servicios adicionales · ${Number(result.extraTotalUsd).toFixed(2)}</h2>{result.extras.map(e => <div key={e.id} className="flex items-center justify-between gap-3 border-b border-[#292937] py-2 text-xs"><span>{e.date} · {e.concept}</span><span>${Number(e.amount).toFixed(2)}</span></div>)}<p className="mt-2 text-xs">Entregas ${Number(result.orderTotalUsd).toFixed(2)} + adicionales ${Number(result.extraTotalUsd).toFixed(2)} = ganado ${Number(result.grossUsd ?? p.total_usd).toFixed(2)}</p></section> : null}
      {result.deductions?.length ? <section className={adminPanel}><h2 className="text-sm font-semibold">Descuentos · ${Number(result.deductionUsd).toFixed(2)}</h2>{result.deductions.map(d => <div key={d.id} className="flex flex-wrap justify-between gap-2 border-b border-[#292937] py-2 text-xs"><span>{d.concept}{d.orderId ? ` · pedido #${formatOrderDisplayNumber(d.orderId)}` : ''}</span><span>Deuda ${Number(d.balanceBefore).toFixed(2)} − abono ${Number(d.amount).toFixed(2)} = restante ${Number(d.balanceAfter).toFixed(2)}</span></div>)}<p className="mt-2 text-xs text-[#9B9BA7]">Saldos al momento de liquidar. {p.voided_at ? 'Estos descuentos fueron revertidos al anular.' : 'Si se anula la liquidación, se reabren los importes descontados.'}</p></section> : null}
    </div>;
}
