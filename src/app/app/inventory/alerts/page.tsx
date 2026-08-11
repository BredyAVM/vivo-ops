import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '../display';
import InventoryAlertsClient, { type InventoryAlertWorkspace } from './InventoryAlertsClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EMPTY_WORKSPACE: InventoryAlertWorkspace = {
  surface: 'inventory_center',
  generated_at: '',
  refresh: {
    detected_or_updated: 0,
    automatically_resolved: 0,
    refreshed_at: '',
  },
  summary: {
    open: 0,
    managed: 0,
    resolved: 0,
    critical: 0,
    requires_action: 0,
  },
  alerts: [],
  configuration: {
    can_configure: false,
    policies: [],
    items: [],
  },
};

export default async function InventoryAlertsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const isAdmin = ctx.roles.includes('admin');
  const surface = isAdmin ? 'inventory_center' : 'master_inventory';

  const { data, error } = await ctx.supabase.rpc('inventory_alert_workspace_v1', {
    p_surface: surface,
    p_include_resolved: true,
  });

  if (error) {
    throw new Error(`No se pudo cargar el centro de alertas: ${error.message}`);
  }

  const workspace = repairInventoryDisplayData(
    (data ?? EMPTY_WORKSPACE) as InventoryAlertWorkspace,
  );

  return <InventoryAlertsClient workspace={workspace} canManage />;
}
