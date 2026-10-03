'use client';

import { useRef, useState } from 'react';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { calculateOrderTotalsSnapshot, roundMoney } from '@/lib/pricing/order-snapshots';
import { loadDeliveredOrderPriceEditor, saveDeliveredOrderPriceEditor } from '@/lib/admin-finance/delivered-order-price-actions';

type Editor = Extract<Awaited<ReturnType<typeof loadDeliveredOrderPriceEditor>>, { ok: true }>['editor'];
const usd = (value: number) => `USD ${value.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DeliveredOrderPriceEditor({ orderId, onSaved }: { orderId: number; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const operation = useRef<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function open() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setEditor(null); setError(''); setMessage(''); setReason('');
    operation.current = crypto.randomUUID(); dialog.current?.showModal();
    try {
      const result = await loadDeliveredOrderPriceEditor(orderId);
      if (!result.ok) { setError(result.error); return; }
      setEditor(result.editor);
      setDrafts(Object.fromEntries(result.editor.items.map((item) => [item.id, item.unitPriceUsd.toFixed(2)])));
    } catch { setError('No se pudieron consultar los precios. Cierra y vuelve a intentar.'); }
    finally { pending.current = false; setBusy(false); }
  }

  const parsed = (value: string) => value.trim() ? Number(value.trim().replace(',', '.')) : NaN;
  const changed = editor?.items.filter((item) => !item.locked && parsed(drafts[item.id] ?? '') !== item.unitPriceUsd) ?? [];
  const subtotalUsd = editor ? editor.items.reduce((sum, item) => sum + (changed.includes(item) ? roundMoney(parsed(drafts[item.id]) * item.qty) : item.lineUsd), 0) : 0;
  const subtotalBs = editor ? editor.items.reduce((sum, item) => sum + (changed.includes(item) ? roundMoney(roundMoney(parsed(drafts[item.id]) * item.qty) * editor.fxRate) : item.lineBs), 0) : 0;
  const valid = changed.every((item) => {
    const value = parsed(drafts[item.id]);
    return Number.isFinite(value) && value >= 0 && value <= 9999999999.99 && Math.abs(value * 100 - Math.round(value * 100)) < 0.0001;
  });
  const totals = editor ? calculateOrderTotalsSnapshot({ subtotalUsd, subtotalBs,
    discountPct: editor.money.discountEnabled ? editor.money.discountPct : 0, invoiceTaxPct: editor.money.invoiceTaxPct }) : null;

  async function save() {
    if (pending.current || !editor || !operation.current) return;
    if (!valid || !changed.length || !reason.trim()) { setError('Cambia un precio válido en USD e indica el motivo.'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await saveDeliveredOrderPriceEditor({ orderId, operationId: operation.current, lastModifiedAt: editor.lastModifiedAt,
        reason, changes: changed.map((item) => ({ itemId: item.id, unitPriceUsd: parsed(drafts[item.id]) })) });
      if (!result.ok) { setError(result.error); return; }
      setMessage(result.message); dialog.current?.close(); onSaved();
    } catch { setError('No se pudo confirmar el guardado. Recarga la orden para comprobarlo antes de volver a intentar.'); }
    finally { pending.current = false; setBusy(false); }
  }

  return <>
    <button type="button" disabled={busy} onClick={open} className="rounded-xl border border-[#FFFF00]/40 px-3 py-1.5 text-xs font-semibold text-[#FFFF00] disabled:opacity-50">Ajustar precios</button>
    {message ? <p role="status" className="w-full text-xs text-emerald-300">{message}</p> : null}
    <dialog ref={dialog} aria-labelledby={`price-title-${orderId}`} onCancel={(event) => { if (pending.current) event.preventDefault(); }} className="m-auto max-h-[90dvh] w-[min(94vw,580px)] overflow-y-auto rounded-2xl border border-[#30303B] bg-[#121218] p-4 text-sm text-[#F5F5F7] backdrop:bg-black/70">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`price-title-${orderId}`} className="text-sm font-semibold">Precios · Pedido {formatOrderDisplayNumber(orderId)}</h2>
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="rounded-lg border border-[#30303B] px-3 py-1 text-xs disabled:opacity-50">Cerrar</button>
      </div>
      <p className="my-3 text-xs text-[#B7B7C2]">Precio cobrado al cliente. Conserva productos, cantidades, entrega y pagos. El saldo se recalcula; no se cobra ni devuelve dinero automáticamente.</p>
      {busy && !editor ? <p role="status" className="text-xs">Consultando precios…</p> : null}
      {editor?.protectedReason ? <p className="mb-3 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200">{editor.protectedReason}</p> : null}
      {editor ? <fieldset disabled={busy || Boolean(editor.protectedReason)} className="space-y-3 disabled:opacity-70">
        <p className="text-xs text-[#B7B7C2]">Tasa de la orden: Bs {editor.fxRate.toLocaleString('es-VE')} / USD. Descuento e impuesto sin cambios.</p>
        {editor.items.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 border-b border-[#30303B] pb-2">
          <div className="min-w-0 flex-1 basis-40"><p className="break-words text-xs font-semibold">{item.qty} × {item.name}</p>
            <p className="mt-1 text-[11px] text-[#B7B7C2]">Actual {usd(item.unitPriceUsd)} / unidad{item.locked ? ' · Beneficio protegido' : ''}</p></div>
          <label className="w-28 text-xs">Precio unitario (USD)
            <input inputMode="decimal" disabled={item.locked} value={drafts[item.id] ?? ''} onChange={(event) => { operation.current = crypto.randomUUID(); setDrafts((current) => ({ ...current, [item.id]: event.target.value })); }} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#0B0B0D] px-2 py-1.5 text-sm disabled:opacity-50" />
          </label>
          <span className="w-full text-right text-[11px] text-[#B7B7C2]">{item.locked || !changed.includes(item) ? '' : valid ? `Bs ${roundMoney(parsed(drafts[item.id]) * editor.fxRate).toLocaleString('es-VE', { minimumFractionDigits: 2 })} / unidad` : 'Revisa el precio'}</span>
        </div>)}
        <p className="flex flex-wrap justify-between gap-2 text-xs"><span>Actual: {usd(editor.money.totalUsd)}</span><span className="font-semibold text-[#FFFF00]">Nuevo total: {valid && totals ? usd(totals.totalUsd) : '—'}</span></p>
        {valid && totals ? <p className="text-right text-[11px] text-[#B7B7C2]">Nuevo total Bs {totals.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p> : null}
        <label className="block text-xs">Motivo del ajuste
          <textarea rows={2} maxLength={500} value={reason} onChange={(event) => { operation.current = crypto.randomUUID(); setReason(event.target.value); }} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#0B0B0D] p-2 text-sm" />
        </label>
        <button type="button" disabled={busy || !valid || !changed.length || !reason.trim()} onClick={save} className="w-full rounded-xl bg-[#FFFF00] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar precios'}</button>
      </fieldset> : null}
      {error ? <p role="alert" className="mt-3 text-xs text-red-300">{error}</p> : null}
    </dialog>
  </>;
}
