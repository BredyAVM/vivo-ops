'use client';

import { useState, useTransition } from 'react';
import { NO_APPLY_REASONS, type NoApplyRequest } from '@/lib/crm/no-apply';
import { reviewPlayNoApplyAction } from './actions';

export type NoApplyReviewRow = NoApplyRequest & { clientName: string; advisorName: string };

function ReviewRow({ request, isAdmin }: { request: NoApplyReviewRow; isAdmin: boolean }) {
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const decide = (approve: boolean) => startTransition(async () => {
    const result = await reviewPlayNoApplyAction(Number(request.id), approve, note);
    setMessage(result.message);
  });
  return <div className="space-y-2 border-t border-[#30303B] py-3 text-xs">
    <p className="font-semibold text-white">{request.clientName} <span className="font-normal text-[#A3ACBD]">· {request.advisorName}</span></p>
    <p className="text-[#C7CBD5]">{NO_APPLY_REASONS[request.reason_code]} · {request.justification}</p>
    {request.status === 'pending' ? isAdmin ? <div className="flex flex-wrap gap-2">
      <label className="w-full text-[#A3ACBD]">Justificación de la decisión
        <textarea aria-label={`Decisión para ${request.clientName}`} minLength={10} maxLength={500} value={note} onChange={event => setNote(event.target.value)} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#111118] p-2" rows={2} />
      </label>
      <button type="button" disabled={pending || note.trim().length < 10} onClick={() => decide(true)} className="rounded-lg border border-emerald-400/30 px-3 py-2 text-emerald-200 disabled:opacity-40">Aprobar exclusión</button>
      <button type="button" disabled={pending || note.trim().length < 10} onClick={() => decide(false)} className="rounded-lg border border-red-400/30 px-3 py-2 text-red-200 disabled:opacity-40">Rechazar</button>
    </div> : <p className="text-amber-100">Pendiente de aprobación del administrador.</p>
      : <p className="text-[#A3ACBD]">{request.status === 'approved' ? 'Aprobado' : 'Rechazado'} · {request.review_note}</p>}
    {message ? <p role="status" className="text-amber-100">{message}</p> : null}
  </div>;
}

export default function NoApplyRequestsPanel({ requests, isAdmin }: { requests: NoApplyReviewRow[]; isAdmin: boolean }) {
  const waiting = requests.filter(request => request.status === 'pending');
  return <details className="rounded-2xl border border-[#30303B] bg-[#121218] px-4 py-3" open={waiting.length > 0}>
    <summary className="cursor-pointer text-xs font-semibold text-white">No aplica · {waiting.length} pendientes</summary>
    <p className="my-2 text-xs text-[#9199AB]">Las solicitudes pendientes siguen contando. Solo el administrador puede aprobar; se conserva el historial y no se excluyen beneficios en pedidos o entregados.</p>
    {requests.length === 0 ? <p className="text-xs text-[#9199AB]">Sin solicitudes.</p> : requests.map(request => <ReviewRow key={`${request.id}-${request.status}`} request={request} isAdmin={isAdmin} />)}
  </details>;
}
