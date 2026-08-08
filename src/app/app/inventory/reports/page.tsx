import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '../display';
import InventoryReportsClient, {
  type InventoryKardexPage,
  type InventoryReportingWorkspace,
} from './InventoryReportsClient';

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

const EMPTY_KARDEX: InventoryKardexPage = {
  items: [],
  next_cursor: null,
};

export default async function InventoryReportsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [workspaceResult, kardexResult] = await Promise.all([
    ctx.supabase.rpc('inventory_reporting_workspace_v1', { p_horizon_days: 10 }),
    ctx.supabase.rpc('inventory_kardex_page_v1', {
      p_inventory_item_id: null,
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 100,
    }),
  ]);

  const firstError = workspaceResult.error ?? kardexResult.error;
  if (firstError) {
    throw new Error(`No se pudieron cargar los reportes de inventario: ${firstError.message}`);
  }

  const workspace = repairInventoryDisplayData(
    (workspaceResult.data ?? EMPTY_WORKSPACE) as InventoryReportingWorkspace,
  );
  const initialKardex = repairInventoryDisplayData(
    (kardexResult.data ?? EMPTY_KARDEX) as InventoryKardexPage,
  );

  return <InventoryReportsClient workspace={workspace} initialKardex={initialKardex} />;
}
