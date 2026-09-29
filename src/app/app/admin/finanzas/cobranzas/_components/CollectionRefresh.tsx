'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function CollectionRefresh({ asOf }: { asOf?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
    {asOf && <time dateTime={asOf}>Consulta: {new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(asOf))}</time>}
    <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}
      className="min-h-10 rounded-lg border border-zinc-700 px-3 text-zinc-200 disabled:opacity-50">
      {pending ? 'Consultando…' : 'Consultar de nuevo'}
    </button>
  </div>;
}
