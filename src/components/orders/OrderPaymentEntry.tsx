'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { loadOrderPaymentDayQuoteAction } from '@/lib/payments/day-quote-actions';
import { paymentEntryPreview, type PaymentEntryQuote, type PaymentEntryValue } from '@/lib/payments/payment-entry';

const number = (n: number, digits = 2) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n);
const field = 'mt-1 min-h-11 w-full rounded-lg border border-[#34343E] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] disabled:opacity-50';

/** The only date / rate / amount entry UI used by every order payment surface. */
export default function OrderPaymentEntry({ orderId, currency, value, onChange, onReadyChange, onQuoteChange, disabled = false }: {
  orderId: number; currency: 'USD' | 'VES'; value: PaymentEntryValue;
  onChange: (value: PaymentEntryValue) => void; onReadyChange: (ready: boolean) => void;
  onQuoteChange?: (quote: PaymentEntryQuote) => void; disabled?: boolean;
}) {
  const id = useId();
  const request = useRef(0);
  const lastQuote = useRef<PaymentEntryQuote | null>(null);
  const callbacks = useRef({ value, onChange, onReadyChange, onQuoteChange });
  useEffect(() => { callbacks.current = { value, onChange, onReadyChange, onQuoteChange }; });
  const [quote, setQuote] = useState<PaymentEntryQuote | null>(null);
  const [selectedRate, setSelectedRate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const context = `${orderId}|${currency}|${value.operationDate}`;
  const [loadedContext, setLoadedContext] = useState('');

  const load = useCallback(async (rate?: number) => {
    const token = ++request.current;
    setLoading(true); setError(''); callbacks.current.onReadyChange(false);
    try {
      const result = await loadOrderPaymentDayQuoteAction({ orderId, operationDate: value.operationDate, exchangeRate: rate });
      if (token !== request.current) return;
      const q = result as PaymentEntryQuote;
      const current = callbacks.current.value;
      const priorSelection = current.exchangeRate && q.dayRates.includes(Number(current.exchangeRate)) ? current.exchangeRate : '';
      const chosen = currency === 'USD' ? '' : rate != null ? String(rate) : priorSelection || (q.dayRates.length === 1 ? String(q.dayRates[0]) : '');
      const suggested = currency === 'VES' ? q.pendingBs : q.pendingUsd;
      const previousSuggested = lastQuote.current ? (currency === 'VES' ? lastQuote.current.pendingBs : lastQuote.current.pendingUsd) : null;
      const keepAmount = current.amount !== '' && (rate == null || Number(current.amount.replace(',', '.')) !== previousSuggested);
      const amount = currency === 'VES' && !chosen ? '' : keepAmount ? current.amount : suggested > 0 ? String(suggested) : '';
      setQuote(q); setSelectedRate(chosen); setLoadedContext(`${orderId}|${currency}|${value.operationDate}`);
      lastQuote.current = q;
      callbacks.current.onChange({ operationDate: q.operationDate, exchangeRate: chosen, amount });
      callbacks.current.onQuoteChange?.(q);
    } catch {
      if (token === request.current) setError('No se pudo consultar el saldo y las tasas de esa fecha. Reintenta antes de registrar.');
    } finally { if (token === request.current) setLoading(false); }
  }, [orderId, currency, value.operationDate]);

  const cancel = useCallback(() => { request.current++; }, []);
  useEffect(() => { void load(); return cancel; }, [load, cancel]);
  const rateReady = currency === 'USD' || (quote?.dayRates.includes(Number(selectedRate)) && value.exchangeRate === selectedRate);
  const ready = !loading && !error && loadedContext === context && Boolean(rateReady);
  const preview = ready && quote ? paymentEntryPreview(quote, currency, value.amount) : null;
  const valid = ready && preview != null;
  useEffect(() => { onReadyChange(valid); }, [onReadyChange, valid]);

  return <section aria-label="Datos del pago" className="space-y-3 rounded-xl border border-[#34343E] bg-[#111117] p-3 sm:col-span-2">
    <div className="grid gap-3 sm:grid-cols-2">
      <label htmlFor={`${id}-date`} className="text-xs text-[#C7C8D1]">Fecha real del pago
        <input id={`${id}-date`} className={field} type="date" value={value.operationDate} disabled={disabled}
          onChange={event => { request.current++; setSelectedRate(''); onReadyChange(false);
            onChange({ operationDate: event.target.value, exchangeRate: '', amount: '' }); }} />
      </label>
      {currency === 'VES' ? <label htmlFor={`${id}-rate`} className="text-xs text-[#C7C8D1]">¿Con qué tasa se calculó este pago?
        <select id={`${id}-rate`} className={field} value={loadedContext === context ? selectedRate : ''} disabled={disabled || loading || !quote || Boolean(error)}
          onChange={event => { setSelectedRate(event.target.value); onReadyChange(false);
            if (event.target.value) void load(Number(event.target.value)); }}>
          <option value="">Selecciona una tasa de ese día</option>
          {quote?.dayRates.map(rate => <option key={rate} value={String(rate)}>{number(rate, 6)} Bs por USD</option>)}
        </select>
        <span className="mt-1 block">Si hubo varias tasas, elige la utilizada con el cliente. El sistema no la adivina.</span>
      </label> : null}
      <label htmlFor={`${id}-amount`} className="text-xs text-[#C7C8D1]">Monto recibido · {currency === 'VES' ? 'Bs' : 'USD'}
        <input id={`${id}-amount`} className={field} inputMode="decimal" value={value.amount} disabled={disabled || !ready}
          onChange={event => onChange({ ...value, amount: event.target.value })} onFocus={event => event.currentTarget.select()} />
        <span className="mt-1 block">Sin separadores de miles. Ejemplo: 37301,04.</span>
      </label>
      {ready && quote && quote.pendingUsd > 0 ? <button type="button" disabled={disabled} className="self-center rounded-lg border border-[#FEEF00]/50 px-3 py-2 text-xs text-[#FEEF00]"
        onClick={() => onChange({ ...value, amount: String(currency === 'VES' ? quote.pendingBs : quote.pendingUsd) })}>Completar saldo</button> : null}
    </div>
    {loading ? <p role="status" className="text-xs text-[#C7C8D1]">Consultando fecha, saldo y tasas…</p> : null}
    {error ? <p role="alert" className="text-xs text-red-200">{error} <button type="button" className="min-h-11 underline" onClick={() => void load()}>Reintentar</button></p> : null}
    {quote?.collectionMode === 'snapshot_quote' ? <p className="text-xs text-amber-100">Este pedido conserva su precio original en Bs. La tasa no cambia ese importe.</p> : null}
    {preview ? <dl className="grid gap-2 text-sm tabular-nums sm:grid-cols-3">
      <div><dt className="text-xs text-[#9FA0AA]">Se registra</dt><dd>{currency === 'VES' ? 'Bs' : 'USD'} {number(preview.amount)}</dd></div>
      <div><dt className="text-xs text-[#9FA0AA]">Abono equivalente estimado</dt><dd>USD {number(preview.appliedUsd)}</dd></div>
      <div><dt className="text-xs text-[#9FA0AA]">{preview.excessUsd > 0 ? 'Excedente estimado' : 'Quedará pendiente estimado'}</dt><dd>USD {number(preview.excessUsd || preview.pendingUsd)}</dd></div>
    </dl> : ready && value.amount ? <p role="alert" className="text-xs text-red-200">Revisa el monto: usa hasta dos decimales, sin separadores de miles.</p> : null}
  </section>;
}
