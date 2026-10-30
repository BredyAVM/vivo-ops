'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import BackLink from '@/components/navigation/BackLink';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';

export default function AdminContextBack() {
  const pathname = usePathname();
  const parent = safeAppReturnHref(useSearchParams().get('returnTo'));
  // These screens have their own compact header/back control.
  if (!parent || pathname === '/app/admin' || pathname === '/app/admin/ordenes'
    || pathname.startsWith('/app/admin/finanzas/cuentas')) return null;
  return <div className="mb-2"><BackLink /></div>;
}
