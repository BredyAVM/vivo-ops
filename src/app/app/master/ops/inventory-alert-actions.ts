"use server";

import { getAuthContext, isMasterOrAdminRole } from "@/lib/auth";

export type MasterOpsInventoryAlertSummary = {
  active: number;
  open: number;
  managed: number;
  critical: number;
  requiresAction: number;
};

type InventoryAlertSummaryRpc = {
  summary?: {
    active?: number | string | null;
    open?: number | string | null;
    managed?: number | string | null;
    critical?: number | string | null;
    requires_action?: number | string | null;
  } | null;
};

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export async function loadMasterOpsInventoryAlertSummaryAction(): Promise<
  | { ok: true; summary: MasterOpsInventoryAlertSummary }
  | { ok: false; message: string }
> {
  const ctx = await getAuthContext();
  if (!ctx || !isMasterOrAdminRole(ctx.roles)) {
    return { ok: false, message: "No autorizado para consultar alertas de inventario." };
  }

  const { data, error } = await ctx.supabase.rpc("inventory_alert_summary_v1", {
    p_surface: "inventory_center",
  });

  if (error) {
    return { ok: false, message: "No se pudo actualizar el contador de inventario." };
  }

  const result = (data ?? {}) as InventoryAlertSummaryRpc;
  return {
    ok: true,
    summary: {
      active: count(result.summary?.active),
      open: count(result.summary?.open),
      managed: count(result.summary?.managed),
      critical: count(result.summary?.critical),
      requiresAction: count(result.summary?.requires_action),
    },
  };
}
