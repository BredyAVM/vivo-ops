'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import { queryControl, queryPrimary, queryAction as querySecondary } from '@/components/ui/QueryControls';
import { paymentReviewDate, paymentReviewSnapshot, type PaymentReviewContext, type PaymentReviewDecision } from '@/lib/admin-finance/payment-review-model';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { useDialogFocus } from '@/components/ui/useDialogFocus';
import { loadAdminPaymentReviewAction, reviewAdminPaymentAction } from './actions';

const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const labels: Record<string, string> = { pending: 'Por revisar', confirmed: 'Confirmado', rejected: 'Rechazado' };

export default function PaymentReportReview({ reportId, orderId, children }: {
  reportId: number; orderId: number; children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<PaymentReviewContext | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [date, setDate] = useState('');
  const [rate, setRate] = useState('');
  const [handling, setHandling] = useState<'' | 'store_fund' | 'close_difference'>('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(() => {
    if (!busy.current) setConfirmationOpen(false);
  }, confirmationOpen);
  const panelId = `payment-review-${reportId}`;
  const report = context?.report;
  const numericRate = Number(rate);
  const amountUsd = report ? report.reported_currency_code === 'VES'
    ? numericRate > 0 ? Number(report.reported_amount) / numericRate : null
    : Number(report.reported_amount) : null;
  const excess = amountUsd !== null && context?.pendingUsd !== null && context?.pendingUsd !== undefined
    ? Math.max(0, Number((amountUsd - Math.max(0, context.pendingUsd)).toFixed(2))) : null;

  function expand() {
    if (busy.current) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    setError('');
    setContext(null);
    setRejecting(false);
    busy.current = true;
    startTransition(async () => {
      try {
        const result = await loadAdminPaymentReviewAction(reportId, orderId);
        if (!result.ok) { setError(result.message); return; }
        setContext(result.context);
        setDate(paymentReviewDate(result.context.report));
        setRate(result.context.report.reported_exchange_rate_ves_per_usd == null ? ''
          : String(result.context.report.reported_exchange_rate_ves_per_usd));
        setHandling('');
      } catch { setError('No se pudo consultar el reporte. Cierra y vuelve a abrir el detalle.'); }
      finally { busy.current = false; }
    });
  }

  function submit(decision: PaymentReviewDecision['decision']) {
    if (busy.current || !report || report.status !== 'pending') return;
    if (decision === 'reject' && !reason.trim()) { setError('Debes indicar el motivo del rechazo.'); return; }
    if (decision === 'confirm' && (excess === null || excess > 0) && !handling) {
      setError('Indica qué hacer si este pago tiene un excedente.'); return;
    }
    setError('');
    setNotice('');
    busy.current = true;
    const input: PaymentReviewDecision = decision === 'reject'
      ? { reportId, orderId, reportSnapshot: paymentReviewSnapshot(report), decision, reason }
      : { reportId, orderId, reportSnapshot: paymentReviewSnapshot(report), decision, date, rate: report.reported_currency_code === 'VES' ? numericRate : null,
          handling: handling || null };
    startTransition(async () => {
      try {
        const result = await reviewAdminPaymentAction(input);
        if (!result.ok) { setError(result.message); return; }
        setContext({ ...context!, report: { ...report, status: result.status,
          review_notes: decision === 'reject' ? reason.trim() : 'Confirmado desde Pagos de clientes.' } });
        setRejecting(false);
        setConfirmationOpen(false);
        setNotice(decision === 'confirm' ? 'Pago confirmado.' : 'Reporte rechazado.');
        router.refresh();
      } catch { setError('No se pudo verificar el resultado. Actualiza la consulta antes de volver a intentar.'); }
      finally { busy.current = false; }
    });
  }

  return <div className="mt-1 text-xs">
    <button type="button" onClick={expand} disabled={pending} aria-expanded={open} aria-controls={panelId}
      className="inline-flex min-h-11 items-center gap-1 text-[#FFFF00] disabled:opacity-50 sm:min-h-7">
      {open ? 'Ocultar reporte' : 'Ver reporte'} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {notice ? <p role="status" className="py-1 text-emerald-200">{notice}</p> : null}
    {open ? <section id={panelId} aria-label={`Revisión del pago de la orden ${formatOrderDisplayNumber(orderId)}`}
      aria-busy={pending} className="mt-1 space-y-2 border-t border-[#292937] pt-2">
      {children}
      {error ? <p role="alert" className="break-words text-red-200">{error}</p> : null}
      {!report && pending ? <p role="status" className="text-[#BDBDC7]">Consultando reporte…</p> : null}
      {report ? <>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[#BDBDC7]">
          <span>{labels[report.status] ?? report.status}</span>
          <span className="tabular-nums">Monto reportado: {report.reported_currency_code === 'VES' ? 'Bs' : 'USD'} {money.format(Number(report.reported_amount))}</span>
          {context?.pendingUsd != null ? <span className="tabular-nums">Por cobrar en la orden: USD {money.format(context.pendingUsd)}</span> : null}
        </div>
        {report.status !== 'pending' ? <p className="break-words text-[#BDBDC7]">{report.review_notes || 'Este reporte ya fue revisado.'}</p> : <>
          {rejecting ? <form onSubmit={event => { event.preventDefault(); submit('reject'); }} className="space-y-2">
            <label className="grid gap-1 text-[11px] text-[#B7B7C2]">Motivo del rechazo
              <textarea required maxLength={2000} autoFocus rows={2} value={reason} onChange={event => setReason(event.target.value)}
                disabled={pending} className={`${queryControl} w-full resize-y`} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={pending} className={`${querySecondary} border-red-400/50 text-red-200 disabled:opacity-50`}>Rechazar reporte</button>
              <button type="button" disabled={pending} onClick={() => { setRejecting(false); setError(''); }} className={querySecondary}>Cancelar</button>
            </div>
          </form> : <form onSubmit={event => {
            event.preventDefault();
            if ((excess === null || excess > 0) && !handling) {
              setError('Indica qué hacer si este pago tiene un excedente.'); return;
            }
            setError(''); setConfirmationOpen(true);
          }} className="space-y-2">
            <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,10rem)_1fr]">
              <label className="grid gap-1 text-[11px] text-[#B7B7C2]">Fecha de operación
                <input required type="date" value={date} disabled={pending} onChange={event => setDate(event.target.value)} className={queryControl} />
              </label>
              {report.reported_currency_code === 'VES' ? <label className="grid gap-1 text-[11px] text-[#B7B7C2]">Tasa del pago · Bs por USD
                <input required type="number" inputMode="decimal" min="0.000001" step="0.000001" value={rate} disabled={pending}
                  onChange={event => setRate(event.target.value)} className={queryControl} />
              </label> : null}
              <label className="grid gap-1 text-[11px] text-[#B7B7C2]">Si hay excedente
                <select value={handling} disabled={pending} onChange={event => setHandling(event.target.value as typeof handling)} className={queryControl}>
                  <option value="">Seleccionar si corresponde</option>
                  <option value="store_fund">Dejar a favor del cliente</option>
                  <option value="close_difference">Cerrar diferencia por redondeo permitido</option>
                </select>
              </label>
            </div>
            {excess !== null && excess > 0 ? <p className="text-orange-200">Excedente estimado: USD {money.format(excess)}. El saldo se verifica nuevamente al confirmar.</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={pending} className={`${queryPrimary} disabled:opacity-50`}>{pending ? 'Guardando…' : 'Confirmar pago'}</button>
              <button type="button" disabled={pending} onClick={() => { setRejecting(true); setError(''); }} className={`${querySecondary} text-red-200`}>Rechazar</button>
              <Link prefetch={false} href={`/app/admin/ordenes?openOrder=${orderId}&tab=pagos`} className="text-[11px] text-[#BDBDC7] underline">Abrir orden · ajustes o cambio entregado</Link>
            </div>
          </form>}
        </>}
      </> : null}
    </section> : null}
    {confirmationOpen && report && context ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${panelId}-title`} tabIndex={-1}
        className="w-full max-w-md space-y-3 rounded-xl border border-[#343442] bg-[#111117] p-4 text-xs shadow-xl">
        <h2 id={`${panelId}-title`} className="text-sm font-semibold text-[#DEDEE6]">Comprobar pago · orden #{formatOrderDisplayNumber(orderId)}</h2>
        <p className="text-[#BDBDC7]">¿Estás seguro de confirmar este pago?</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-[#BDBDC7]">
          <dt>Monto</dt><dd className="font-semibold tabular-nums text-[#FFFF00]">{report.reported_currency_code === 'VES' ? 'Bs' : 'USD'} {money.format(Number(report.reported_amount))}</dd>
          <dt>Banco / cuenta</dt><dd>{context.accountName}</dd>
          <dt>Referencia</dt><dd>{report.reference_code || 'Sin referencia reportada'}</dd>
          <dt>Fecha</dt><dd>{date}</dd>
          {report.reported_currency_code === 'VES' ? <><dt>Tasa del pago</dt><dd>{rate} Bs por USD</dd></> : null}
          {handling ? <><dt>Si hay excedente</dt><dd>{handling === 'store_fund' ? 'Dejar a favor del cliente' : 'Cerrar diferencia por redondeo permitido'}</dd></> : null}
        </dl>
        {error ? <p role="alert" className="break-words text-red-200">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" data-dialog-close disabled={pending} onClick={() => setConfirmationOpen(false)} className={querySecondary}>Cancelar</button>
          <button type="button" disabled={pending} onClick={() => submit('confirm')} className={queryPrimary}>{pending ? 'Confirmando…' : 'Sí, confirmar pago'}</button>
        </div>
      </div>
    </div> : null}
  </div>;
}
