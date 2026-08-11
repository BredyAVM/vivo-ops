import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from './display';
import InventoryGeneralOverviewClient from './InventoryGeneralOverviewClient';
import type { InventoryReportingWorkspace } from './reports/InventoryReportsClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EMPTY_WORKSPACE: InventoryReportingWorkspace = {
  generated_at: '',
  horizon_days: 10,
  horizon_ends_at: '',
  cutover_mode: 'legacy',
  summary: {
    tracked_items: 0,
    initialized_items: 0,
    pending_opening_items: 0,
    active_commitment_flows: 0,
    incoming_flows: 0,
    active_alerts: 0,
    canonical_movements: 0,
    count_sessions: 0,
  },
  items: [],
  projection_events: [],
  recent_counts: [],
};

export default async function InventoryPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data, error } = await ctx.supabase.rpc('inventory_reporting_workspace_v1', {
    p_horizon_days: 10,
  });
  if (error) {
    throw new Error(`No se pudo cargar el resumen de inventario: ${error.message}`);
  }

  const workspace = repairInventoryDisplayData(
    (data ?? EMPTY_WORKSPACE) as InventoryReportingWorkspace,
  );

  return (
    <InventoryGeneralOverviewClient
      workspace={workspace}
      canConfigure={ctx.roles.includes('admin')}
    />
  );
}
