import 'server-only';
import { Suspense } from 'react';
import type { AuthContext } from '@/lib/auth';
import OrdersWorkspaceInventoryLinks from '@/components/orders/OrdersWorkspaceInventoryLinks';
import { readWorkspaceInventorySummary, type MasterOpsInventoryAlertSummary } from './workspace-inventory-summary';

async function ResolvedInventoryLinks({ summary }: { summary: Promise<MasterOpsInventoryAlertSummary | null> }) {
  return <OrdersWorkspaceInventoryLinks summary={await summary} />;
}

export function createWorkspaceInventoryNavigation(ctx: AuthContext) {
  // Stream optional counters in the same response without holding up orders.
  const summary = readWorkspaceInventorySummary(ctx, AbortSignal.timeout(2_000))
    .then(result => result.ok ? result.summary : null).catch(() => null);
  return <Suspense fallback={<OrdersWorkspaceInventoryLinks summary={null} />}>
    <ResolvedInventoryLinks summary={summary} />
  </Suspense>;
}
