'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import { useDialogFocus } from '@/components/ui/useDialogFocus';
import { queryControl, queryAction } from '@/components/ui/QueryControls';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { paymentReviewSnapshot, type PaymentReviewReport, type PaymentVoidPreview } from '@/lib/admin-finance/payment-review-model';
import { voidAdminCustomerPaymentAction } from './actions';

const amount = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const types: Record<string, string> = { order_payment: 'Pago', fee_charge: 'Comisión', change_given: 'Cambio',
  expense_payment: 'Egreso', transfer: 'Traspaso', transfer_in: 'Traspaso recibido', transfer_out: 'Traspaso enviado',
  deposit: 'Ingreso', withdrawal: 'Retiro', other_income: 'Otro ingreso', adjustment: 'Ajuste' };
const money = (value: number, currency: string) => `${currency === 'VES' ? 'Bs' : 'USD'} ${amount.format(value)}`;

export default function PaymentReportVoid({ report, preview, onVoided }: {
  report: PaymentReviewReport; preview: PaymentVoidPreview; onVoided: (reason: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [reason, setReason] = useState(''), [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const ref = useDialogFocus<HTMLDivElement>(() => { if (!busy.current) setOpen(false); }, open);
  const titleId = `payment-void-${report.id}`;
  function submit() {
    if (busy.current || preview.blocked) return;
    if (reason.trim().length < 6 || reason.trim().length > 500) { setError('Describe el motivo (6 a 500 caracteres).'); return; }
    busy.current = true; setError('');
    startTransition(async () => {
      try {
        const result = await voidAdminCustomerPaymentAction({ reportId: report.id, orderId: report.order_id,
          reportSnapshot: paymentReviewSnapshot(report), fingerprint: preview.fingerprint, reason });
        if (!result.ok) { setError(result.message); return; }
        setOpen(false); onVoided(reason.trim()); router.refresh();
      } catch { setError('No se pudo comprobar el resultado. Actualiza la consulta antes de reintentar.'); }
      finally { busy.current = false; }
    });
  }
  return <div className="space-y-2">
    <p className="break-words text-xs text-[#BDBDC7]">Confirmado: <span className="font-semibold tabular-nums text-emerald-200">{money(preview.amount, preview.currency)}</span> · {preview.accountName} · Ref. {preview.reference || '—'}</p>
    {preview.blocked ? <p className="text-xs text-orange-200">{preview.blocked}</p> :
      <button type="button" className={`${queryAction} border-red-400/40 text-red-200`} onClick={() => { setError(''); setOpen(true); }}>Anular pago</button>}
    {open ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-[#343442] bg-[#111117] p-4 text-xs shadow-xl">
        <form onSubmit={event => { event.preventDefault(); submit(); }} className="space-y-3">
          <h2 id={titleId} className="text-sm font-semibold text-[#DEDEE6]">Anular pago · orden #{formatOrderDisplayNumber(report.order_id)}</h2>
          <p className="text-[#BDBDC7]">¿Quieres anular este registro? Esto no devuelve dinero del banco ni cancela la orden.</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-[#BDBDC7]">
            <dt>Monto confirmado</dt><dd className="font-semibold tabular-nums text-[#FFFF00]">{money(preview.amount, preview.currency)}</dd>
            <dt>Banco / cuenta</dt><dd>{preview.accountName}</dd>
            <dt>Referencia</dt><dd>{preview.reference || 'Sin referencia'}</dd>
            <dt>Fecha</dt><dd>{preview.date}</dd>
          </dl>
          <details open className="rounded-lg border border-[#292937] p-2 text-[#BDBDC7]">
            <summary className="cursor-pointer">{preview.movements.length} movimiento(s) incluidos en la anulación</summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {preview.movements.map(row => <li key={row.id} className="flex flex-wrap justify-between gap-x-2 border-b border-[#292937] pb-1 last:border-0">
                <span className="min-w-0 break-words">{types[row.type] ?? row.type} · {row.accountName}{row.orderId ? ` · orden #${formatOrderDisplayNumber(row.orderId)}` : ''}</span>
                <span className="tabular-nums">{row.direction === 'inflow' ? '+' : '−'} {money(row.amount, row.currency)}</span>
              </li>)}
            </ul>
          </details>
          <p className="text-[11px] text-[#BDBDC7]">El saldo se recalcula y los registros vinculados se revisan juntos. Si hay una conciliación, fondo utilizado u otra dependencia que impida anular, el sistema lo indicará sin guardar una anulación parcial.</p>
          <label className="grid gap-1 text-[11px] text-[#B7B7C2]">Motivo de anulación
            <textarea required minLength={6} maxLength={500} rows={2} value={reason} disabled={pending}
              onChange={event => setReason(event.target.value)} className={`${queryControl} w-full resize-y p-2`} />
          </label>
          {error ? <p role="alert" className="break-words text-red-200">{error}</p> : null}
          <div className="flex flex-wrap justify-between gap-2">
            <Link prefetch={false} href={`/app/admin/finanzas/cuentas/${preview.accountId}/movimientos/${preview.movementId}`} className="content-center text-[11px] text-[#BDBDC7] underline">Ver operación completa</Link>
            <div className="flex gap-2">
              <button type="button" data-dialog-close disabled={pending} onClick={() => setOpen(false)} className={queryAction}>Cancelar</button>
              <button type="submit" disabled={pending || reason.trim().length < 6} className={`${queryAction} border-red-400/50 text-red-200`}>{pending ? 'Anulando…' : 'Sí, anular pago'}</button>
            </div>
          </div>
        </form>
      </div>
    </div> : null}
  </div>;
}
