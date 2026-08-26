'use client';

import { useCallback, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';

function updatedLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Actualización reciente';
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  }).format(parsed);
}

export function AdvisorGoalLiveRefresh({ observedAt }: { observedAt: string }) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const refresh = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 120_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-sky-400/20 bg-sky-400/5 px-3 py-2 text-[11px] text-sky-100">
      <span>Datos vigentes · {updatedLabel(observedAt)}</span>
      <button
        className="shrink-0 rounded-lg border border-sky-300/30 px-2.5 py-1 font-semibold disabled:cursor-wait disabled:opacity-60"
        disabled={isRefreshing}
        onClick={refresh}
        type="button"
      >
        {isRefreshing ? 'Actualizando…' : 'Actualizar'}
      </button>
    </div>
  );
}
