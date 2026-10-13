'use client';
import { useState, useTransition } from 'react';
import { issueRewardDraftAction, revokeRewardGrantAction } from './actions';

export default function RewardIssueControls({ id, version, mode }: { id: number; version?: number; mode: 'issue' | 'revoke' }) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  return <details className="rounded-lg border border-[#303040] p-3">
    <summary className="cursor-pointer text-xs font-medium">{mode === 'issue' ? 'Emitir en el monedero' : 'Revocar premio'}</summary>
    <form className="mt-3 space-y-3" onSubmit={event => {
      event.preventDefault();
      if (!acknowledged) { setMessage('Confirma que revisaste las condiciones.'); return; }
      startTransition(async () => {
        const result = mode === 'issue' ? await issueRewardDraftAction(id, version!, reason) : await revokeRewardGrantAction(id, reason);
        setMessage(result.message);
      });
    }}>
      <p className="text-xs leading-5 text-amber-100">{mode === 'issue'
        ? 'Se otorgará el premio y se congelarán sus condiciones. No confirma un ganador calculado ni permite gastar todavía en pedidos.'
        : 'Se retirará la vigencia del premio sin borrar sus movimientos. Este mismo diseño no podrá emitirse otra vez.'}</p>
      <fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
        <label className="block text-xs">Motivo · visible para el asesor<textarea required minLength={10} maxLength={500} rows={2} value={reason} onChange={e => setReason(e.target.value)} className="mt-1 w-full rounded-lg border border-[#303040] bg-[#0B0B10] p-2 text-sm" /></label>
        <label className="flex min-h-10 items-center gap-2 text-xs"><input required type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />Revisé el asesor, el premio y sus condiciones.</label>
        <button className="min-h-10 rounded-lg border border-yellow-300/30 px-3 text-xs text-yellow-200">{pending ? 'Procesando…' : mode === 'issue' ? 'Confirmar emisión' : 'Confirmar revocación'}</button>
      </fieldset>
      {message ? <p role="status" aria-live="polite" className="text-xs text-amber-200">{message}</p> : null}
    </form>
  </details>;
}
