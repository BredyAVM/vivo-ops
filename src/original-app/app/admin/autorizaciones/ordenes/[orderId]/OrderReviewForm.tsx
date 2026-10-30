'use client';
import { useRef, useState, type FormEvent } from 'react';
import { queryAction, queryControl, queryPrimary } from '@/components/ui/QueryControls';
import type { OrderReviewAction, OrderReviewResult } from '@/lib/admin-finance/order-review-model';
import { approveAdminOrderAction } from './actions';
export default function OrderReviewForm({ orderId, snapshot, action }: { orderId: number; snapshot: string; action: OrderReviewAction }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false), [notes, setNotes] = useState('');
  const [result, setResult] = useState<OrderReviewResult | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy.current || (result && result.status !== 'error')) return;
    busy.current = true; setPending(true); setResult(null);
    try { setResult(await approveAdminOrderAction({ orderId, snapshot, action, notes })); }
    catch { setResult({ status: 'uncertain', message: 'No se confirmó el resultado. Actualiza la revisión antes de decidir de nuevo.' }); }
    finally { busy.current = false; setPending(false); }
  }
  if (result && result.status !== 'error') return <div aria-live="polite" className="space-y-3">
    <p role="status" className="text-xs">{result.status === 'approved' ? `Orden #${result.orderId} ${action === 'approve' ? 'aprobada' : 'ratificada'} · Evento #${result.eventId}` : result.message}</p>
    <a href={`/app/admin/autorizaciones/ordenes/${orderId}`} className={queryAction}>Actualizar revisión</a>
  </div>;
  return <form onSubmit={submit} className="space-y-3"><fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
    <details><summary className="min-h-11 cursor-pointer content-center text-xs md:min-h-8">Nota de revisión (opcional)</summary><label className="block text-[11px] text-[#B7B7C2]">Nota<textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={800} rows={2} className={`${queryControl} mt-1 block p-2`} /></label></details>
    <button className={queryPrimary}>{pending ? 'Guardando…' : action === 'approve' ? 'Aprobar esta orden' : 'Ratificar estos datos'}</button>
  </fieldset>{result?.status === 'error' ? <p role="alert" className="text-xs text-orange-200">{result.message}</p> : null}</form>;
}
