import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '../display';
import InventoryAdminPilotClient, {
  type InventoryAdminPilotItem,
  type InventoryAdminPilotMovement,
} from './InventoryAdminPilotClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ReportingWorkspace = {
  items?: Array<{
    id: number | string;
    name: string;
    unit_name: string;
    inventory_group: string;
    initialized: boolean;
    stock_units: number | string | null;
  }>;
};

type MovementRow = {
  id: number | string;
  inventory_item_id: number | string;
  movement_type: 'manual_adjustment' | 'stock_count';
  quantity_units: number | string;
  reason_code: string | null;
  notes: string | null;
  operation_id: string;
  created_at: string;
};

export default async function InventoryAdjustmentsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin')) redirect('/app/inventory');

  const [workspaceResult, movementsResult] = await Promise.all([
    ctx.supabase.rpc('inventory_reporting_workspace_v1', { p_horizon_days: 10 }),
    ctx.supabase
      .from('inventory_movements')
      .select('id,inventory_item_id,movement_type,quantity_units,reason_code,notes,operation_id,created_at')
      .in('movement_type', ['manual_adjustment', 'stock_count'])
      .order('created_at', { ascending: false })
      .limit(40),
  ]);

  const firstError = workspaceResult.error ?? movementsResult.error;
  if (firstError) {
    throw new Error(`No se pudo cargar el piloto administrativo: ${firstError.message}`);
  }

  const workspace = repairInventoryDisplayData(
    (workspaceResult.data ?? { items: [] }) as ReportingWorkspace,
  );
  const items: InventoryAdminPilotItem[] = (workspace.items ?? [])
    .filter((item) => item.initialized)
    .map((item) => ({
      id: Number(item.id),
      name: item.name,
      unitName: item.unit_name,
      inventoryGroup: item.inventory_group,
      currentStockUnits: Number(item.stock_units ?? 0),
    }));
  const itemNameById = new Map(items.map((item) => [item.id, item.name]));
  const itemUnitById = new Map(items.map((item) => [item.id, item.unitName]));
  const movements: InventoryAdminPilotMovement[] = ((movementsResult.data ?? []) as MovementRow[])
    .map((movement) => ({
      id: Number(movement.id),
      inventoryItemId: Number(movement.inventory_item_id),
      inventoryItemName: itemNameById.get(Number(movement.inventory_item_id)) ?? `Ítem #${movement.inventory_item_id}`,
      unitName: itemUnitById.get(Number(movement.inventory_item_id)) ?? 'UND',
      movementType: movement.movement_type,
      quantityUnits: Number(movement.quantity_units),
      reasonCode: movement.reason_code,
      notes: movement.notes,
      operationId: movement.operation_id,
      createdAt: movement.created_at,
    }));

  return <InventoryAdminPilotClient items={items} movements={movements} />;
}
