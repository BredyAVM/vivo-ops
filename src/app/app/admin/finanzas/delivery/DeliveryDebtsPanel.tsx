'use client';
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeliveryDebt, DeliveryDebtInput } from '@/lib/admin-finance/delivery-debts';
import type { DeliveryPayee } from '@/lib/admin-finance/delivery-extras';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { lookupDeliveryDebtOrder, recordDeliveryDebt, voidDeliveryDebt } from './actions';
import { deliveryButton, deliveryInput, deliveryPrimaryButton, type DeliveryPaymentAttempt } from './DeliveryPaymentForm';

export default function DeliveryDebtsPanel({ rows, payees, responsible, today, to, locked, onEditing }: {
  rows: DeliveryDebt[]; payees: DeliveryPayee[]; responsible: string; today: string; to: string;
  locked: boolean; onEditing: (editing: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DeliveryDebt['kind']>('loan');
  const [orderText, setOrderText] = useState('');
  const [order, setOrder] = useState<{ orderId: number; clientId: number; client: string; amount: number } | null>(null);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const attempt = useRef<DeliveryPaymentAttempt>(null);
  const visible = rows.filter(d => history || (!d.voided && d.balance > 0));
  const balance = rows.filter(d => !d.voided).reduce((n, d) => n + Math.round(d.balance * 100), 0) / 100;
  function close() { setOpen(false); setVoidId(null); setOrder(null); onEditing(false); }
  function lookup() {
    if (busy.current) return;
    busy.current = true; setMessage(''); setOrder(null);
    startTransition(async () => {
      try {
        const result = await lookupDeliveryDebtOrder(Number(orderText.replaceAll('-', '').trim()));
        if (result.ok) setOrder(result); else setMessage(result.message);
      } catch { setMessage('No se pudo consultar el pedido. Reintenta.'); }
      finally { busy.current = false; }
    });
  }
  function save(form: FormData) {
    if (busy.current || (kind === 'order' && !order)) return;
    const input: DeliveryDebtInput = { responsibleKey: String(form.get('responsible')), date: String(form.get('date')),
      kind, concept: String(form.get('concept')).trim(), amount: kind === 'order' ? order!.amount : Number(form.get('amount')),
      orderId: kind === 'order' ? order!.orderId : null, clientId: kind === 'order' ? order!.clientId : null, confirmed: form.get('confirmed') === 'on' };
    const payload = JSON.stringify(input);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { id: crypto.randomUUID(), payload };
    const id = attempt.current.id;
    busy.current = true; setMessage('');
    startTransition(async () => {
      try {
        const result = await recordDeliveryDebt(id, input);
        if (!result.ok) { setMessage(result.message); return; }
        attempt.current = null; close();
        setMessage(input.date > to ? `Deuda guardada para el ${input.date}. Consulta esa semana para verla.` : 'Deuda guardada. Elige cuánto descontar al pagar el período.');
        router.refresh();
      } catch { setMessage('Respuesta no confirmada. Reintenta con los mismos datos para evitar duplicados.'); }
      finally { busy.current = false; }
    });
  }
  function cancel(form: FormData) {
    if (busy.current || !voidId) return;
    const id = voidId; busy.current = true;
    startTransition(async () => {
      try { const result = await voidDeliveryDebt(id, String(form.get('reason'))); setMessage(result.message); if (result.ok) { close(); router.refresh(); } }
      catch { setMessage('No se pudo confirmar la anulación. Actualiza antes de reintentar.'); }
      finally { busy.current = false; }
    });
  }
  return <section className="min-w-0 overflow-hidden rounded-lg border border-[#292937] bg-[#111117]">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2"><h2 className="mr-auto text-sm font-semibold">Deudas y deducibles · ${balance.toFixed(2)}</h2>
      <button disabled={locked || pending || open || !!voidId} type="button" onClick={() => { setOpen(true); setMessage(''); onEditing(true); }} className={deliveryButton}>+ Registrar deuda</button></div>
    <p className="px-3 pb-2 text-[11px] text-[#B9B9C4]">Saldo pendiente actual de deudas hasta el {to}, incluidas las semanas anteriores. El descuento se elige al liquidar.</p>
    {open ? <form action={save} className="border-t border-[#292937] p-3"><fieldset disabled={pending} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-xs">Responsable<select name="responsible" defaultValue={payees.some(p => p.key === responsible) ? responsible : ''} required className={deliveryInput}><option value="">Seleccionar</option>{payees.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Fecha de la deuda<input name="date" type="date" defaultValue={today} max={today} required className={deliveryInput} /></label>
        <label className="grid gap-1 text-xs">Origen<select value={kind} onChange={e => { setKind(e.target.value as DeliveryDebt['kind']); setOrder(null); }} className={deliveryInput}><option value="loan">Préstamo ya entregado</option><option value="order">Compra: vincular pedido</option><option value="other">Otro cargo acordado</option></select></label>
        {kind !== 'order' ? <label className="grid gap-1 text-xs">Monto USD<input name="amount" type="number" min="0.01" max="999999999.99" step="0.01" required className={deliveryInput} /></label> : null}
        <label className="grid gap-1 text-xs sm:col-span-2">Concepto<input name="concept" minLength={3} maxLength={200} required className={deliveryInput} /></label>
      </div>
      {kind === 'order' ? <div className="space-y-2"><div className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs">Número corto del pedido<input value={orderText} onChange={e => { setOrderText(e.target.value); setOrder(null); }} inputMode="numeric" placeholder="Ej.: 25-63" className={deliveryInput} /></label><button type="button" onClick={lookup} disabled={!orderText.trim()} className={deliveryButton}>Consultar pedido</button></div>
        {order ? <p className="text-xs">#{formatOrderDisplayNumber(order.orderId)} · {order.client} · saldo ${order.amount.toFixed(2)}. Los descuentos abonarán este mismo pedido.</p> : null}</div> : <p className="text-xs text-[#B9B9C4]">Registra la deuda, no entrega dinero ni crea otro egreso. Si entregaste un préstamo, registra también su salida real en Cuentas. Para compras usa «Vincular pedido».</p>}
      <label className="flex min-h-9 items-center gap-2 text-xs"><input name="confirmed" type="checkbox" required />{kind === 'order' ? 'Confirmo que esta compra corresponde al responsable y se descontará de sus servicios.' : 'Confirmo que la deuda existe, está acordada y no la estoy registrando dos veces.'}</label>
      <div className="flex gap-2"><button disabled={kind === 'order' && !order} className={deliveryPrimaryButton}>{pending ? 'Guardando…' : 'Guardar deuda'}</button><button type="button" onClick={close} className={deliveryButton}>Cancelar</button></div>
    </fieldset></form> : null}
    {message ? <p role="status" className="px-3 pb-2 text-xs text-amber-100">{message}</p> : null}
    {visible.length ? <div role="region" aria-label="Deudas de delivery" tabIndex={0} className="max-h-64 overflow-auto"><table className="w-full min-w-[490px] text-left text-xs"><thead className="bg-[#191920] text-[#B9B9C4]"><tr><th className="px-3 py-2">Fecha / concepto</th>{!responsible ? <th className="px-3 py-2">Responsable</th> : null}<th className="px-3 py-2 text-right">Descontado</th><th className="px-3 py-2 text-right">Pendiente</th><th className="px-3 py-2">Acciones</th></tr></thead><tbody>{visible.map(d => <tr key={d.id} className="border-t border-[#292937]">
      <td className="px-3 py-2"><span>{d.date} · {d.concept}</span>{d.orderId ? <Link prefetch={false} href={`/app/master/ops?openOrder=${d.orderId}`} className="ml-2 underline">#{formatOrderDisplayNumber(d.orderId)} · {d.client}</Link> : null}</td>
      {!responsible ? <td className="px-3 py-2">{d.responsible}</td> : null}<td className="px-3 py-2 text-right tabular-nums">${d.deducted.toFixed(2)}</td><td className="px-3 py-2 text-right tabular-nums">{d.voided ? 'Anulada' : `$${d.balance.toFixed(2)}`}</td>
      <td className="px-3 py-2">{d.history.length ? <details><summary className="cursor-pointer min-h-8">Abonos</summary>{d.history.map(h => <Link key={h.paymentId} prefetch={false} href={`/app/admin/finanzas/delivery/pagos/${h.paymentId}`} className="block min-h-8 underline">${h.amount.toFixed(2)} · {h.reversed ? 'Revertido' : 'Comprobante'}</Link>)}</details> : null}
        {!d.voided && d.deducted === 0 ? <button type="button" disabled={locked || pending || open || !!voidId} onClick={() => { setVoidId(d.id); setMessage(''); onEditing(true); }} className="min-h-8 underline">Anular</button> : null}</td>
    </tr>)}</tbody></table></div> : !open ? <p className="px-3 pb-3 text-xs text-[#9B9BA7]">Sin deudas pendientes.</p> : null}
    {voidId ? <form action={cancel} className="border-t border-[#292937] p-3"><fieldset disabled={pending} className="flex flex-wrap items-end gap-2"><label className="grid flex-1 gap-1 text-xs">Motivo de anulación<input name="reason" minLength={6} maxLength={500} required className={deliveryInput} /></label><button className={deliveryButton}>Anular deuda</button><button type="button" onClick={close} className={deliveryButton}>Volver</button></fieldset></form> : null}
    {rows.length ? <label className="flex min-h-9 items-center gap-2 px-3 text-xs text-[#9B9BA7]"><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />Ver saldadas y anuladas</label> : null}
  </section>;
}
