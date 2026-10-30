'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { loadStaffPayrollAccountsAction } from '@/app/app/master/ops/staff-payroll-actions';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { parseDecimalInput } from '@/lib/number-input';
import { validateStaffPayrollDraft, type StaffPayrollAccount } from '@/lib/payments/staff-payroll';

export type StaffPayrollDraft = {
  moneyAccountId: number;
  amountUsd: number;
  operationDate: string;
  notes: string;
};

const inputClass = 'mt-1 w-full min-w-0 rounded-md border border-[#343442] bg-[#121218] px-2 py-1.5 text-xs text-[#F5F5F7]';
const usd = (amount: number) => `USD ${amount.toFixed(2)}`;

export default function StaffPayrollPaymentForm({ orderId, pendingUsd, operationDate, busy, onApply, onClose }: {
  orderId: number;
  pendingUsd: number;
  operationDate: string;
  busy: boolean;
  onApply: (draft: StaffPayrollDraft) => Promise<boolean>;
  onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<StaffPayrollAccount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(pendingUsd.toFixed(2));
  const [date, setDate] = useState(operationDate);
  const [notes, setNotes] = useState(`Descuento de personal · orden #${formatOrderDisplayNumber(orderId)}`);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<StaffPayrollDraft | null>(null);
  const [applying, setApplying] = useState(false);
  const requestBusyRef = useRef(false);
  const disabled = busy || loading || applying;
  const selected = accounts?.find(account => account.id === Number(accountId));

  useEffect(() => {
    let mounted = true;
    loadStaffPayrollAccountsAction().then(options => {
      if (!mounted) return;
      setAccounts(options);
      setAccountId(options.length === 1 ? String(options[0].id) : '');
    }).catch(cause => {
      if (mounted) setError(cause instanceof Error ? cause.message : 'No se pudieron consultar las cuentas de personal.');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  async function loadAccounts() {
    if (requestBusyRef.current) return;
    requestBusyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const options = await loadStaffPayrollAccountsAction();
      setAccounts(options);
      setAccountId(options.length === 1 ? String(options[0].id) : '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudieron consultar las cuentas de personal.');
    } finally {
      requestBusyRef.current = false;
      setLoading(false);
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountUsd = parseDecimalInput(amount);
    const problem = validateStaffPayrollDraft(amountUsd, date, pendingUsd);
    if (problem || !selected) { setError(problem ?? 'Selecciona la cuenta interna de personal.'); return; }
    setError(null);
    setReview({ moneyAccountId: selected.id, amountUsd, operationDate: date, notes: notes.trim() });
  }

  async function confirm() {
    if (!review || disabled || requestBusyRef.current) return;
    const problem = validateStaffPayrollDraft(review.amountUsd, review.operationDate, pendingUsd);
    if (problem) { setReview(null); setError(problem); return; }
    requestBusyRef.current = true;
    setApplying(true);
    try {
      if (await onApply(review)) onClose();
      else { setReview(null); setError('No se completó la operación. Revisa los pagos de la orden antes de volver a intentarlo.'); }
    } finally {
      requestBusyRef.current = false;
      setApplying(false);
    }
  }

  return <section aria-label="Pago por nómina" className="mt-3 min-w-0 rounded-lg border border-[#FFFF00]/35 bg-[#121218] p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold">Pagar por nómina · #{formatOrderDisplayNumber(orderId)}</h3>
      <span className="text-[#FFFF00]">Pendiente {usd(pendingUsd)}</span>
    </div>
    <p className="mt-1 text-[11px] text-[#B7B7C2]">Registra el descuento de personal sin mover dinero de bancos ni caja.</p>
    {error ? <p role="alert" className="mt-2 text-xs text-red-300">{error}</p> : null}
    {accounts === null ? <div className="mt-3 flex flex-wrap gap-2">
      {loading ? <p role="status" className="text-[#B7B7C2]">Consultando cuenta de personal…</p> : <button type="button" disabled={disabled} onClick={() => void loadAccounts()} className="rounded-md border border-[#FFFF00]/50 px-3 py-2 text-xs text-[#FFFF00] disabled:opacity-50">Volver a consultar</button>}
      <button type="button" disabled={disabled} onClick={onClose} className="rounded-md border border-[#343442] px-3 py-2 text-xs">Cerrar</button>
    </div> : accounts.length === 0 ? <div className="mt-3">
      <p className="text-[#B7B7C2]">No hay una cuenta interna de personal activa. Revisa la configuración de cuentas.</p>
      <button type="button" onClick={onClose} className="mt-2 rounded-md border border-[#343442] px-3 py-2">Cerrar</button>
    </div> : review ? <div role="group" aria-label="Confirmación de nómina" className="mt-3 rounded-md border border-[#FFFF00]/30 p-3">
      <p>¿Confirmas aplicar {usd(review.amountUsd)} por nómina a la orden #{formatOrderDisplayNumber(orderId)}?</p>
      <p className="mt-1 break-words text-[#B7B7C2]">{selected?.name} ({selected?.currencyCode === 'VES' ? 'Bs' : 'USD'}) · {review.operationDate}</p>
      {selected?.currencyCode === 'VES' ? <p className="mt-1 text-[11px] text-[#B7B7C2]">El equivalente Bs se calcula con las condiciones de cobro de la fecha indicada.</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={disabled} onClick={() => void confirm()} className="rounded-md bg-[#FFFF00] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">{applying ? 'Aplicando…' : 'Confirmar pago por nómina'}</button>
        <button type="button" disabled={disabled} onClick={() => setReview(null)} className="rounded-md border border-[#343442] px-3 py-2 text-xs">Volver a editar</button>
      </div>
    </div> : <form onSubmit={prepare} className="mt-3 grid gap-3">
      <fieldset disabled={disabled} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 sm:col-span-2">Cuenta interna de personal<select className={inputClass} value={accountId} onChange={event => setAccountId(event.target.value)} required><option value="">Selecciona una cuenta</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currencyCode === 'VES' ? 'Bs' : 'USD'})</option>)}</select></label>
        <label className="min-w-0">Monto a aplicar (USD)<input autoFocus className={inputClass} inputMode="decimal" value={amount} onFocus={event => event.currentTarget.select()} onChange={event => setAmount(event.target.value)} required /></label>
        <label className="min-w-0">Fecha de aplicación<input className={inputClass} type="date" value={date} onChange={event => setDate(event.target.value)} required /></label>
        <label className="min-w-0 sm:col-span-2">Nota interna (opcional)<textarea className={inputClass} rows={2} value={notes} onChange={event => setNotes(event.target.value)} /></label>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button disabled={disabled} type="submit" className="rounded-md bg-[#FFFF00] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Revisar aplicación</button>
        <button disabled={disabled} type="button" onClick={onClose} className="rounded-md border border-[#343442] px-3 py-2 text-xs">Cancelar</button>
      </div>
    </form>}
  </section>;
}
