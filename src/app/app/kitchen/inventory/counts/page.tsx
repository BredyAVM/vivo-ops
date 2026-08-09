import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from '@/app/app/inventory/display';
import KitchenInventoryCountClient, {
  type KitchenCountItem,
  type KitchenOpenCount,
  type KitchenRecentCount,
} from './KitchenInventoryCountClient';

type InventoryItemRow = {
  id: number;
  name: string;
  unit_name: string;
  inventory_group: string;
  primary_count_frequency: string | null;
  primary_count_role: string | null;
};

type ReceiptWorkspaceRow = {
  items?: Array<{ id: number; initialized: boolean }>;
  presentations?: Array<{
    id: number;
    inventory_item_id: number;
    name: string;
    base_units_per_presentation: number | string;
    allows_fractional_quantity: boolean;
  }>;
};

type CountHeaderRow = {
  id: number;
  count_kind: string;
  status: string;
  due_at: string | null;
  notes: string | null;
  created_at: string;
  submitted_at?: string | null;
  reviewed_at?: string | null;
};

type CountLineRow = {
  id: number;
  inventory_count_id: number;
  inventory_item_id: number;
  note: string | null;
};

export default async function KitchenInventoryCountsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [itemsResult, receiptResult, openCountsResult, recentCountsResult] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id,name,unit_name,inventory_group,primary_count_frequency,primary_count_role')
      .eq('is_active', true)
      .is('merged_into_item_id', null)
      .in('tracking_mode', ['transactional', 'periodic_count'])
      .order('inventory_group')
      .order('name'),
    ctx.supabase.rpc('inventory_receipt_workspace_v1'),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,due_at,notes,created_at')
      .eq('status', 'open')
      .eq('responsible_role', 'kitchen')
      .in('count_kind', ['requested', 'recount', 'periodic', 'shift_change'])
      .order('created_at', { ascending: true }),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,due_at,notes,created_at,submitted_at,reviewed_at')
      .eq('responsible_role', 'kitchen')
      .neq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(12),
  ]);

  const firstError = itemsResult.error ?? receiptResult.error ?? openCountsResult.error ?? recentCountsResult.error;
  if (firstError) throw new Error(`No se pudieron cargar los conteos de Cocina: ${firstError.message}`);

  const rawItems = (itemsResult.data ?? []) as InventoryItemRow[];
  const receiptWorkspace = (receiptResult.data ?? {}) as ReceiptWorkspaceRow;
  const initializedIds = new Set(
    (receiptWorkspace.items ?? []).filter((item) => item.initialized).map((item) => Number(item.id)),
  );
  const presentationsByItem = new Map<number, KitchenCountItem['presentations']>();
  for (const presentation of receiptWorkspace.presentations ?? []) {
    const itemPresentations = presentationsByItem.get(Number(presentation.inventory_item_id)) ?? [];
    itemPresentations.push({
      id: Number(presentation.id),
      name: inventoryDisplayText(presentation.name),
      baseUnitsPerPresentation: Number(presentation.base_units_per_presentation),
    });
    presentationsByItem.set(Number(presentation.inventory_item_id), itemPresentations);
  }

  const allItems: KitchenCountItem[] = rawItems
    .filter((item) => initializedIds.has(Number(item.id)))
    .map((item) => ({
      id: Number(item.id),
      name: inventoryDisplayText(item.name),
      unitName: inventoryDisplayText(item.unit_name),
      inventoryGroup: item.inventory_group,
      presentations: presentationsByItem.get(Number(item.id)) ?? [],
    }));
  const countProgramIds = new Set(
    rawItems
      .filter((item) => item.primary_count_frequency === 'per_shift' && item.primary_count_role === 'kitchen')
      .map((item) => Number(item.id)),
  );
  const items = allItems.filter((item) => countProgramIds.has(item.id));
  const itemById = new Map(allItems.map((item) => [item.id, item]));

  const rawOpenCounts = (openCountsResult.data ?? []) as CountHeaderRow[];
  const openCountIds = rawOpenCounts.map((count) => Number(count.id));
  const linesResult = openCountIds.length
    ? await ctx.supabase
        .from('inventory_count_lines')
        .select('id,inventory_count_id,inventory_item_id,note')
        .in('inventory_count_id', openCountIds)
        .eq('line_status', 'pending')
        .order('id')
    : { data: [], error: null };

  if (linesResult.error) throw new Error(`No se pudieron cargar las líneas solicitadas: ${linesResult.error.message}`);

  const linesByCount = new Map<number, CountLineRow[]>();
  for (const line of (linesResult.data ?? []) as CountLineRow[]) {
    const lines = linesByCount.get(Number(line.inventory_count_id)) ?? [];
    lines.push(line);
    linesByCount.set(Number(line.inventory_count_id), lines);
  }

  const openCounts: KitchenOpenCount[] = rawOpenCounts.map((count) => ({
    id: Number(count.id),
    countKind: count.count_kind as KitchenOpenCount['countKind'],
    dueAt: count.due_at,
    notes: count.notes == null ? null : inventoryDisplayText(count.notes),
    createdAt: count.created_at,
    items: (linesByCount.get(Number(count.id)) ?? []).flatMap((line) => {
      const item = itemById.get(Number(line.inventory_item_id));
      return item ? [{ ...item, requestLineId: Number(line.id) }] : [];
    }),
  }));

  const recentCounts: KitchenRecentCount[] = ((recentCountsResult.data ?? []) as CountHeaderRow[]).map((count) => ({
    id: Number(count.id),
    countKind: count.count_kind,
    status: count.status,
    createdAt: count.created_at,
    submittedAt: count.submitted_at ?? null,
    reviewedAt: count.reviewed_at ?? null,
  }));

  return <KitchenInventoryCountClient items={items} openCounts={openCounts} recentCounts={recentCounts} />;
}
