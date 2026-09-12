'use client';

import Link from 'next/link';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import { adminMovementHistoryHref } from '@/lib/admin-finance/movement-navigation';
import type { MoneyTransferInput, MoneyTransferResult } from '@/lib/finance/money-transfer-model';
import { createAdminTransferAction } from './actions';

type Account = { id: number; name: string; currencyCode: 'USD' | 'VES' };
type Props = { accounts: Account[]; initialAccountId: number | null; activeRate: number | null; today: string };
const inputClass = 'w-full min-h-11 rounded-lg border border-[#343442] bg-[#0B0B0D] px-3 py-2 text-sm text-white';
const buttonClass = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-[#FEEF00]/50 px-4 text-sm font-semibold text-[#FEEF00] disabled:opacity-50';
const native = (amount: number, currency: string) => `${currency === 'VES' ? 'Bs' : 'USD'} ${new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(amount)}`;

export default function TransferForm({ accounts, initialAccountId, activeRate, today }: Props) {
  const initial = () => ({ source: initialAccountId ? String(initialAccountId) : '', target: '', amount: '', received: '', fee: '',
    sourceRate: activeRate ? String(activeRate) : '', targetRate: activeRate ? String(activeRate) : '', date: today,
    description: 'Traspaso entre cuentas', reference: '', notes: '' });
  const [form, setForm] = useState(initial);
  const [result, setResult] = useState<MoneyTransferResult | null>(null);
  const [submitted, setSubmitted] = useState<MoneyTransferInput | null>(null);
  const [validation, setValidation] = useState('');
  const [isPending, startTransition] = useTransition();
  const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  const attempt = useRef<MoneyTransferInput | null>(null);
  const source = accounts.find(account => String(account.id) === form.source);
  const target = accounts.find(account => String(account.id) === form.target);
  const locked = isPending || result?.status === 'uncertain' || result?.status === 'confirmed';

  function update(key: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [key]: value }));
    setValidation('');
    setResult(null);
  }

  function buildInput(): MoneyTransferInput {
    if (!source || !target || source.id === target.id) throw new Error('Selecciona dos cuentas diferentes.');
    const money = (value: string, allowZero = false) => {
      const number = value.trim() === '' && allowZero ? 0 : parseDecimalInput(value);
      if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0) || number > 1e9
        || Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) throw new Error('Indica importes válidos con un máximo de dos decimales.');
      return number;
    };
    const rate = (account: Account, value: string) => {
      if (account.currencyCode === 'USD') return null;
      const number = parseDecimalInput(value);
      if (!Number.isFinite(number) || number <= 0 || number > 1e9) throw new Error('Indica una tasa válida para cada cuenta en bolívares.');
      return number;
    };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(form.date) ? new Date(`${form.date}T12:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== form.date) throw new Error('Indica una fecha válida.');
    const sourceAmount = money(form.amount), targetAmount = money(form.received), feeAmount = money(form.fee, true);
    const sourceRate = rate(source, form.sourceRate), targetRate = rate(target, form.targetRate);
    requestId.current ??= crypto.randomUUID();
    return { requestId: requestId.current, sourceMoneyAccountId: source.id, targetMoneyAccountId: target.id,
      sourceAmount, targetAmount, feeAmount, sourceExchangeRateVesPerUsd: sourceRate, targetExchangeRateVesPerUsd: targetRate,
      movementDate: form.date, description: form.description.trim(), referenceCode: form.reference.trim(),
      counterpartyName: '', notes: form.notes.trim() };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || result?.status === 'confirmed') return;
    let input: MoneyTransferInput;
    try { input = attempt.current ?? buildInput(); }
    catch (error) { setValidation(error instanceof Error ? error.message : 'Revisa los datos.'); return; }
    busy.current = true;
    attempt.current = input;
    setSubmitted(input);
    setValidation('');
    startTransition(async () => {
      try {
        const outcome = await createAdminTransferAction(input);
        setResult(outcome);
        // A rejected call can be corrected, but keeps the SAME request identity.
        // The database rejects changed input if an earlier attempt did commit.
        if (outcome.status === 'rejected') attempt.current = null;
      } catch {
        setResult({ status: 'uncertain', message: 'No pudimos comprobar el resultado. Reintenta el mismo envío; no crees otro traspaso.' });
      } finally { busy.current = false; }
    });
  }

  if (accounts.length < 2) return <p role="status" className="text-sm text-orange-200">Necesitas dos cuentas activas para registrar una transferencia.</p>;
  if (result?.status === 'confirmed' && submitted) {
    const saved = submitted;
    return <section role="status" className="space-y-3 rounded-xl border border-emerald-400/30 p-4">
      <h2 className="text-lg font-semibold text-emerald-200">Transferencia registrada</h2>
      <p className="text-sm">{source?.name}: {native(saved.sourceAmount + Number(saved.feeAmount ?? 0), source?.currencyCode ?? '')} de salida total → {target?.name}: {native(saved.targetAmount, target?.currencyCode ?? '')} recibidos.</p>
      {result.receipt.replayed ? <p className="text-xs text-[#9B9BA7]">Se recuperó el registro del envío anterior; no se duplicó.</p> : null}
      <p className="break-all text-xs text-[#9B9BA7]">Comprobante: {result.receipt.movementGroupId}</p>
      <div className="flex flex-wrap gap-2">
        <Link className={buttonClass} prefetch={false} href={adminMovementHistoryHref(saved.sourceMoneyAccountId, saved.movementDate)}>Ver cuenta de origen</Link>
        <Link className={buttonClass} prefetch={false} href={adminMovementHistoryHref(saved.targetMoneyAccountId, saved.movementDate)}>Ver cuenta de destino</Link>
        <button className={buttonClass} type="button" onClick={() => {
          requestId.current = null; attempt.current = null; setSubmitted(null); setResult(null); setForm(initial());
        }}>Nueva transferencia</button>
      </div>
    </section>;
  }

  return <form onSubmit={submit} className="space-y-4">
    <fieldset disabled={locked} className="min-w-0 space-y-4 disabled:opacity-70">
      <legend className="sr-only">Datos de la transferencia</legend>
      <div className="grid gap-4 md:grid-cols-2">
        {(['source', 'target'] as const).map(side => {
          const account = side === 'source' ? source : target;
          return <section key={side} className="min-w-0 space-y-3 rounded-xl border border-[#292937] p-3">
            <h2 className="text-sm font-semibold">{side === 'source' ? 'Sale de' : 'Llega a'}</h2>
            <label className="block space-y-1 text-xs text-[#B7B7C2]">
              <span>Cuenta de {side === 'source' ? 'origen' : 'destino'}</span>
              <select required className={inputClass} value={form[side]} onChange={event => update(side, event.target.value)}>
                <option value="">Seleccionar cuenta</option>
                {accounts.map(row => <option key={row.id} value={row.id} disabled={String(row.id) === form[side === 'source' ? 'target' : 'source']}>{row.name} · {row.currencyCode}</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-xs text-[#B7B7C2]">
              <span>{side === 'source' ? 'Monto enviado' : 'Monto recibido'} · {account?.currencyCode ?? 'selecciona cuenta'}</span>
              <input required className={inputClass} inputMode="decimal" value={side === 'source' ? form.amount : form.received} onChange={event => update(side === 'source' ? 'amount' : 'received', event.target.value)} placeholder="0,00" />
            </label>
            {account?.currencyCode === 'VES' ? <label className="block space-y-1 text-xs text-[#B7B7C2]">
              <span>Tasa de {side === 'source' ? 'origen' : 'destino'} · Bs/USD</span>
              <input required className={inputClass} inputMode="decimal" value={form[side === 'source' ? 'sourceRate' : 'targetRate']} onChange={event => update(side === 'source' ? 'sourceRate' : 'targetRate', event.target.value)} />
            </label> : null}
          </section>;
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-[#B7B7C2]"><span>Fecha</span><input required type="date" className={inputClass} value={form.date} onChange={event => update('date', event.target.value)} /></label>
        <label className="space-y-1 text-xs text-[#B7B7C2]"><span>Comisión adicional · {source?.currencyCode ?? 'moneda de origen'} · opcional</span><input inputMode="decimal" className={inputClass} value={form.fee} onChange={event => update('fee', event.target.value)} placeholder="0,00" /></label>
      </div>
      <details className="text-sm text-[#B7B7C2]">
        <summary className="cursor-pointer py-2">Concepto, referencia y notas</summary>
        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs"><span>Concepto</span><input maxLength={240} className={inputClass} value={form.description} onChange={event => update('description', event.target.value)} /></label>
          <label className="space-y-1 text-xs"><span>Referencia · opcional</span><input maxLength={120} className={inputClass} value={form.reference} onChange={event => update('reference', event.target.value)} /></label>
          <label className="space-y-1 text-xs sm:col-span-2"><span>Notas · opcional</span><textarea maxLength={800} className={inputClass} value={form.notes} onChange={event => update('notes', event.target.value)} /></label>
        </div>
      </details>
    </fieldset>
    {source && target && Number.isFinite(parseDecimalInput(form.amount)) && Number.isFinite(parseDecimalInput(form.received)) ?
      <div aria-label="Resumen de transferencia" className="grid gap-2 rounded-xl border border-[#343442] p-3 text-sm sm:grid-cols-2">
        <p>Salida total: <strong>{native(parseDecimalInput(form.amount) + parseDecimalInput(form.fee, 0), source.currencyCode)}</strong></p>
        <p>Entrada: <strong>{native(parseDecimalInput(form.received), target.currencyCode)}</strong></p>
      </div> : null}
    <p className="text-xs text-[#9B9BA7]">La comisión se suma a la salida de origen. Registra el monto que realmente llega al destino. Esto registra el traspaso en VIVO; no ejecuta una transferencia bancaria.</p>
    {validation ? <p role="alert" className="text-sm text-orange-200">{validation}</p> : null}
    {result && result.status !== 'confirmed' ? <div role="alert" className="space-y-2 text-sm text-orange-200">
      <p>{result.message}</p>
      {result.status === 'uncertain' ? <p>No cierres ni recargues esta pantalla antes de comprobar el resultado.</p> : null}
    </div> : null}
    <button disabled={isPending} className={buttonClass} type="submit">{isPending ? 'Comprobando…' : result?.status === 'uncertain' ? 'Reintentar el mismo envío' : 'Registrar transferencia'}</button>
  </form>;
}
