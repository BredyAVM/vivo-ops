'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { queryAction } from '@/components/ui/QueryControls';

export default function CollectionRefresh({ asOf }: { asOf?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
    {asOf && <time dateTime={asOf}>Consulta: {new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(asOf))}</time>}
    <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}
      className={queryAction}>
      {pending ? 'Consultando…' : 'Consultar de nuevo'}
    </button>
  </div>;
}
