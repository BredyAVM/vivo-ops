'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { voidDeliveryPayment } from '../../actions';
import { adminInput } from '../../../../_components/AdminReadUi';
export default function VoidDeliveryPayment({ id, linkedExisting }: { id: string; linkedExisting: boolean }) {
  const [message, setMessage] = useState(''), [pending, startTransition] = useTransition();
  const busy = useRef(false); const router = useRouter();
  function submit(form: FormData) {
    if (busy.current) return; busy.current = true;
    startTransition(async () => {
      try { const r = await voidDeliveryPayment(id, String(form.get('reason'))); setMessage(r.message); if (r.ok) router.refresh(); }
      catch { setMessage('No se pudo verificar la respuesta. Actualiza o reintenta la misma anulación.'); }
      finally { busy.current = false; }
    });
  }
  return <details className="mt-5 text-sm"><summary className="cursor-pointer text-orange-200">Corregir un registro equivocado</summary>
    <form action={submit} className="mt-3 space-y-3"><fieldset disabled={pending} className="space-y-3">
      <p className="text-xs">{linkedExisting ? 'Se quitará el vínculo con las entregas. El egreso anterior se conserva.' : 'Se anulará el egreso completo y se liberarán las entregas para corregir o registrar otro pago. No devuelve dinero del banco.'} El historial permanece disponible.</p>
      <label className="grid gap-1 text-xs">Motivo<input name="reason" minLength={6} maxLength={500} required className={adminInput} /></label>
      <label className="flex min-h-11 items-center gap-3 text-xs"><input type="checkbox" required />Confirmo la anulación completa de este registro.</label>
      <button className={adminInput}>{pending ? 'Anulando…' : linkedExisting ? 'Anular vínculo' : 'Anular registro y egreso'}</button>
    </fieldset></form>{message ? <p role="status" className="mt-3">{message}</p> : null}
  </details>;
}
