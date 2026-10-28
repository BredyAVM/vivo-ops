'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { useDialogFocus } from '@/components/ui/useDialogFocus';
import { readEventOrderEditAction, saveEventOrderEditAction } from '@/app/app/events/order-edit-actions';
import { calculateEventBreakdown, validateEventOrderEdit, type EventOrderEditData, type EventOrderComponent, type EventPriceBreakdown } from '@/lib/events/event-order-edit';
import { parseDecimalInput } from '@/lib/number-input';

const field = 'mt-1 w-full min-w-0 rounded-lg border border-[#30303D] bg-[#0B0B0D] px-2.5 py-2 text-xs text-[#E4E4EA]';
const button = 'rounded-lg border border-[#30303D] px-3 py-2 text-xs disabled:opacity-40';
const money = (amount: number, currency: string) => `${currency === 'VES' ? 'Bs' : 'USD'} ${amount.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type BreakdownFields = Record<keyof EventPriceBreakdown, string>;
const blankBreakdown: BreakdownFields = { combos: '', pieces_per_combo: '', price_per_combo: '', stand: '0', discount_pct: '0' };

export default function EventOrderEditor({ orderId, onClose, onSaved }: { orderId: number; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<EventOrderEditData | null>(null);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<'total' | 'breakdown'>('total');
  const [amount, setAmount] = useState('');
  const [breakdown, setBreakdown] = useState<BreakdownFields>(blankBreakdown);
  const [components, setComponents] = useState<EventOrderComponent[]>([]);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(() => { if (!pending) onClose(); });
  useEffect(() => {
    let active = true;
    readEventOrderEditAction(orderId).then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.error); return; }
      setData(result.data); setAmount(String(result.data.amount)); setComponents(result.data.components);
      if (result.data.breakdown) {
        setMode('breakdown');
        setBreakdown(Object.fromEntries(Object.entries(result.data.breakdown).map(([key, value]) => [key, String(value)])) as BreakdownFields);
      }
    }).catch(() => { if (active) setError('No se pudo consultar el evento. Cierra y vuelve a abrir.'); });
    return () => { active = false; };
  }, [orderId]);
  const parsed = Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, parseDecimalInput(value)])) as EventPriceBreakdown;
  let calculation: ReturnType<typeof calculateEventBreakdown> | null = null;
  try { calculation = calculateEventBreakdown(parsed); } catch { /* Incomplete fields remain editable. */ }
  const total = mode === 'breakdown' ? calculation?.total : parseDecimalInput(amount);
  function prepareConfirmation(event: FormEvent) {
    event.preventDefault(); setError('');
    try { validateEventOrderEdit({ mode, amount: parseDecimalInput(amount), breakdown: mode === 'breakdown' ? parsed : null, components, reason }); setConfirming(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Revisa los datos.'); }
  }
  function save() {
    if (!data) return;
    setError('');
    startTransition(async () => {
      try {
        const result = await saveEventOrderEditAction(orderId, data.version, {
          mode, amount: parseDecimalInput(amount), breakdown: mode === 'breakdown' ? parsed : null, components, reason,
        });
        if (!result.ok) { setError(result.error); setConfirming(false); return; }
        onSaved();
      } catch {
        setError('No se pudo confirmar el resultado. Cierra y vuelve a consultar el evento antes de reintentar.');
        setConfirming(false);
      }
    });
  }
  function updateComponent(index: number, patch: Partial<EventOrderComponent>) {
    setConfirming(false); setComponents(current => current.map((component, i) => i === index ? { ...component, ...patch } : component));
  }
  function updateBreakdown(key: keyof EventPriceBreakdown, value: string) {
    const next = { ...breakdown, [key]: value };
    setBreakdown(next);
    if (data?.components_editable && components.length === 1 && (key === 'combos' || key === 'pieces_per_combo')) {
      const count = parseDecimalInput(next.combos) * parseDecimalInput(next.pieces_per_combo);
      if (Number.isSafeInteger(count) && count > 0 && count <= 1000000) updateComponent(0, { qty: count });
    }
  }
  return <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/75 p-2 sm:p-4">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="event-edit-title" tabIndex={-1} className="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#30303D] bg-[#111117] text-[#E4E4EA] shadow-2xl">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[#292937] bg-[#111117] p-3">
        <div className="min-w-0"><h2 id="event-edit-title" className="text-sm font-semibold">Modificar evento · #{orderId}</h2><p className="mt-0.5 break-words text-xs text-[#B7B7C2]">{data?.title ?? 'Consultando evento…'}</p></div>
        <button data-dialog-close type="button" disabled={pending} onClick={onClose} className={button}>Cerrar</button>
      </header>
      {error ? <p role="alert" className="m-3 rounded-lg border border-red-400/30 bg-red-400/5 p-2 text-xs text-red-200">{error}</p> : null}
      {!data ? !error ? <p role="status" className="p-4 text-xs text-[#B7B7C2]">Cargando composición y condiciones guardadas…</p> : null :
        <form onSubmit={prepareConfirmation} className="space-y-4 p-3 text-xs" onChange={() => setConfirming(false)}>
          <section className="space-y-2" aria-label="Precio del evento">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Precio · {data.currency === 'VES' ? 'Bolívares' : 'Dólares'}</h3>
              <select aria-label="Forma de calcular el evento" value={mode} onChange={e => setMode(e.target.value as typeof mode)} className={field + ' !mt-0 !w-auto'}><option value="total">Total acordado</option><option value="breakdown">Combitos + servicio − descuento</option></select></div>
            {mode === 'total' ? <label className="block">Total acordado ({data.currency})<input className={field} inputMode="decimal" value={amount} onFocus={e => e.currentTarget.select()} onChange={e => setAmount(e.target.value)} /></label> : <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{([
                ['combos', 'Cantidad de combitos'], ['pieces_per_combo', 'Piezas por combito'], ['price_per_combo', `Precio por combito (${data.currency})`],
                ['stand', `Servicio de stand (${data.currency})`], ['discount_pct', 'Descuento (%)'],
              ] as const).map(([key, label]) => <label key={key}>{label}<input className={field} inputMode={key === 'combos' || key === 'pieces_per_combo' ? 'numeric' : 'decimal'} value={breakdown[key]} onFocus={e => e.currentTarget.select()} onChange={e => updateBreakdown(key, e.target.value)} /></label>)}</div>
              {calculation ? <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-[#191920] p-2 text-[#B7B7C2]"><span>Productos {money(calculation.products, data.currency)}</span><span>Servicio {money(parseDecimalInput(breakdown.stand), data.currency)}</span><span>Descuento −{money(calculation.discount, data.currency)}</span><span>{calculation.pieces} piezas previstas</span></div> : null}
            </>}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#FFFF00]/25 p-2"><span>Total nuevo <strong className="ml-2 text-sm text-[#FFFF00]">{Number.isFinite(total) ? money(total!, data.currency) : 'Completa los datos'}</strong></span><span className="text-[#B7B7C2]">Actual {money(data.amount, data.currency)}</span></div>
          </section>
          <section className="space-y-2" aria-label="Composición del evento"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Productos · cantidades en unidades</h3>
            {data.components_editable && calculation && components.length === 1 ? <button type="button" className={button} onClick={() => updateComponent(0, { qty: calculation!.pieces })}>Usar {calculation.pieces} piezas</button> : null}</div>
            {!data.components_editable ? <p className="text-[#B7B7C2]">La preparación ya comenzó. El precio se puede ajustar; las piezas conservan su registro operativo.</p> : null}
            {components.map((component, index) => <div key={component.product_id} className="grid grid-cols-[1fr_76px] items-end gap-2 border-b border-[#292937] pb-2 sm:grid-cols-[1fr_85px_145px_auto]">
              <span className="self-center break-words">{component.product_name}</span><label>Unidades<input className={field} type="number" min="1" max="1000000" step="1" disabled={!data.components_editable} value={component.qty || ''} onFocus={e => e.currentTarget.select()} onChange={e => updateComponent(index, { qty: Number(e.target.value) })} /></label>
              <label>Preparación<select className={field} disabled={!data.components_editable} value={component.preparation_mode} onChange={e => updateComponent(index, { preparation_mode: e.target.value as EventOrderComponent['preparation_mode'] })}><option value="kitchen">Cocina</option><option value="on_site">En el sitio</option><option value="not_applicable">Sin preparación</option></select></label>
              {data.components_editable ? <button className={button} type="button" disabled={components.length === 1} onClick={() => setComponents(current => current.filter((_, i) => index !== i))}>Quitar</button> : null}
            </div>)}
            {data.components_editable ? <select aria-label="Agregar producto al evento" className={field} value="" onChange={e => { const product = data.products.find(p => p.id === Number(e.target.value)); if (product) setComponents(current => [...current, { product_id: product.id, product_name: product.name, qty: 1, preparation_mode: 'kitchen' }]); }}><option value="">Agregar producto…</option>{data.products.filter(p => !components.some(c => c.product_id === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : null}
          </section>
          <p className="text-[#B7B7C2]">Comisión conservada: {data.commission_mode === 'none' ? 'sin comisión' : data.commission_mode === 'default' ? 'condiciones del asesor' : `${data.commission_value}%`}. El total ya incluye el descuento indicado.</p>
          <label className="block">Motivo del cambio<textarea required maxLength={1000} className={field} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>
          {confirming ? <div className="space-y-2 rounded-lg border border-[#FFFF00]/35 p-3" role="alert"><p>¿Confirmas modificar el evento #{orderId} de {money(data.amount, data.currency)} a <strong>{money(total!, data.currency)}</strong>?</p><p className="text-[#B7B7C2]">Se guardará el antes y después. Los pagos registrados y los cierres de comisiones se conservan.</p><div className="flex justify-end gap-2"><button type="button" className={button} disabled={pending} onClick={() => setConfirming(false)}>Volver a editar</button><button type="button" disabled={pending} className="rounded-lg bg-[#FFFF00] px-3 py-2 font-semibold text-black disabled:opacity-40" onClick={save}>{pending ? 'Guardando…' : 'Confirmar cambio'}</button></div></div> : <div className="flex justify-end"><button type="submit" disabled={pending || data.status === 'cancelled'} className="rounded-lg bg-[#FFFF00] px-3 py-2 font-semibold text-black disabled:opacity-40">Revisar cambio</button></div>}
        </form>}
    </div>
  </div>;
}
