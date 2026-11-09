'use client';

import { useState } from 'react';

export default function GoalActionFeedback({ notice, error, periodName }: {
  notice?: string; error?: string; periodName?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const message = error || notice;
  if (!message || dismissed) return null;

  return <aside role={error ? 'alert' : 'status'} aria-atomic="true"
    className={`fixed inset-x-4 bottom-24 z-50 rounded-2xl border p-4 shadow-2xl md:inset-x-auto md:bottom-6 md:right-6 md:w-[420px] ${error
      ? 'border-red-400/50 bg-[#32171D] text-red-100'
      : 'border-emerald-400/50 bg-[#102B23] text-emerald-100'}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{error ? 'No se pudo completar la operación' : 'Operación completada'}</p>
        {periodName ? <p className="mt-1 text-xs opacity-80">{periodName}</p> : null}
        <p className="mt-2 text-sm leading-5">{message}</p>
        {error ? <p className="mt-2 text-xs leading-5 opacity-80">Revisa el estado actual antes de volver a intentarlo.</p> : null}
      </div>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Cerrar aviso"
        className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-current/25 text-lg hover:bg-white/10">×</button>
    </div>
  </aside>;
}
