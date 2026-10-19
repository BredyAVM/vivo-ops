'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function CollectionRefresh({ checkedAt, error, warning }: { checkedAt?: string; error?: string | null; warning?: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') startTransition(() => router.refresh());
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [router]);
  const label = checkedAt ? new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(checkedAt)) : 'Sin verificar';
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
    <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}
      className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-3 py-2 font-semibold text-sky-100 disabled:opacity-50">
      {pending ? 'Consultando cobranza…' : '↻ Actualizar cobranza'}
    </button>
    <span role="status" aria-live="polite" className={error || warning ? 'text-amber-200' : 'text-[#A6A6B0]'}>
      {error ? 'Cobranza no verificada. No se habilitan pagos.' : `${warning ? `${warning} ` : ''}Consultada ${label} · actualiza cada 30 s mientras esta vista está visible`}
    </span>
  </div>;
}
