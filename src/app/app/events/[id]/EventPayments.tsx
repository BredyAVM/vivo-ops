'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { eventPaymentCommand } from '../workspace-actions';
import { eventPaymentMethods, eventPaymentState, type EventPaymentAllocation, type EventPaymentData } from '@/lib/events/event-payments';
import { getPaymentReportRequirements } from '@/lib/payments/payment-report-rules';

const field = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
const button = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40';
const money = (amount: number, currency: string) => `${currency === 'VES' ? 'Bs' : 'USD'} ${Number(amount).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function EventPayments({ rootId, data, admin, master }: { rootId: number; data: EventPaymentData; admin: boolean; master: boolean }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ accountId: '', method: '', amount: '', rate: '', date: '', reference: '', bank: '', payer: '', notes: '' });
  const [allocations, setAllocations] = useState<EventPaymentAllocation[] | null>(null);
  const requestKey = useRef<string | null>(null);
  const account = data.accounts.find(a => Number(a.id) === Number(form.accountId));
  const requirements = getPaymentReportRequirements(form.method);
  const pending = data.payments.some(p => p.state === 'pending');
  function edit(values: Partial<typeof form>) { setForm(current => ({ ...current, ...values })); setAllocations(null); requestKey.current = null; setError(''); }
  const input = () => ({ ...form, accountId: Number(form.accountId), currency: account?.currency, amount: Number(form.amount), rate: account?.currency === 'VES' ? Number(form.rate) : null });
  function act(action: string, payload: Record<string, unknown>) {
    setError(''); setMessage('');
    startTransition(async () => {
      try {
        const response = await eventPaymentCommand(rootId, action, payload);
        if (!response.ok) { setError(response.error); return; }
        if (action === 'preview') { setAllocations(response.data.allocations ?? []); return; }
        setMessage(action === 'report' ? 'Pago enviado a revisión. Todavía no se ha sumado al dinero recibido.' : action === 'confirm' ? 'Pago confirmado y distribuido entre las órdenes.' : 'Guardado.');
        if (action === 'report') setForm({ accountId: '', method: '', amount: '', rate: '', date: '', reference: '', bank: '', payer: '', notes: '' });
        setOpen(false); setAllocations(null); requestKey.current = null; router.refresh();
      } catch { setError('No se pudo confirmar la respuesta. Reintenta sin cambiar los datos; el pago no se duplicará.'); }
    });
  }
  return <section className="space-y-3 rounded-xl border border-zinc-800 p-4" aria-label="Pagos del evento">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Pagos del evento</h2><button className={button} disabled={busy || pending} onClick={() => setOpen(!open)}>Reportar un pago</button></div>
    <p className="text-xs text-zinc-400">Un solo pago para varias órdenes. Máster confirma; Administración puede anularlo completo.</p>
    {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    {message ? <p role="status" className="text-sm text-emerald-300">{message}</p> : null}
    {pending ? <p className="text-sm text-amber-300">Hay un pago pendiente de revisión.</p> : null}
    {open && !pending ? <fieldset disabled={busy} className="space-y-3">
      <legend className="sr-only">Datos del pago recibido</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">Cuenta de destino<select className={`${field} mt-1`} value={form.accountId} onChange={e => edit({ accountId: e.target.value, method: '', rate: '' })}><option value="">Seleccionar cuenta</option>{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency === 'VES' ? 'Bs' : 'USD'}</option>)}</select></label>
        <label className="text-xs">Método<select className={`${field} mt-1`} value={form.method} onChange={e => edit({ method: e.target.value })}><option value="">Seleccionar método</option>{account?.methods?.map(method => <option key={method} value={method}>{eventPaymentMethods[method] ?? method}</option>)}</select></label>
        <label className="text-xs">Monto recibido · {account?.currency === 'VES' ? 'Bs' : 'USD'}<input className={`${field} mt-1`} type="number" min="0.01" step="0.01" value={form.amount} onChange={e => edit({ amount: e.target.value })} /></label>
        <label className="text-xs">Fecha del pago<input className={`${field} mt-1`} type="date" value={form.date} onChange={e => edit({ date: e.target.value })} /></label>
        {account?.currency === 'VES' ? <label className="text-xs">Tasa del pago · Bs por USD<input className={`${field} mt-1`} type="number" min="0.000001" step="0.000001" value={form.rate} onChange={e => edit({ rate: e.target.value })} /></label> : null}
        <label className="text-xs">Referencia{requirements.requiresReference ? ' (obligatoria)' : ' (opcional)'}<input className={`${field} mt-1`} value={form.reference} onChange={e => edit({ reference: e.target.value })} /></label>
        {requirements.requiresBank ? <label className="text-xs">Banco<input className={`${field} mt-1`} value={form.bank} onChange={e => edit({ bank: e.target.value })} /></label> : null}
        <label className="text-xs">Titular{requirements.requiresHolderName ? ' (obligatorio)' : ' (opcional)'}<input className={`${field} mt-1`} value={form.payer} onChange={e => edit({ payer: e.target.value })} /></label>
      </div>
      <label className="block text-xs">Nota opcional<input className={`${field} mt-1`} value={form.notes} onChange={e => edit({ notes: e.target.value })} /></label>
      <button className={button} disabled={!account || !form.method || !form.date || Number(form.amount) <= 0 || (account.currency === 'VES' && Number(form.rate) <= 0)} onClick={() => act('preview', input())}>Ver distribución</button>
      {allocations ? <div className="space-y-2 rounded-lg bg-zinc-900 p-3"><p className="text-xs text-zinc-400">Se abona primero a las órdenes más antiguas. Los precios no cambian.</p>{allocations.map(a => <div key={a.order_id} className="flex justify-between text-sm"><span>Orden #{a.order_id}</span><strong>{money(a.amount, account?.currency ?? 'USD')}</strong></div>)}<button className={`${button} bg-yellow-300 text-black`} onClick={() => { requestKey.current ??= crypto.randomUUID(); act('report', { ...input(), id: requestKey.current, allocations }); }}>Enviar pago a revisión</button></div> : null}
      <p className="text-xs text-zinc-400">Para cambio, retenciones o excedentes, utiliza el pago por orden. Aquí solo se distribuye el monto que cubre saldos pendientes.</p>
    </fieldset> : null}
    {data.payments.length === 0 ? <p className="text-sm text-zinc-400">Sin pagos agrupados. Los pagos anteriores por orden siguen incluidos en el resumen.</p> : data.payments.map(payment => <details key={payment.id} className="rounded-lg border border-zinc-800 p-3">
      <summary className="cursor-pointer text-sm">{payment.request.date} · {money(payment.request.amount, payment.request.currency)} · <span className={payment.state === 'pending' ? 'text-amber-300' : 'text-zinc-400'}>{eventPaymentState[payment.state] ?? payment.state}</span></summary>
      <div className="mt-3 space-y-2 text-sm"><p>{data.accounts.find(a => Number(a.id) === payment.request.accountId)?.name ?? 'Cuenta registrada'} · {eventPaymentMethods[payment.request.method]}</p><p>Referencia: {payment.request.reference || 'Sin referencia'}{payment.request.payer ? ` · ${payment.request.payer}` : ''}{payment.request.bank ? ` · ${payment.request.bank}` : ''}</p>{payment.request.rate ? <p>Tasa: {payment.request.rate} Bs/USD</p> : null}{payment.request.notes ? <p>{payment.request.notes}</p> : null}
        {payment.request.allocations.map(a => <div key={a.order_id} className="flex justify-between"><span>Orden #{a.order_id}</span><span>{money(a.amount, payment.request.currency)}</span></div>)}
        {payment.result.reason ? <p className="text-amber-300">{payment.result.reason}</p> : null}
        {master && payment.state === 'pending' ? <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => { if (window.confirm('¿Verificaste que este pago llegó a la cuenta indicada? Se confirmará completo.')) act('confirm', { id: payment.id }); }}>Confirmar pago completo</button><button className={button} disabled={busy} onClick={() => { const reason = window.prompt('Motivo del rechazo'); if (reason) act('reject', { id: payment.id, reason }); }}>Rechazar</button></div> : null}
        {admin && payment.state === 'confirmed' ? <button className={`${button} text-red-300`} disabled={busy} onClick={() => { const reason = window.prompt('Se anulará el pago en todas las órdenes. Indica el motivo:'); if (reason) act('void', { id: payment.id, reason }); }}>Anular pago completo</button> : null}
      </div>
    </details>)}
  </section>;
}
