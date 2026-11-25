'use client';
import { useCallback, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useCoalescedRefresh } from '@/lib/refresh/use-coalesced-refresh';

export default function WalletRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const runRefresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const requestRefresh = useCoalescedRefresh(runRefresh, pending);
  useEffect(() => {
    const refresh = () => requestRefresh({ immediate: true, queueIfBusy: false });
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [requestRefresh]);
  return <button type="button" disabled={pending} onClick={() => requestRefresh({ immediate: true })}
    className="min-h-10 rounded-lg border border-[#303040] px-3 text-xs disabled:opacity-50">
    {pending ? 'Actualizando…' : 'Actualizar monedero'}
  </button>;
}
