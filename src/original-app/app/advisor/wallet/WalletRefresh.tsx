'use client';
import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function WalletRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') router.refresh(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [router]);
  return <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}
    className="min-h-10 rounded-lg border border-[#303040] px-3 text-xs disabled:opacity-50">
    {pending ? 'Actualizando…' : 'Actualizar monedero'}
  </button>;
}
