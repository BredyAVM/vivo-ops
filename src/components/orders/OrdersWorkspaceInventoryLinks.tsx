'use client';

import { useState } from 'react';
import ContextLink from '@/components/navigation/ContextLink';
import type { MasterOpsInventoryAlertSummary } from '@/lib/orders/workspace-inventory-summary';
import { ordersWorkspaceNavigation, type OrdersWorkspaceSurface } from '@/lib/orders/workspace-navigation';

export default function OrdersWorkspaceInventoryLinks({ summary, surface = 'master' }: {
  summary: MasterOpsInventoryAlertSummary | null; surface?: OrdersWorkspaceSurface;
}) {
  const [lastSummary, setLastSummary] = useState(summary);
  // Retain the last successful counter when the optional inventory read fails.
  if (summary && summary !== lastSummary) setLastSummary(summary);
  const current = summary ?? lastSummary;
  return <>
    <ContextLink href={ordersWorkspaceNavigation(surface).inventory} prefetch={false}
      className="flex shrink-0 items-center gap-1.5 rounded-2xl border border-[#FEEF00]/45 bg-[#17170F] px-3 py-2 text-xs font-semibold text-[#FEEF00] transition hover:border-[#FEEF00]"
      title={current ? `Abrir inventario · ${current.active} alertas activas · ${current.critical} críticas`
        : 'Abrir el control operativo de inventario de Máster'}>
      <span>Inventario</span>
      {current && current.active > 0 ? <span
        className={current.critical > 0 ? 'rounded-full bg-red-400/20 px-1.5 py-0.5 text-[10px] tabular-nums text-red-200'
          : 'rounded-full bg-amber-300/20 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-100'}
        aria-label={`${current.active} alertas activas de inventario`}>{current.active}</span> : null}
    </ContextLink>
    {current && current.pendingReviews > 0 ? <ContextLink
      href={current.pendingReviews === 1 && current.nextPendingReviewId
        ? `/app/inventory/counts/${current.nextPendingReviewId}`
        : surface === 'admin' ? '/app/admin/inventario/counts' : '/app/master/ops/inventory?view=counts#inventory-reviews'}
      prefetch={false}
      className="flex shrink-0 items-center gap-2 rounded-2xl border border-rose-300/55 bg-rose-400/10 px-3 py-2 text-xs font-black text-rose-100 transition hover:border-rose-200 hover:bg-rose-400/15"
      title={`${current.pendingReviews} inventario${current.pendingReviews === 1 ? '' : 's'} de Cocina por revisar`}>
      <span>Inventarios por aprobar</span>
      <span className="rounded-full bg-rose-200 px-2 py-0.5 text-[10px] tabular-nums text-rose-950">{current.pendingReviews}</span>
    </ContextLink> : null}
  </>;
}
