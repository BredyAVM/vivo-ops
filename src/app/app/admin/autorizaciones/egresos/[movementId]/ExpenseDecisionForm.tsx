'use client';
import { useRef, useState, type FormEvent } from 'react';
import { decideAdminExpenseAction } from './actions';
import type { ExpenseDecisionResult } from '@/lib/admin-finance/authorizations-model';

export default function ExpenseDecisionForm({ movementId, snapshot }: { movementId: number; snapshot: string }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ExpenseDecisionResult | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || (result && result.status !== 'error')) return;
    busy.current = true; setPending(true); setResult(null);
    try { setResult(await decideAdminExpenseAction({ movementId, snapshot, decision, reason })); }
    catch { setResult({ status: 'uncertain', message: 'No se pudo confirmar el resultado. Actualiza la revisión antes de decidir de nuevo.' }); }
    finally { busy.current = false; setPending(false); }
  }
  if (result && result.status !== 'error') return <section aria-live="polite" className="space-y-3">
    <p role="status" className="text-sm">{result.status === 'decided' ? `${result.decision === 'approve' ? 'Egreso aprobado' : 'Egreso rechazado'}. Registro${result.movementIds.length > 1 ? 's' : ''}: ${result.movementIds.join(', ')}.` : result.message}</p>
    {/* Full navigation deliberately discards the old review token and form state. */}
    <a href={`/app/admin/autorizaciones/egresos/${movementId}`} className="inline-flex min-h-11 items-center rounded-lg border border-[#444450] px-4 text-sm underline">Actualizar revisión y estado</a>
  </section>;
  return <form onSubmit={submit} className="space-y-3">
    <fieldset disabled={pending} className="space-y-3 disabled:opacity-60"><legend className="mb-2 text-sm font-semibold">Decisión sobre el egreso y su comisión</legend>
      <div className="flex flex-wrap gap-4">{([['approve', 'Aprobar'], ['reject', 'Rechazar']] as const).map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="decision" value={value} checked={decision === value} onChange={() => setDecision(value)} />{label}</label>)}</div>
      {decision === 'reject' ? <label className="block text-sm">Motivo del rechazo<textarea value={reason} onChange={e => setReason(e.target.value)} required maxLength={800} rows={3} className="mt-2 block w-full rounded-lg border border-[#30303D] bg-[#14141C] p-3" /></label> : null}
      <button disabled={pending} className="min-h-11 rounded-lg bg-[#FEEF00] px-4 text-sm font-semibold text-black">{pending ? 'Guardando…' : decision === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo'}</button>
    </fieldset>
    {result?.status === 'error' ? <p role="alert" className="text-sm text-orange-200">{result.message}</p> : null}
  </form>;
}
