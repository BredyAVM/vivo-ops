import Link from 'next/link';
import { loadDeliveryPayment } from '@/lib/admin-finance/delivery-service-data';
import { AdminReadError, adminPanel } from '../../../../_components/AdminReadUi';
import VoidDeliveryPayment from './VoidDeliveryPayment';
export default async function DeliveryPaymentPage({ params }: { params: Promise<{ paymentId: string }> }) {
  let p;
  try {
    p = await loadDeliveryPayment((await params).paymentId);
  } catch (error) { return <AdminReadError title="Pago no disponible" message={error instanceof Error ? error.message : 'No se pudo cargar el registro.'} />; }
    const result = p.result as { movementId: number; currency: string; amount: number; rate: number | null; paymentDate: string; reference: string | null; linkedExisting: boolean };
    const evidence = p.evidence as { id: number; cost: number; service: { client: string; orderNumber: string; date: string } }[];
    return <div className="space-y-4"><Link href={`/app/admin/finanzas/delivery?from=${p.period_from}&to=${p.period_to}`} className="inline-flex min-h-11 items-center text-sm underline">← Relación de delivery</Link>
      <h1 className="text-xl font-semibold">{p.responsible_name} · ${Number(p.total_usd).toFixed(2)}</h1>
      <section className={adminPanel}><p className="text-sm">{p.period_from} al {p.period_to} · {evidence.length} entregas · {p.voided_at ? 'Anulado' : 'Pago vinculado'}</p>
        <p className="mt-2 text-sm">Egreso #{result.movementId} · {result.paymentDate} · {result.currency} {Number(result.amount).toFixed(2)}{result.rate ? ` · tasa ${result.rate}` : ''}</p>
        {result.reference ? <p className="mt-2 text-xs">Referencia: {result.reference}</p> : null}
        <p className="mt-2 text-xs text-[#9B9BA7]">{result.linkedExisting ? 'Vinculado a un egreso anterior; no se duplicó la salida de dinero.' : 'Egreso registrado en la cuenta. No constituye una transferencia bancaria automática.'}</p>
        {p.voided_at ? <p className="mt-3 text-sm text-orange-200">Motivo de anulación: {p.void_reason}</p> : <VoidDeliveryPayment id={p.request_id} linkedExisting={result.linkedExisting} />}
      </section>
      <section className={adminPanel}><h2 className="text-sm font-semibold">Detalle confirmado al registrar</h2>{evidence.map(e => <div key={e.id} className="flex min-h-12 items-center justify-between gap-3 border-b border-[#292937] py-2 text-xs"><span>#{e.service.orderNumber} · {e.service.client} · {e.service.date}</span><span>${Number(e.cost).toFixed(2)}</span></div>)}</section>
    </div>;
}
