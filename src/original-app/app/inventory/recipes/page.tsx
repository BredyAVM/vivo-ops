import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '../display';
import InventoryProductionWorkspaceClient, {
  type InventoryProductionWorkspace,
} from './InventoryProductionWorkspaceClient';

const EMPTY_WORKSPACE: InventoryProductionWorkspace = {
  permissions: {
    can_activate: false,
    can_start: false,
    can_complete: false,
    can_fail: false,
    can_cancel: false,
  },
  recipes: [],
  active_batches: [],
  recent_batches: [],
  recent_lots: [],
  summary: {
    canonical_recipes: 0,
    active_recipes: 0,
    cooling_batches: 0,
    ready_batches: 0,
    yield_variances: 0,
  },
};

export default async function InventoryRecipesPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const { data, error } = await ctx.supabase.rpc('inventory_production_workspace_v1');
  if (error) {
    throw new Error(`No se pudo cargar el centro de producción: ${error.message}`);
  }

  const workspace = repairInventoryDisplayData(
    (data ?? EMPTY_WORKSPACE) as InventoryProductionWorkspace,
  );

  return <InventoryProductionWorkspaceClient workspace={workspace} />;
}
