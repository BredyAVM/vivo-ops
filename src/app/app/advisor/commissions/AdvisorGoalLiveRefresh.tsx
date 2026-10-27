'use client';

import { useCallback, useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useCoalescedRefresh } from '@/lib/refresh/use-coalesced-refresh';

const AUTO_REFRESH_MS = 5 * 60_000;
const RESUME_REFRESH_MS = 2 * 60_000;

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
  const lastRefreshAtRef = useRef(0);
  const runRefresh = useCallback(() => {
    lastRefreshAtRef.current = Date.now();
    startRefresh(() => router.refresh());
  }, [router]);
  const scheduleRefresh = useCoalescedRefresh(runRefresh, isRefreshing);
  const refresh = useCallback(() => scheduleRefresh({ immediate: true }), [scheduleRefresh]);

  useEffect(() => {
    lastRefreshAtRef.current = Date.now();
  }, [observedAt]);

  useEffect(() => {
    const refreshIfStale = (minAgeMs: number) => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (Date.now() - lastRefreshAtRef.current < minAgeMs) return;
      scheduleRefresh({ immediate: true, queueIfBusy: false });
    };
    const resume = () => refreshIfStale(RESUME_REFRESH_MS);
    const intervalId = window.setInterval(() => refreshIfStale(AUTO_REFRESH_MS), 30_000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
    };
  }, [scheduleRefresh]);

  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-sky-400/20 bg-sky-400/5 px-3 py-2 text-[11px] text-sky-100">
      <span>Última actualización · {updatedLabel(observedAt)}</span>
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
