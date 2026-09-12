'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { AccountClosureInput, AccountClosureResult } from '@/lib/finance/account-closure-model';
import { createAdminAccountClosure, previewAdminAccountClosure } from './actions';
type Account = { id: number; name: string; currencyCode: 'USD' | 'VES'; intraday: boolean };
type Preview = Awaited<ReturnType<typeof previewAdminAccountClosure>>;
const inputClass = 'mt-1 block min-h-11 w-full rounded-lg border border-[#343442] bg-[#14141C] px-3 py-2 text-sm';
export default function ClosureForm({ accounts, initialAccountId, activeRate, today, time }: { accounts: Account[]; initialAccountId: number | null; activeRate: number | null; today: string; time: string }) {
  const [accountId, setAccountId] = useState(initialAccountId ?? accounts[0]?.id ?? 0);
  const [date, setDate] = useState(today), [cutTime, setCutTime] = useState(time), [counted, setCounted] = useState('');
  const [rate, setRate] = useState(activeRate?.toString() ?? ''), [reason, setReason] = useState('Cierre diario'), [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false), [result, setResult] = useState<AccountClosureResult | null>(null), [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{ key: string; result: Preview } | null>(null);
  const busy = useRef(false), attempt = useRef<AccountClosureInput | null>(null);
  const account = accounts.find(a => a.id === accountId), effectiveTime = account?.intraday ? cutTime : '23:59';
  const key = `${accountId}:${date}:${effectiveTime}:${refresh}`;
  const preview = review?.key === key ? review.result : null;
  const uncertain = result?.status === 'uncertain';
  useEffect(() => {
    let cancelled = false;
    void previewAdminAccountClosure({ moneyAccountId: accountId, closureDate: date, closureTime: effectiveTime })
      .then(result => { if (!cancelled) setReview({ key, result }); })
      .catch(() => { if (!cancelled) setReview({ key, result: { status: 'error', message: 'No se pudo verificar el saldo esperado.' } }); });
    return () => { cancelled = true; };
  }, [accountId, date, effectiveTime, key]);
  const native = (n: number) => new Intl.NumberFormat('es-VE', { style: 'currency', currency: account?.currencyCode ?? 'USD' }).format(n);
  async function save(e?: FormEvent) {
    e?.preventDefault(); if (busy.current || !account || result?.status === 'confirmed') return;
    if (!attempt.current) {
      if (preview?.status !== 'ready' || !counted.trim()) return;
      attempt.current = { requestId: crypto.randomUUID(), moneyAccountId: accountId, closureDate: date, closureTime: effectiveTime,
        countedAmount: Number(counted.replace(',', '.')), exchangeRateVesPerUsd: account.currencyCode === 'VES' ? Number(rate.replace(',', '.')) : null, reason, notes };
    }
    busy.current = true; setPending(true);
    try { const next = await createAdminAccountClosure(attempt.current); setResult(next); if (next.status === 'rejected') attempt.current = null; }
    catch { setResult({ status: 'uncertain', message: 'La conexión se interrumpió. Reintenta este mismo cierre sin cambiar los datos.' }); }
    finally { busy.current = false; setPending(false); }
  }
  const history = `/app/admin/finanzas/cuentas/${accountId}?${new URLSearchParams({ vista: 'closures', desde: date, hasta: date })}`;
  if (result?.status === 'confirmed') return <section role="status" className="space-y-3 rounded-xl border border-emerald-800 p-4"><h2 className="text-base font-semibold">Cierre #{result.receipt.closureId} registrado</h2><p className="text-sm">{account?.name} · {date} {effectiveTime}</p><div className="grid grid-cols-2 gap-3 text-sm"><p>Contado<br /><strong>{native(attempt.current?.countedAmount ?? 0)}</strong></p><p>Diferencia<br /><strong>{native(result.receipt.differenceAmount)}</strong></p></div>{result.receipt.reconciliationItemId ? <p className="text-sm text-orange-200">Diferencia pendiente de conciliación #{result.receipt.reconciliationItemId}.</p> : null}<div className="flex flex-wrap gap-3"><Link href={history} prefetch={false} className="inline-flex min-h-11 items-center underline">Ver cierre e historial</Link><a href={`/app/admin/finanzas/cuentas/cierre?cuenta=${accountId}`} className="inline-flex min-h-11 items-center underline">Nuevo cierre</a></div></section>;
  return <form onSubmit={save} className="space-y-4 rounded-xl border border-[#292937] bg-[#121218] p-4">
    <fieldset disabled={pending || uncertain} className="grid gap-4 disabled:opacity-60 sm:grid-cols-2">
      <label className="text-sm">Cuenta<select value={accountId} onChange={e => setAccountId(Number(e.target.value))} className={inputClass}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currencyCode}</option>)}</select></label>
      <label className="text-sm">Fecha<input type="date" required value={date} onChange={e => setDate(e.target.value)} className={inputClass} /></label>
      {account?.intraday ? <label className="text-sm">Hora del corte · Caracas<input type="time" required value={cutTime} onChange={e => setCutTime(e.target.value)} className={inputClass} /></label> : <p className="self-center text-xs text-[#9B9BA7]">Esta cuenta se concilia por día completo.</p>}
      <label className="text-sm">Monto contado · {account?.currencyCode}<input required inputMode="decimal" value={counted} onChange={e => setCounted(e.target.value)} className={inputClass} /></label>
      {account?.currencyCode === 'VES' ? <label className="text-sm">Tasa Bs/USD<input required inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} className={inputClass} /></label> : null}
      <label className="text-sm">Motivo<input value={reason} maxLength={500} onChange={e => setReason(e.target.value)} className={inputClass} /></label>
      <label className="text-sm sm:col-span-2">Notas (opcional)<textarea value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} rows={2} className={inputClass} /></label>
    </fieldset>
    <section aria-live="polite">{preview?.status === 'ready' ? <div className="grid grid-cols-2 gap-3"><div><h2 className="text-xs text-[#9B9BA7]">Saldo esperado</h2><p className="mt-1 text-lg font-semibold tabular-nums">{native(preview.preview.expectedAmount)}</p></div><div><h2 className="text-xs text-[#9B9BA7]">Diferencia estimada</h2><p className="mt-1 text-lg font-semibold tabular-nums">{counted.trim() && Number.isFinite(Number(counted.replace(',', '.'))) ? native(Number(counted.replace(',', '.')) - preview.preview.expectedAmount) : '—'}</p></div></div> : <p className="text-sm text-orange-200">{preview?.status === 'error' ? preview.message : 'Consultando saldo esperado…'}</p>}</section>
    <p className="text-xs text-[#9B9BA7]">El saldo se recalcula al guardar. El cierre conserva las reglas de diferencias de esta cuenta; el traspaso del punto al banco se registra por separado.</p>
    {result && <p role="alert" className="text-sm text-orange-200">{result.message}</p>}
    {uncertain ? <div className="space-y-2"><p className="text-xs text-orange-200">No cierres ni recargues esta pantalla hasta comprobar el resultado.</p><button type="button" disabled={pending} onClick={() => void save()} className="min-h-11 rounded-lg bg-[#FEEF00] px-4 text-sm font-semibold text-black">{pending ? 'Comprobando…' : 'Comprobar el mismo cierre'}</button></div> : <div className="flex flex-wrap gap-3"><button disabled={pending || preview?.status !== 'ready' || !account} className="min-h-11 rounded-lg bg-[#FEEF00] px-4 text-sm font-semibold text-black disabled:opacity-50">{pending ? 'Guardando…' : 'Guardar cierre'}</button><button type="button" disabled={pending} onClick={() => setRefresh(n => n + 1)} className="min-h-11 px-3 text-sm underline">Actualizar saldo</button></div>}
  </form>;
}
