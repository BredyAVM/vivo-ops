'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deliveryExtrasCsv, extraPayable, extraTotal, type DeliveryExtra, type DeliveryExtraInput, type DeliveryPayee } from '@/lib/admin-finance/delivery-extras';
import { recordDeliveryExtra, voidDeliveryExtra } from './actions';
import { deliveryButton, deliveryInput, deliveryPrimaryButton, type DeliveryPaymentAttempt } from './DeliveryPaymentForm';

export default function DeliveryExtrasPanel({ rows, payees, responsible, today, from, to, locked, partial, selected, onSelected, onEditing }: {
  rows: DeliveryExtra[]; payees: DeliveryPayee[]; responsible: string; today: string; from: string; to: string;
  locked: boolean; partial: boolean; selected: string[]; onSelected: (ids: string[]) => void; onEditing: (value: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const attempt = useRef<DeliveryPaymentAttempt>(null);
  const [showVoided, setShowVoided] = useState(false);
  const visible = rows.filter(r => showVoided || !r.voided);
  function close() { setOpen(false); setVoidId(null); onEditing(false); }
  function create(form: FormData) {
    if (submitting.current) return;
    const input: DeliveryExtraInput = { responsibleKey: String(form.get('responsible')), date: String(form.get('date')), concept: String(form.get('concept')).trim(), amount: Number(form.get('amount')) };
    const payload = JSON.stringify(input);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { id: crypto.randomUUID(), payload };
    const id = attempt.current.id;
    submitting.current = true;
    setMessage('');
    startTransition(async () => {
      try {
        const result = await recordDeliveryExtra(id, input);
        if (!result.ok) { setMessage(result.message); return; }
        attempt.current = null;
        setMessage(input.date < from || input.date > to ? `Servicio guardado para el ${input.date}. Consulta esa semana para verlo y pagarlo.` : 'Servicio guardado. Se incluirá al pagar el período del responsable.');
        close(); router.refresh();
      } catch { setMessage('No se pudo verificar la respuesta. Reintenta sin cambiar los datos para evitar duplicados.'); }
      finally { submitting.current = false; }
    });
  }
  function cancel(form: FormData) {
    if (submitting.current || !voidId) return;
    const id = voidId;
    submitting.current = true;
    startTransition(async () => {
      try {
        const result = await voidDeliveryExtra(id, String(form.get('reason')));
        setMessage(result.message);
        if (result.ok) { close(); onSelected(selected.filter(x => x !== id)); router.refresh(); }
      } catch { setMessage('No se pudo confirmar la anulación. Actualiza antes de reintentar.'); }
      finally { submitting.current = false; }
    });
  }
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([deliveryExtrasCsv(rows)], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url; a.download = `servicios-adicionales-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="min-w-0 overflow-hidden rounded-lg border border-[#292937] bg-[#111117]">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <h2 className="mr-auto text-sm font-semibold">Servicios adicionales · {rows.filter(r => !r.voided).length} · ${extraTotal(rows.filter(r => !r.voided)).toFixed(2)}</h2>
      {rows.length ? <button type="button" onClick={exportCsv} className={deliveryButton}>CSV servicios</button> : null}
      <button type="button" disabled={locked || pending || open || !!voidId} onClick={() => { setOpen(true); setMessage(''); onEditing(true); }} className={deliveryButton}>+ Agregar servicio adicional</button>
    </div>
    {open ? <form action={create} className="border-t border-[#292937] p-3">
      <fieldset disabled={pending} className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_140px_1.5fr_110px]">
          <label className="grid gap-1 text-xs">Motorizado o empresa<select name="responsible" defaultValue={payees.some(p => p.key === responsible) ? responsible : ''} required className={deliveryInput}><option value="">Seleccionar responsable</option>{payees.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
          <label className="grid gap-1 text-xs">Fecha del servicio<input name="date" type="date" defaultValue={today} max={today} required className={deliveryInput} /></label>
          <label className="grid gap-1 text-xs">Concepto<input name="concept" placeholder="Ej.: retirar un documento" minLength={3} maxLength={200} required className={deliveryInput} /></label>
          <label className="grid gap-1 text-xs">Monto USD<input name="amount" type="number" min="0.01" max="999999999.99" step="0.01" required className={deliveryInput} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2"><button className={deliveryPrimaryButton}>{pending ? 'Guardando…' : 'Guardar servicio'}</button><button type="button" onClick={close} className={deliveryButton}>Cancelar</button><span className="text-[11px] text-[#B9B9C4]">Queda pendiente de pago. No crea una orden ni mueve inventario.</span></div>
      </fieldset>
    </form> : null}
    {message ? <p role="status" className="px-3 pb-2 text-xs text-amber-100">{message}</p> : null}
    {visible.length ? <div role="region" aria-label="Detalle de servicios adicionales" tabIndex={0} className="max-h-64 overflow-auto">
      <table className="w-full min-w-[470px] text-left text-xs"><thead className="bg-[#191920] text-[11px] text-[#B9B9C4]"><tr>{partial ? <th scope="col" className="px-2 py-2">Elegir</th> : null}<th scope="col" className="px-3 py-2">Fecha</th><th scope="col" className="px-3 py-2">Concepto</th>{!responsible ? <th scope="col" className="px-3 py-2">Responsable</th> : null}<th scope="col" className="px-3 py-2 text-right">USD</th><th scope="col" className="px-3 py-2">Estado</th></tr></thead>
        <tbody>{visible.map(r => <tr key={r.id} className="border-t border-[#292937]">
          {partial ? <td className="px-2"><input type="checkbox" aria-label={`Incluir servicio ${r.concept}`} disabled={locked || pending || !extraPayable(r) || r.responsibleKey !== responsible} checked={selected.includes(r.id)} onChange={e => onSelected(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} /></td> : null}
          <td className="whitespace-nowrap px-3 py-2">{r.date.slice(8)}/{r.date.slice(5, 7)}</td><td className="max-w-72 px-3 py-2 break-words">{r.concept}</td>{!responsible ? <td className="px-3 py-2">{r.responsible}</td> : null}<td className="px-3 py-2 text-right tabular-nums">${r.amount.toFixed(2)}</td>
          <td className="px-3 py-2">{r.paymentId ? <Link prefetch={false} href={`/app/admin/finanzas/delivery/pagos/${r.paymentId}`} className="text-emerald-300 underline">Pagado →</Link> : r.voided ? <span title={r.voidReason || ''} className="text-[#9B9BA7]">Anulado</span> : <span className="flex items-center gap-3">Pendiente<button type="button" disabled={locked || pending || open || !!voidId} onClick={() => { setVoidId(r.id); setMessage(''); onEditing(true); }} className="min-h-8 text-[#B9B9C4] underline">Anular</button></span>}</td>
        </tr>)}</tbody>
      </table>
    </div> : !open ? <p className="px-3 pb-3 text-xs text-[#9B9BA7]">Sin servicios adicionales en este período.</p> : null}
    {voidId ? <form action={cancel} className="border-t border-[#292937] p-3"><fieldset disabled={pending} className="flex flex-wrap items-end gap-2"><label className="grid flex-1 gap-1 text-xs">Motivo para anular «{rows.find(r => r.id === voidId)?.concept}»<input name="reason" minLength={6} maxLength={500} required className={deliveryInput} /></label><button className={deliveryButton}>Confirmar anulación</button><button type="button" onClick={close} className={deliveryButton}>Volver</button></fieldset></form> : null}
    {rows.some(r => r.voided) ? <label className="flex min-h-9 items-center gap-2 px-3 text-xs text-[#9B9BA7]"><input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />Ver anulados</label> : null}
  </section>;
}
