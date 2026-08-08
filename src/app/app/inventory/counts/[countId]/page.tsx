import { notFound } from 'next/navigation';
import InventoryCountDetailClient, {
  type InventoryCountChild,
  type InventoryCountDetail,
  type InventoryCountDetailLine,
} from './InventoryCountDetailClient';
import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from '../../display';

type PageProps = {
  params: Promise<{ countId: string }>;
};

function toNullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInventoryItem(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== 'object') return null;
  return raw as { name?: unknown; unit_name?: unknown };
}

export default async function InventoryCountDetailPage({ params }: PageProps) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { countId: countIdParam } = await params;
  const countId = Number(countIdParam);
  if (!Number.isSafeInteger(countId) || countId <= 0) notFound();

  const [countResult, linesResult, childrenResult] = await Promise.all([
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,responsible_role,parent_count_id,notes,created_at,submitted_at,reviewed_at')
      .eq('id', countId)
      .maybeSingle(),
    ctx.supabase
      .from('inventory_count_lines')
      .select(`
        id,
        inventory_item_id,
        expected_quantity_units,
        counted_quantity_units,
        difference_quantity_units,
        line_status,
        note,
        inventory_items!inventory_count_lines_inventory_item_id_fkey(name,unit_name)
      `)
      .eq('inventory_count_id', countId)
      .order('id', { ascending: true }),
    ctx.supabase
      .from('inventory_counts')
      .select('id,status')
      .eq('parent_count_id', countId)
      .order('id', { ascending: true }),
  ]);

  const firstError = countResult.error ?? linesResult.error ?? childrenResult.error;
  if (firstError) {
    throw new Error(`No se pudo cargar el conteo #${countId}: ${firstError.message}`);
  }
  if (!countResult.data) notFound();

  const rawCount = countResult.data;
  const count: InventoryCountDetail = {
    id: Number(rawCount.id),
    countKind: String(rawCount.count_kind),
    status: String(rawCount.status),
    responsibleRole: String(rawCount.responsible_role),
    parentCountId: rawCount.parent_count_id == null ? null : Number(rawCount.parent_count_id),
    notes: rawCount.notes == null ? null : inventoryDisplayText(String(rawCount.notes)),
    createdAt: String(rawCount.created_at),
    submittedAt: rawCount.submitted_at == null ? null : String(rawCount.submitted_at),
    reviewedAt: rawCount.reviewed_at == null ? null : String(rawCount.reviewed_at),
  };

  const lines: InventoryCountDetailLine[] = (linesResult.data ?? []).map((rawLine) => {
    const inventoryItem = toInventoryItem(rawLine.inventory_items);
    const inventoryItemId = Number(rawLine.inventory_item_id);
    return {
      id: Number(rawLine.id),
      inventoryItemId,
      itemName: inventoryDisplayText(String(inventoryItem?.name ?? `Ítem #${inventoryItemId}`)),
      unitName: inventoryDisplayText(String(inventoryItem?.unit_name ?? 'unidad')),
      expectedQuantityUnits: toNullableNumber(rawLine.expected_quantity_units) ?? 0,
      countedQuantityUnits: toNullableNumber(rawLine.counted_quantity_units),
      differenceQuantityUnits: toNullableNumber(rawLine.difference_quantity_units),
      lineStatus: String(rawLine.line_status),
      note: rawLine.note == null ? null : inventoryDisplayText(String(rawLine.note)),
    };
  });

  const childrenCounts: InventoryCountChild[] = (childrenResult.data ?? []).map((child) => ({
    id: Number(child.id),
    status: String(child.status),
  }));

  return (
    <InventoryCountDetailClient
      count={count}
      lines={lines}
      childrenCounts={childrenCounts}
      isAdmin={ctx.roles.includes('admin')}
    />
  );
}
