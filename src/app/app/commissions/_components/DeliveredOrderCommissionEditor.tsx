'use client';

import { useRef, useState } from 'react';
import { useWorkspaceRouter as useRouter } from '@/components/navigation/useWorkspaceRouter';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { commissionTermsEqual, formatOrderCommissionTerms } from '@/lib/commissions/order-commission-terms';
import type { DeliveredCommissionChange } from '@/lib/commissions/delivered-order-commission';
import { loadDeliveredOrderCommissionEditor, saveDeliveredOrderCommissionEditor } from '../order-actions';

type Editor = Extract<Awaited<ReturnType<typeof loadDeliveredOrderCommissionEditor>>, { ok: true }>['editor'];
type Draft = { mode: string; value: string };

export default function DeliveredOrderCommissionEditor({ orderId }: { orderId: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function open() {
    setBusy(true); setError(''); setMessage(''); setEditor(null); setReason('');
    dialog.current?.showModal();
    try {
      const result = await loadDeliveredOrderCommissionEditor(orderId);
      if (!result.ok) { setError(result.error); return; }
      setEditor(result.editor);
      setDrafts(Object.fromEntries(result.editor.items.map((item) => [item.id, {
        mode: item.override?.mode ?? 'inherit', value: item.override?.value == null ? '' : String(item.override.value),
      }])));
    } catch { setError('No se pudo cargar la comisión. Vuelve a intentarlo.'); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!editor) return;
    setError('');
    const changes: DeliveredCommissionChange[] = [];
    for (const item of editor.items) {
      const draft = drafts[item.id];
      if (draft.mode === 'inherit') {
        if (item.override) changes.push({ itemId: item.id, action: 'clear' });
        continue;
      }
      const fixed = draft.mode === 'fixed_item' || draft.mode === 'fixed_order';
      const value = fixed ? Number(draft.value.trim().replace(',', '.')) : null;
      if (fixed && (!draft.value.trim() || !Number.isFinite(value) || value! < 0 || value! > 100)) {
        setError(`${item.name}: indica un porcentaje entre 0 y 100.`); return;
      }
      const terms = { mode: draft.mode as 'default' | 'fixed_item' | 'fixed_order' | 'none', value };
      if (!commissionTermsEqual(item.override, terms)) changes.push({ itemId: item.id, action: 'set', ...terms });
    }
    if (!changes.length) { setError('No hay cambios para guardar.'); return; }
    if (!reason.trim()) { setError('Indica el motivo del ajuste.'); return; }
    setBusy(true);
    try {
      const result = await saveDeliveredOrderCommissionEditor({ orderId, lastModifiedAt: editor.lastModifiedAt, reason, changes });
      if (!result.ok) { setError(result.error); return; }
      setMessage(result.message); dialog.current?.close(); router.refresh();
    } catch { setError('No se pudo confirmar el guardado. Recarga para comprobarlo antes de volver a intentar.'); }
    finally { setBusy(false); }
  }

  const effective = editor?.items.map((item) => {
    const draft = drafts[item.id];
    return draft?.mode === 'inherit' ? item.inherited : { mode: draft?.mode, value: draft?.value };
  }) ?? [];
  const hasWholeOrderRate = effective.some((terms) => terms.mode === 'fixed_order');

  return (
    <>
      <button type="button" disabled={busy} onClick={open} className="rounded-xl border border-[#FEEF00]/40 px-3 py-1.5 text-xs font-semibold text-[#FEEF00] disabled:opacity-50">Ajustar comisiones</button>
      {message ? <p role="status" className="w-full text-xs text-emerald-300">{message}</p> : null}
      <dialog ref={dialog} aria-labelledby={`commission-title-${orderId}`} onCancel={(event) => { if (busy) event.preventDefault(); }} className="m-auto max-h-[90dvh] w-[min(94vw,640px)] overflow-y-auto rounded-2xl border border-[#30303B] bg-[#121218] p-4 text-[#F5F5F7] backdrop:bg-black/70">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`commission-title-${orderId}`} className="font-semibold">Comisiones · Pedido {formatOrderDisplayNumber(orderId)}</h2>
          <button type="button" disabled={busy} aria-label="Cerrar ajuste de comisiones" onClick={() => dialog.current?.close()} className="rounded-lg border border-[#30303B] px-3 py-1 disabled:opacity-50">Cerrar</button>
        </div>
        <p className="my-3 text-xs text-[#B7B7C2]">Solo cambia la comisión de este pedido. No modifica precios, pagos ni inventario. El cambio queda registrado con su motivo.</p>
        {busy && !editor ? <p role="status">Consultando comisiones…</p> : null}
        {editor?.protectedReason ? <p className="mb-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">{editor.protectedReason}</p> : null}
        {hasWholeOrderRate ? <p className="mb-3 text-xs text-amber-200">Hay una comisión sobre toda la orden: ese porcentaje prevalece sobre los porcentajes por producto mientras esté activo.</p> : null}
        {editor ? <fieldset disabled={busy || Boolean(editor.protectedReason)} className="space-y-3 disabled:opacity-70">
          {editor.items.map((item) => {
            const draft = drafts[item.id];
            const fixed = draft?.mode === 'fixed_item' || draft?.mode === 'fixed_order';
            return <div key={item.id} className="rounded-xl border border-[#30303B] p-3">
              <p className="text-sm font-semibold">{item.name}</p>
              <p className="mt-1 text-xs text-[#B7B7C2]">Actual: {formatOrderCommissionTerms(item.effective)}</p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 text-xs">Tipo de comisión
                  <select value={draft?.mode ?? 'inherit'} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...current[item.id], mode: event.target.value } }))} className="mt-1 block w-full rounded-lg border border-[#30303B] bg-[#0B0B0D] p-2 text-sm">
                    <option value="inherit">Heredada: {formatOrderCommissionTerms(item.inherited)}</option>
                    <option value="default">General del asesor</option>
                    <option value="fixed_item">Porcentaje fijo del producto</option>
                    <option value="fixed_order">Porcentaje sobre toda la orden</option>
                    <option value="none">Sin comisión</option>
                  </select>
                </label>
                {fixed ? <label className="w-24 text-xs">Porcentaje (%)
                  <input inputMode="decimal" value={draft.value} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...current[item.id], value: event.target.value } }))} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#0B0B0D] p-2 text-sm" />
                </label> : null}
              </div>
            </div>;
          })}
          <label className="block text-xs">Motivo del ajuste (obligatorio)
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#0B0B0D] p-2 text-sm" />
          </label>
          <button type="button" onClick={save} disabled={busy || !editor.items.length} className="w-full rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50">{busy ? 'Guardando y actualizando…' : 'Guardar comisiones'}</button>
        </fieldset> : null}
        {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error}</p> : null}
      </dialog>
    </>
  );
}
