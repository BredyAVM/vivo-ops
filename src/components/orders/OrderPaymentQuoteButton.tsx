'use client';

import { useRef, useState, useTransition } from 'react';
import { loadOrderPaymentQuoteAction } from '@/lib/orders/payment-quote-action';
import { type OrderPaymentQuote } from '@/lib/orders/payment-quote';
import { formatWhatsAppBs, formatWhatsAppUsd, formatWhatsAppExchangeRate, formatWhatsAppCalculationTime } from '@/lib/orders/whatsapp-summary';

export default function OrderPaymentQuoteButton({ orderId }: { orderId: number }) {
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<OrderPaymentQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const regionId = `order-payment-quote-${orderId}`;

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function consult() {
    if (busy.current) return;
    busy.current = true;
    setOpen(true); setQuote(null); setError(null); setCopied(false);
    startTransition(async () => {
      try { setQuote(await loadOrderPaymentQuoteAction({ orderId })); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo consultar el saldo.'); }
      finally { busy.current = false; }
    });
  }

  async function copy() {
    if (!quote || pending) return;
    setError(null);
    try { await navigator.clipboard.writeText(quote.text); setCopied(true); }
    catch { setError('No se pudo copiar. Puedes seleccionar el texto de abajo.'); }
  }

  return <div className="relative max-w-full" onKeyDownCapture={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={triggerRef} type="button" onClick={consult} disabled={pending} aria-expanded={open} aria-controls={open ? regionId : undefined}
      className="inline-flex min-h-11 items-center rounded-lg border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-2 text-xs font-semibold text-[#FEEF00] disabled:opacity-50 sm:min-h-9">
      {pending ? 'Consultando…' : 'Cotizar pago de hoy'}
    </button>
    {open ? <section id={regionId} aria-label="Cotización de pago" aria-busy={pending}
      className="fixed inset-x-3 top-24 z-50 max-h-[70dvh] overflow-y-auto rounded-xl border border-[#34343E] bg-[#121218] p-3 text-xs text-[#F5F5F7] shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold">Pago de hoy{quote ? ` · #${quote.orderLabel}` : ''}</span>
        <button type="button" aria-label="Cerrar cotización" onClick={close} className="min-h-11 min-w-11 rounded-lg border border-[#34343E] sm:min-h-9 sm:min-w-9">×</button>
      </div>
      <div role="status" aria-live="polite">
        {pending ? <p>Consultando saldo y tasa…</p> : null}
        {error ? <p className="mb-2 text-red-300">{error}</p> : null}
        {quote ? <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
            <dt>Pendiente USD</dt><dd className="font-semibold">{formatWhatsAppUsd(quote.pendingUsd)}</dd>
            <dt>A pagar Bs</dt><dd className="font-semibold text-[#FEEF00]">{formatWhatsAppBs(quote.pendingBs)}</dd>
            <dt>{quote.collectionMode === 'snapshot_quote' ? 'Tasa del presupuesto' : 'Tasa vigente'}</dt><dd>{formatWhatsAppExchangeRate(quote.exchangeRate)}</dd>
          </dl>
          <p className="mt-2 text-[#B7B7C2]">{formatWhatsAppCalculationTime(quote.generatedAt)}</p>
          {quote.collectionMode === 'snapshot_quote' ? <p className="mt-2 text-[#B7B7C2]">Esta orden conserva el monto acordado en Bs.</p> : null}
          {quote.pendingReportsCount > 0 ? <p className="mt-2 text-amber-300">Hay pagos por revisar; aún no están descontados.</p> : null}
          {quote.pendingUsd === 0 && quote.pendingBs === 0 ? <p className="mt-2 text-emerald-300">Sin deuda pendiente.</p> : null}
          <button type="button" onClick={() => void copy()} className="mt-3 min-h-11 w-full rounded-lg bg-[#FEEF00] px-3 font-semibold text-black sm:min-h-9">{copied ? 'Copiado' : 'Copiar para WhatsApp'}</button>
          <details className="mt-2 text-[#B7B7C2]"><summary className="min-h-11 cursor-pointer content-center sm:min-h-9">Ver texto</summary>
            <textarea aria-label="Texto de cotización para WhatsApp" readOnly value={quote.text} onFocus={event => event.currentTarget.select()}
              className="mt-1 h-40 w-full rounded-lg border border-[#34343E] bg-[#0B0B0D] p-2 text-xs text-[#F5F5F7]" />
          </details>
        </> : null}
      </div>
    </section> : null}
  </div>;
}
