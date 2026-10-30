import { getAuthContext } from '@/lib/auth';
import { repairInventoryDisplayData } from '@/app/app/inventory/display';
import KitchenInventoryLossClient, {
  type KitchenLossItem,
  type KitchenLossMovement,
} from './KitchenInventoryLossClient';

type LossWorkspace = {
  items?: Array<{
    id: number;
    name: string;
    unit_name: string;
    inventory_group: string;
    initialized: boolean;
  }>;
};

type MovementRow = {
  id: number;
  inventory_item_id: number;
  movement_type: 'damage' | 'waste' | 'quality_taste';
  quantity_units: number | string;
  notes: string | null;
  created_at: string;
  inventory_items:
    | { name: string; unit_name: string }
    | Array<{ name: string; unit_name: string }>
    | null;
};

function relatedItem(value: MovementRow['inventory_items']) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function KitchenInventoryLossesPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [workspaceResult, movementsResult] = await Promise.all([
    ctx.supabase.rpc('inventory_receipt_workspace_v1'),
    ctx.supabase
      .from('inventory_movements')
      .select(`
        id,
        inventory_item_id,
        movement_type,
        quantity_units,
        notes,
        created_at,
        inventory_items!inventory_movements_inventory_item_id_fkey(name,unit_name)
      `)
      .in('movement_type', ['damage', 'waste', 'quality_taste'])
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  const firstError = workspaceResult.error ?? movementsResult.error;
  if (firstError) throw new Error(`No se pudieron cargar las salidas de calidad: ${firstError.message}`);

  const workspace = repairInventoryDisplayData((workspaceResult.data ?? {}) as LossWorkspace);
  const items: KitchenLossItem[] = (workspace.items ?? [])
    .filter((item) => item.initialized)
    .map((item) => ({
      id: Number(item.id),
      name: item.name,
      unitName: item.unit_name,
      inventoryGroup: item.inventory_group,
    }));

  const movements: KitchenLossMovement[] = ((movementsResult.data ?? []) as unknown as MovementRow[]).map((movement) => {
    const item = relatedItem(movement.inventory_items);
    return {
      id: Number(movement.id),
      inventoryItemId: Number(movement.inventory_item_id),
      itemName: item?.name ?? `Ítem #${movement.inventory_item_id}`,
      unitName: item?.unit_name ?? 'unidad',
      lossKind: movement.movement_type,
      quantityUnits: Math.abs(Number(movement.quantity_units)),
      notes: movement.notes,
      createdAt: movement.created_at,
    };
  });

  return <KitchenInventoryLossClient items={items} movements={movements} />;
}
