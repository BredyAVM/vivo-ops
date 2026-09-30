'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatCounterAmount } from './amount-review';

/** A separate, explicit decision before a real receipt or cash outflow. */
export function CounterAmountReview({
  title, amount, currency, orderId, clientName, method, accountLabel, accountName,
  operationDate, reference, bankName, payerName, notes, exchangeRate,
  immediate, busy, onCorrect, onConfirm, children,
}: {
  title: string;
  amount: number;
  currency: 'USD' | 'VES';
  orderId: number;
  clientName: string;
  method: string;
  accountLabel: string;
  accountName: string;
  operationDate: string;
  reference?: string | null;
  bankName?: string | null;
  payerName?: string | null;
  notes?: string | null;
  exchangeRate?: number | null;
  immediate: boolean;
  busy: boolean;
  onCorrect: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => { heading.current?.focus(); }, []);
  const formatted = formatCounterAmount(amount, currency);
  const dateLabel = operationDate.split('-').reverse().join('/');

  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <div className="text-center">
        <h3 ref={heading} tabIndex={-1} id={titleId} className="text-xl font-bold text-[#F5F5F7] outline-none">{title}</h3>
        <p className="mt-1 text-sm text-[#C7C8D1]">Orden #{orderId} · {clientName}</p>
        <p className="mt-1 text-xs text-[#9FA0AA]">Comprueba el importe y los datos antes de confirmar.</p>
      </div>
      <div className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/[0.06] px-3 py-5 text-center">
        <div className="text-sm font-semibold text-[#FEEF00]">{currency === 'VES' ? 'Bolívares (VES)' : 'Dólares (USD)'}</div>
        <div className="my-2 break-words text-4xl font-bold tabular-nums tracking-wide text-[#F5F5F7] sm:text-5xl">{formatted}</div>
        <div className="text-xs text-[#C7C8D1]">Punto para miles · Coma para decimales</div>
      </div>
      <dl className="grid gap-3 rounded-xl border border-[#303044] bg-[#111118] p-4 text-sm sm:grid-cols-2">
        <Detail label="Medio" value={method} />
        <Detail label={accountLabel} value={accountName} />
        <Detail label="Fecha de operación" value={dateLabel} />
        {reference ? <Detail label="Referencia" value={reference} /> : null}
        {bankName ? <Detail label="Banco" value={bankName} /> : null}
        {payerName ? <Detail label="Titular / dato del comprobante" value={payerName} /> : null}
        {currency === 'VES' && exchangeRate ? <Detail label="Tasa de la operación" value={`${formatCounterAmount(exchangeRate, 'VES')} por USD`} /> : null}
        {notes ? <Detail label="Nota" value={notes} /> : null}
      </dl>
      <p className={`rounded-lg border p-3 text-sm ${immediate ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100' : 'border-orange-400/30 bg-orange-400/10 text-orange-100'}`}>
        {immediate
          ? 'Al confirmar se registrará el movimiento en la cuenta indicada.'
          : 'Se enviará a Master para verificar. Este reporte todavía no confirma dinero ni habilita cambio.'}
      </p>
      {children}
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#45455A] p-4 text-sm text-[#F5F5F7]">
        <input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#FEEF00]" />
        <span>Verifiqué <strong className="tabular-nums">{formatted}</strong>, la cuenta y los datos contra el efectivo o comprobante.</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" disabled={busy} onClick={onCorrect} className="min-h-12 rounded-lg border border-[#45455A] px-4 py-3 text-sm font-semibold text-[#F5F5F7] disabled:opacity-50">Corregir datos</button>
        <button type="button" disabled={!checked || busy} onClick={() => { if (checked && !busy) onConfirm(); }} className="min-h-12 rounded-lg border border-[#FEEF00] bg-[#FEEF00] px-4 py-3 text-sm font-bold text-black disabled:opacity-40">
          {busy ? 'Registrando…' : immediate ? 'Sí, registrar operación' : 'Sí, enviar a revisión'}
        </button>
      </div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-[#9FA0AA]">{label}</dt><dd className="mt-1 break-words font-semibold text-[#F5F5F7]">{value}</dd></div>;
}
