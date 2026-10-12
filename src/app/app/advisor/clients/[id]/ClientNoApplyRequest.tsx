'use client';

import { useState, useTransition } from 'react';
import { NO_APPLY_REASONS, type NoApplyReason, type NoApplyRequest } from '@/lib/crm/no-apply';
import { requestClientPlayNoApplyAction } from './actions';

export default function ClientNoApplyRequest({ memberId, canRequest, removed, request }: {
  memberId: number; canRequest: boolean; removed: boolean; request: NoApplyRequest | null;
}) {
  const [reason, setReason] = useState<NoApplyReason>('criteria_mismatch');
  const [justification, setJustification] = useState('');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const waiting = request?.status === 'pending';
  return (
    <details className="rounded-xl border border-[#30303B] p-3 text-xs">
      <summary className="cursor-pointer font-semibold text-[#C7CBD5]">
        {waiting ? 'No aplica · en revisión' : request?.status === 'approved' && removed ? 'No aplica · aprobado' : 'No aplica / solicitar revisión'}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[#9199AB]">Solo una aprobación del administrador excluye al cliente de los porcentajes. No responder, no comprar o rechazar el obsequio no lo excluye automáticamente.</p>
        {request ? <div className="space-y-1 text-[#C7CBD5]">
          <p>{NO_APPLY_REASONS[request.reason_code]}: {request.justification}</p>
          <p>{request.status === 'pending' ? 'Pendiente: todavía cuenta en la lista evaluable.' : request.status === 'approved' ? removed ? 'Aprobado: excluido de la base evaluable; historial conservado.' : 'Aprobado anteriormente; el cliente fue reincorporado.' : 'Rechazado: el cliente sigue contando.'}</p>
          {request.review_note ? <p>Administrador: {request.review_note}</p> : null}
        </div> : null}
        {canRequest && !waiting ? <form onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await requestClientPlayNoApplyAction({ playMemberId: memberId, reasonCode: reason, justification });
            setMessage(result.message);
          });
        }} className="space-y-2">
          <label className="block">Motivo
            <select value={reason} onChange={event => setReason(event.target.value as NoApplyReason)} className="mt-1 w-full rounded-lg border border-[#30303B] bg-[#111118] p-2">
              {Object.entries(NO_APPLY_REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block">Justificación obligatoria
            <textarea required minLength={10} maxLength={1000} value={justification} onChange={event => setJustification(event.target.value)} placeholder="Explica qué ocurrió y por qué corresponde excluirlo." className="mt-1 min-h-20 w-full rounded-lg border border-[#30303B] bg-[#111118] p-2" />
          </label>
          <button disabled={pending || justification.trim().length < 10} className="rounded-lg border border-[#454552] px-3 py-2 font-semibold disabled:opacity-40">{pending ? 'Enviando…' : 'Solicitar No aplica'}</button>
        </form> : null}
        {message ? <p role="status" className="text-amber-100">{message}</p> : null}
      </div>
    </details>
  );
}
