import 'server-only';
import { isMasterOrAdminRole, type AuthContext } from '@/lib/auth';

export type MasterOpsInventoryAlertSummary = {
  active: number; open: number; managed: number; critical: number;
  requiresAction: number; pendingReviews: number; nextPendingReviewId: number | null;
};
type SummaryResult = { ok: true; summary: MasterOpsInventoryAlertSummary } | { ok: false; message: string };
type InventoryAlertSummaryRpc = { summary?: {
  active?: number | string | null; open?: number | string | null;
  managed?: number | string | null; critical?: number | string | null;
  requires_action?: number | string | null;
} | null };

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

/** Reuse this request's authorized context; never cache counters across users. */
export async function readWorkspaceInventorySummary(ctx: AuthContext | null, signal?: AbortSignal): Promise<SummaryResult> {
  if (!ctx || !isMasterOrAdminRole(ctx.roles)) {
    return { ok: false, message: 'No autorizado para consultar alertas de inventario.' };
  }
  const alerts = ctx.supabase.rpc('inventory_alert_summary_v1', { p_surface: 'master_inventory' });
  const reviews = ctx.supabase.from('inventory_counts').select('id', { count: 'exact' })
    .eq('status', 'submitted').order('submitted_at', { ascending: true, nullsFirst: false }).limit(1);
  const [alertResult, reviewResult] = await Promise.all([
    signal ? alerts.abortSignal(signal) : alerts,
    signal ? reviews.abortSignal(signal) : reviews,
  ]);
  if (alertResult.error && reviewResult.error) {
    return { ok: false, message: 'No se pudo actualizar el contador de inventario.' };
  }
  const result = (alertResult.data ?? {}) as InventoryAlertSummaryRpc;
  const nextId = Number(reviewResult.data?.[0]?.id ?? 0);
  return { ok: true, summary: {
    active: count(result.summary?.active), open: count(result.summary?.open),
    managed: count(result.summary?.managed), critical: count(result.summary?.critical),
    requiresAction: count(result.summary?.requires_action), pendingReviews: count(reviewResult.count),
    nextPendingReviewId: Number.isSafeInteger(nextId) && nextId > 0 ? nextId : null,
  } };
}
