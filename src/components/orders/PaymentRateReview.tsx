'use client';

import { useRef, useState, useTransition } from 'react';
import { approvePaymentRateReviewAction, readPaymentRateReviewAction, type PaymentRateReview as Review } from '@/lib/payments/rate-review-actions';

const amount = (value: number | null | undefined) => new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Number(value || 0));

/** Consulted only when expanded; never adds one query per row to a list. */
export default function PaymentRateReview({ reportId }: { reportId: number }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<'quoted' | 'reported'>('quoted');
  const [reason, setReason] = useState('');
  const [quoteId, setQuoteId] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const panelId = `payment-rate-review-${reportId}`;
  const selectedQuote = review?.quoteCandidates?.find(quote => String(quote.id) === quoteId);

  function consult() {
    if (busy.current) return;
    if (open) { setOpen(false); return; }
    setOpen(true); setError(''); busy.current = true;
    startTransition(async () => {
      try { setReview(await readPaymentRateReviewAction(reportId)); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo consultar la tasa.'); }
      finally { busy.current = false; }
    });
  }

  function approve() {
    if (busy.current || !review?.canApprove || !reason.trim()) return;
    busy.current = true; setError('');
    startTransition(async () => {
      try {
        setReview(await approvePaymentRateReviewAction({ reportId, decision, reason, quoteId: decision === 'quoted' && quoteId ? Number(quoteId) : null }));
        setNotice('Acuerdo registrado. Ahora confirma el pago con su monto, cuenta y referencia originales.');
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo registrar la revisión.'); }
      finally { busy.current = false; }
    });
  }

  return <div className="mt-2 text-xs">
    <button type="button" onClick={consult} disabled={pending} aria-expanded={open} aria-controls={open ? panelId : undefined}
      className="min-h-11 text-[#FFFF00] underline underline-offset-2 disabled:opacity-50 sm:min-h-8">
      {open ? 'Ocultar revisión de tasa' : 'Revisar tasa del presupuesto'}
    </button>
    {open ? <section id={panelId} aria-label="Revisión de tasa acordada" aria-busy={pending} className="mt-1 space-y-2 rounded-lg border border-[#34343E] bg-[#111117] p-3 text-[#D5D5DF]">
      {pending ? <p role="status">Consultando…</p> : null}
      {error ? <p role="alert" className="text-red-200">{error}</p> : null}
      {notice ? <p role="status" className="text-emerald-200">{notice}</p> : null}
      {review?.available === false ? <p>No hay una discrepancia de tasa certificada para este reporte. No se modificó el pago.</p> : null}
      {review?.available ? <>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
          <dt>Recibido · Bs</dt><dd>{amount(review.amountBs)}</dd>
          <dt>Tasa registrada · Bs/USD</dt><dd>{amount(review.recordedRate)}</dd>
          <dt>Tasa del presupuesto · Bs/USD</dt><dd>{amount(selectedQuote?.rate ?? review.quoteRate)}</dd>
          <dt>Presupuesto pendiente · USD</dt><dd>{amount(selectedQuote?.pendingUsd ?? review.quoteUsd)}</dd>
          <dt>Equivalente del presupuesto · Bs</dt><dd>{amount(selectedQuote?.pendingBs ?? review.quoteBs)}</dd>
        </dl>
        <p className="text-[11px] text-[#B7B7C2]">La coincidencia de importes no prueba el acuerdo. Comprueba el presupuesto y cuándo pagó el cliente. Esta revisión no mueve dinero ni fija la tasa de futuros abonos.</p>
        {review.applied ? <p className="text-emerald-200">Cobertura ya aplicada al confirmar el pago.</p>
          : review.decision ? <p className="text-emerald-200">Decisión registrada: {review.decision === 'quoted' ? 'respetar el presupuesto pagado' : 'aplicar la tasa registrada'}. Confirma el pago por la vía habitual.</p>
          : review.canApprove ? <form onSubmit={event => { event.preventDefault(); approve(); }} className="space-y-2">
            <label className="grid gap-1">Tratamiento de este pago
              <select value={decision} onChange={event => setDecision(event.target.value as typeof decision)} disabled={pending}
                className="min-h-11 rounded-lg border border-[#34343E] bg-[#0B0B0D] px-2 text-xs sm:min-h-9">
                <option value="quoted">Pagó el presupuesto a la tasa acordada</option>
                <option value="reported">Es un abono a la tasa registrada</option>
              </select>
            </label>
            {decision === 'quoted' && (review.quoteCandidates?.length ?? 0) > 0 ? <label className="grid gap-1">Cotización que pagó el cliente
              <select value={quoteId} onChange={event => setQuoteId(event.target.value)} disabled={pending}
                className="min-h-11 max-w-full rounded-lg border border-[#34343E] bg-[#0B0B0D] px-2 text-xs sm:min-h-9">
                <option value="">Presupuesto / coincidencia mostrada</option>
                {review.quoteCandidates?.map(quote => <option key={quote.id} value={quote.id}>
                  Q{quote.id} · {amount(quote.rate)} Bs/USD · {new Date(quote.createdAt).toLocaleString('es-VE', { timeZone: 'America/Caracas' })}
                </option>)}
              </select>
            </label> : null}
            <label className="grid gap-1">Acuerdo comprobado / observación
              <textarea required minLength={4} maxLength={1200} rows={2} value={reason} disabled={pending} onChange={event => setReason(event.target.value)}
                className="rounded-lg border border-[#34343E] bg-[#0B0B0D] p-2 text-xs" />
            </label>
            <button type="submit" disabled={pending || reason.trim().length < 4}
              className="min-h-11 rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-black disabled:opacity-50 sm:min-h-9">Registrar acuerdo de tasa</button>
          </form> : <p className="text-amber-200">Administración debe comprobar y registrar el acuerdo antes de confirmar este pago.</p>}
      </> : null}
    </section> : null}
  </div>;
}
