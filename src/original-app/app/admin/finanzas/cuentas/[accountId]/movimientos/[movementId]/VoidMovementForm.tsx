'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { voidAccountMovementAction } from '@/lib/admin-finance/movement-detail-actions';

export default function VoidMovementForm({ accountId, movementId, fingerprint, movementCount }: {
  accountId: number; movementId: number; fingerprint: string; movementCount: number;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);

  if (done) return <p role="status" className="text-xs text-emerald-200">Operación anulada. Se conserva su historial.</p>;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-11 rounded-lg border border-red-400/30 px-3 text-xs text-red-200 sm:min-h-8">Anular movimiento</button>;
  return <form className="max-w-xl space-y-3 rounded-xl border border-red-400/25 bg-red-400/[0.03] p-3" onSubmit={async event => {
    event.preventDefault();
    if (inFlight.current || !confirmed || reason.trim().length < 6) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const result = await voidAccountMovementAction({ accountId, movementId, fingerprint, reason });
      if (!result.ok) { setMessage(result.message); return; }
      setDone(true); router.refresh();
    } catch { setMessage('No se pudo comprobar el resultado. Actualiza y revisa el estado antes de reintentar.'); }
    finally { inFlight.current = false; setBusy(false); }
  }}>
    <p className="text-xs text-[#BCBCC8]">Anula el registro en el sistema; no devuelve dinero del banco.{movementCount > 1 ? ` Incluye los ${movementCount} movimientos vinculados mostrados arriba, también comisiones o traspasos.` : ''}</p>
    <label className="block text-xs text-[#BCBCC8]">Motivo
      <textarea required minLength={6} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-[#343442] bg-[#0B0B0D] p-2 text-sm" />
    </label>
    <label className="flex min-h-11 items-center gap-2 text-xs text-[#BCBCC8]"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Revisé la operación completa y quiero anularla.</label>
    {message ? <p role="alert" className="text-xs text-red-200">{message}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button disabled={busy || !confirmed || reason.trim().length < 6} className="min-h-11 rounded-lg border border-red-400/30 px-3 text-xs text-red-200 disabled:opacity-40 sm:min-h-8">{busy ? 'Anulando…' : 'Confirmar anulación'}</button>
      <button type="button" disabled={busy} onClick={() => { setOpen(false); setMessage(''); setConfirmed(false); }} className="min-h-11 px-3 text-xs text-[#BCBCC8] sm:min-h-8">Volver sin anular</button>
    </div>
  </form>;
}
