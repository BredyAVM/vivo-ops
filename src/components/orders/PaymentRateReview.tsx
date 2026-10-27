'use client';

import { useRef, useState, useTransition } from 'react';
import { approvePaymentRateReviewAction, readPaymentRateReviewAction, type PaymentRateReview as Review } from '@/lib/payments/rate-review-actions';
import { PAYMENT_RATE_REVIEW_REQUIRED, type PaymentActionResult } from '@/lib/payments/action-result';

const amount = (value: number | null | undefined) => new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Number(value || 0));
const rate = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('es-VE', { maximumFractionDigits: 6, minimumFractionDigits: 2 }).format(value);

/** Consulted only when expanded; never adds one query per row to a list. */
export default function PaymentRateReview({ reportId, initialResult, onResult }: {
  reportId: number;
  initialResult?: PaymentActionResult<Review>;
  onResult?: (result: PaymentActionResult<Review>) => void;
}) {
  const [open, setOpen] = useState(Boolean(initialResult));
  const [review, setReview] = useState<Review | null>(initialResult?.ok ? initialResult.value : null);
  const [error, setError] = useState(initialResult && !initialResult.ok ? initialResult.message : '');
  const [decision, setDecision] = useState<'quoted' | 'reported'>('quoted');
  const [reason, setReason] = useState('');
  const [quoteId, setQuoteId] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const panelId = `payment-rate-review-${reportId}`;
  const selectedQuote = !review?.decision ? review?.quoteCandidates?.find(quote => String(quote.id) === quoteId) : null;

  function receive(result: PaymentActionResult<Review>) {
    onResult?.(result);
    if (!result.ok) { setError(result.message); return; }
    setReview(result.value);
  }

  function loadReview() {
    if (busy.current) return;
    setOpen(true); setError(''); setNotice(''); busy.current = true;
    startTransition(async () => {
      try { receive(await readPaymentRateReviewAction(reportId)); }
      catch { receive({ ok: false, code: 'unavailable', message: 'No se pudo consultar la revisión de tasa. Comprueba la conexión y vuelve a consultar antes de confirmar.' }); }
      finally { busy.current = false; }
    });
  }

  function consult() {
    if (busy.current) return;
    if (open) { setOpen(false); return; }
    loadReview();
  }

  function approve() {
    if (busy.current || !review?.canApprove || !reason.trim()) return;
    busy.current = true; setError('');
    startTransition(async () => {
      try {
        const result = await approvePaymentRateReviewAction({ reportId, decision, reason, quoteId: decision === 'quoted' && quoteId ? Number(quoteId) : null });
        receive(result);
        if (result.ok) setNotice('Revisión aprobada. Ahora confirma este mismo pago abajo, sin volver a cargarlo ni cambiar su referencia.');
      } catch { receive({ ok: false, code: 'unavailable', message: 'No se pudo comprobar la aprobación. Vuelve a consultar la revisión antes de reintentar.' }); }
      finally { busy.current = false; }
    });
  }

  return <div className="mt-2 text-xs">
    <button type="button" onClick={consult} disabled={pending} aria-expanded={open} aria-controls={open ? panelId : undefined}
      className="min-h-11 text-[#FFFF00] underline underline-offset-2 disabled:opacity-50 sm:min-h-8">
      {open ? 'Ocultar revisión de tasa' : 'Revisar tasa acordada'}
    </button>
    {open ? <section id={panelId} aria-label="Revisión de tasa acordada" aria-busy={pending} className="mt-1 space-y-2 rounded-lg border border-[#34343E] bg-[#111117] p-3 text-[#D5D5DF]">
      {pending ? <p role="status">Consultando…</p> : null}
      {error ? <div role="alert" className="space-y-1 text-red-200"><p>{error}</p><button type="button" disabled={pending} onClick={loadReview} className="min-h-11 underline sm:min-h-8">Volver a consultar revisión</button></div> : null}
      {notice ? <p role="status" className="text-emerald-200">{notice}</p> : null}
      {review?.available === false ? <p>No hay una discrepancia de tasa certificada para este reporte. No se modificó el pago.</p> : null}
      {review?.available ? <>
        {!review.decision && !review.applied ? <p role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-amber-100">{PAYMENT_RATE_REVIEW_REQUIRED}</p> : null}
        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 tabular-nums">
          <dt>Recibido · Bs</dt><dd>{amount(review.amountBs)}</dd>
          <dt>Tasa registrada · Bs/USD</dt><dd>{rate(review.recordedRate)}</dd>
          <dt>Tasa del presupuesto / acuerdo · Bs/USD</dt><dd>{rate(selectedQuote?.rate ?? review.quoteRate)}</dd>
          <dt>Presupuesto pendiente · USD</dt><dd>{amount(selectedQuote?.pendingUsd ?? review.quoteUsd)}</dd>
          <dt>Equivalente del presupuesto · Bs</dt><dd>{amount(selectedQuote?.pendingBs ?? review.quoteBs)}</dd>
        </dl>
        <p className="text-[11px] text-[#B7B7C2]">Comprueba el presupuesto, la fecha real del pago y el acuerdo con el cliente, también si tiene retenciones o paga por fecha. La coincidencia de importes no prueba el acuerdo. Aprobarlo no mueve dinero, no cambia precios ni comisiones y no fija la tasa de futuros abonos.</p>
        {review.applied ? <p className="text-emerald-200">Cobertura ya aplicada al confirmar el pago.</p>
          : review.decision ? <p className="text-emerald-200">Decisión registrada: {review.decision === 'quoted' ? 'respetar el presupuesto pagado a la tasa acordada' : 'aplicar la tasa registrada como abono'}. Puedes confirmar este mismo reporte con sus datos originales. La tasa registrada para caja no se sustituye por la tasa acordada para cubrir la deuda.</p>
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
                  Q{quote.id} · {rate(quote.rate)} Bs/USD · {new Date(quote.createdAt).toLocaleString('es-VE', { timeZone: 'America/Caracas' })}
                </option>)}
              </select>
            </label> : null}
            <label className="grid gap-1">Acuerdo comprobado / observación
              <textarea required minLength={4} maxLength={1200} rows={2} value={reason} disabled={pending} onChange={event => setReason(event.target.value)}
                className="rounded-lg border border-[#34343E] bg-[#0B0B0D] p-2 text-xs" />
            </label>
            <button type="submit" disabled={pending || reason.trim().length < 4}
              className="min-h-11 rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-black disabled:opacity-50 sm:min-h-9">Aprobar revisión de tasa</button>
          </form> : <p className="text-amber-200">Administración debe comprobar y registrar el acuerdo antes de confirmar este pago.</p>}
      </> : null}
    </section> : null}
  </div>;
}
