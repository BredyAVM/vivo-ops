import Link from 'next/link';
import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { inventoryDisplayText } from '@/app/app/inventory/display';
import MasterInventoryClient, {
  type MasterInventoryCount,
  type MasterInventoryItem,
} from './MasterInventoryClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type InventoryItemRow = {
  id: number | string;
  name: string;
  unit_name: string;
  inventory_group: string;
  current_stock_units: number | string;
  low_stock_threshold: number | string | null;
  low_stock_inclusive: boolean;
  target_stock_units: number | string | null;
  primary_count_frequency: string | null;
};

type CountHeaderRow = {
  id: number | string;
  count_kind: string;
  status: string;
  responsible_role: string;
  parent_count_id: number | string | null;
  due_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
};

type CountLineRow = {
  id: number | string;
  inventory_count_id: number | string;
  inventory_item_id: number | string;
  counted_quantity_units: number | string | null;
  difference_quantity_units: number | string | null;
  line_status: string;
};

function uniqueCountRows(...groups: CountHeaderRow[][]) {
  const byId = new Map<number, CountHeaderRow>();
  for (const group of groups) {
    for (const count of group) byId.set(Number(count.id), count);
  }
  return Array.from(byId.values());
}

export default async function MasterInventoryPage() {
  noStore();
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!isMasterOrAdminRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const [itemsResult, activeCountsResult, recentCountsResult, openingsResult] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id,name,unit_name,inventory_group,current_stock_units,low_stock_threshold,low_stock_inclusive,target_stock_units,primary_count_frequency')
      .eq('is_active', true)
      .is('merged_into_item_id', null)
      .in('tracking_mode', ['transactional', 'periodic_count'])
      .order('inventory_group')
      .order('name'),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,responsible_role,parent_count_id,due_at,submitted_at,reviewed_at,notes,created_at')
      .in('status', ['open', 'submitted', 'recount_requested'])
      .order('created_at', { ascending: false }),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,responsible_role,parent_count_id,due_at,submitted_at,reviewed_at,notes,created_at')
      .order('created_at', { ascending: false })
      .limit(40),
    ctx.supabase
      .from('inventory_counts')
      .select('id')
      .eq('count_kind', 'opening')
      .eq('status', 'accepted')
      .order('id', { ascending: false })
      .limit(100),
  ]);

  const firstError = itemsResult.error ?? activeCountsResult.error ?? recentCountsResult.error ?? openingsResult.error;
  if (firstError) throw new Error(`No se pudo cargar el control operativo de inventario: ${firstError.message}`);

  const activeCounts = (activeCountsResult.data ?? []) as CountHeaderRow[];
  const recentCounts = (recentCountsResult.data ?? []) as CountHeaderRow[];
  const openingIds = (openingsResult.data ?? []).map((row) => Number(row.id));
  const counts = uniqueCountRows(activeCounts, recentCounts);
  const lineCountIds = Array.from(new Set([...counts.map((count) => Number(count.id)), ...openingIds]));
  const linesResult = lineCountIds.length
    ? await ctx.supabase
        .from('inventory_count_lines')
        .select('id,inventory_count_id,inventory_item_id,counted_quantity_units,difference_quantity_units,line_status')
        .in('inventory_count_id', lineCountIds)
        .order('id')
    : { data: [], error: null };

  if (linesResult.error) throw new Error(`No se pudieron cargar las líneas de conteo: ${linesResult.error.message}`);

  const rawItems = (itemsResult.data ?? []) as InventoryItemRow[];
  const itemNameById = new Map(rawItems.map((item) => [Number(item.id), inventoryDisplayText(item.name)]));
  const lines = (linesResult.data ?? []) as CountLineRow[];
  const initializedItemIds = new Set(
    lines
      .filter((line) => openingIds.includes(Number(line.inventory_count_id)) && line.line_status === 'accepted')
      .map((line) => Number(line.inventory_item_id)),
  );
  const activeCountIdSet = new Set(activeCounts.map((count) => Number(count.id)));
  const pendingCountByItem = new Map<number, number>();
  const linesByCount = new Map<number, CountLineRow[]>();

  for (const line of lines) {
    const countId = Number(line.inventory_count_id);
    const countLines = linesByCount.get(countId) ?? [];
    countLines.push(line);
    linesByCount.set(countId, countLines);
    if (activeCountIdSet.has(countId) && !pendingCountByItem.has(Number(line.inventory_item_id))) {
      pendingCountByItem.set(Number(line.inventory_item_id), countId);
    }
  }

  const items: MasterInventoryItem[] = rawItems
    .filter((item) => initializedItemIds.has(Number(item.id)))
    .map((item) => {
      const stock = Number(item.current_stock_units);
      const threshold = item.low_stock_threshold == null ? null : Number(item.low_stock_threshold);
      return {
        id: Number(item.id),
        name: inventoryDisplayText(item.name),
        unitName: inventoryDisplayText(item.unit_name),
        inventoryGroup: item.inventory_group,
        currentStockUnits: stock,
        lowStockThreshold: threshold,
        targetStockUnits: item.target_stock_units == null ? null : Number(item.target_stock_units),
        primaryCountFrequency: item.primary_count_frequency,
        isLowStock: threshold != null && (item.low_stock_inclusive ? stock <= threshold : stock < threshold),
        pendingCountId: pendingCountByItem.get(Number(item.id)) ?? null,
      };
    });

  const countSummaries: MasterInventoryCount[] = counts
    .map((count) => {
      const countLines = linesByCount.get(Number(count.id)) ?? [];
      const itemNames = countLines
        .map((line) => itemNameById.get(Number(line.inventory_item_id)))
        .filter((name): name is string => Boolean(name));
      return {
        id: Number(count.id),
        countKind: count.count_kind,
        status: count.status,
        responsibleRole: count.responsible_role,
        parentCountId: count.parent_count_id == null ? null : Number(count.parent_count_id),
        dueAt: count.due_at,
        submittedAt: count.submitted_at,
        reviewedAt: count.reviewed_at,
        notes: count.notes == null ? null : inventoryDisplayText(count.notes),
        createdAt: count.created_at,
        lineCount: countLines.length,
        varianceCount: countLines.filter((line) => line.counted_quantity_units != null && Number(line.difference_quantity_units) !== 0).length,
        itemNames,
      };
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <header className="border-b border-[#242433] bg-[#101014]">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">Vivo Ops · Máster</div>
            <h1 className="mt-1 text-2xl font-black">Control operativo de inventario</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
              Consulta el saldo del sistema, solicita conteos ciegos a Cocina y decide sobre los reportes presentados.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/app/inventory/counts" prefetch={false} className="rounded-xl border border-[#343442] bg-[#15151D] px-4 py-2.5 text-sm font-semibold">
              Historial completo
            </Link>
            <Link href="/app/master/ops" prefetch={false} className="rounded-xl border border-[#FEEF00]/50 bg-[#181812] px-4 py-2.5 text-sm font-semibold text-[#FEEF00]">
              Volver a Máster
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
        <MasterInventoryClient items={items} counts={countSummaries} />
      </div>
    </main>
  );
}
