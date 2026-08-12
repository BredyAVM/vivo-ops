import Link from 'next/link';
import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { inventoryDisplayText, inventoryUnitLabel } from '@/app/app/inventory/display';
import MasterInventoryClient, {
  type MasterInventoryAlert,
  type MasterInventoryCount,
  type MasterInventoryItem,
  type MasterInventoryProduct,
  type MasterInventorySuspension,
} from './MasterInventoryClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Promise<{ view?: string }>;

type InventoryLastCountRow = {
  inventory_count_id: number | string;
  counted_units: number | string | null;
  counted_at: string;
  counted_by_name: string | null;
};

type InventoryItemRow = {
  id: number | string;
  name: string;
  unit_name: string;
  inventory_group: string;
  initialized: boolean;
  stock_units: number | string | null;
  commitment_units: number | string;
  commitment_count: number | string;
  available_without_incoming_units: number | string | null;
  projected_available_units: number | string | null;
  minimum_projected_at: string | null;
  depends_on_incoming: boolean;
  low_stock_threshold: number | string | null;
  target_stock_units: number | string | null;
  primary_count_frequency: string | null;
  threshold_status: string;
  last_count: InventoryLastCountRow | null;
};

type InventoryWorkspaceRow = {
  generated_at: string;
  items: InventoryItemRow[];
  projection_events: InventoryProjectionEventRow[];
};

type InventoryAlertRow = {
  id: number | string;
  alert_category: string;
  alert_type: string;
  severity: string;
  requires_action: boolean;
  status: string;
  inventory_item_id: number | string | null;
  inventory_item_name: string | null;
  title: string;
  message: string | null;
  last_detected_at: string;
};

type InventoryAlertWorkspaceRow = {
  alerts: InventoryAlertRow[];
};

type InventoryProjectionEventRow = {
  id: number | string;
  inventory_item_id: number | string;
  inventory_item_name: string;
  unit_name: string;
  flow_type: string;
  quantity_units: number | string;
  effective_at: string;
  status: string;
  inventory_recipe_id: number | string | null;
  notes: string | null;
  capture_details: unknown;
};

type InventorySuspensionRow = {
  id: number | string;
  inventory_item_id: number | string;
  effective_at: string | null;
  notes: string | null;
  created_at: string;
  capture_details: unknown;
};

type InventoryProductRow = {
  id: number | string;
  sku: string | null;
  name: string;
  type: string;
  inventory_policy: string | null;
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
  shift_business_date: string | null;
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

function inventoryCountAgeText(countedAt: string | null, generatedAt: string) {
  if (!countedAt) return 'Sin conteo';
  const countedAtMs = new Date(countedAt).getTime();
  const generatedAtMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(countedAtMs) || !Number.isFinite(generatedAtMs)) return 'Antigüedad no disponible';

  const elapsedMinutes = Math.max(0, Math.floor((generatedAtMs - countedAtMs) / 60_000));
  if (elapsedMinutes < 60) return elapsedMinutes <= 1 ? 'Hace un minuto' : `Hace ${elapsedMinutes} min`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return elapsedHours === 1 ? 'Hace una hora' : `Hace ${elapsedHours} h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? 'Hace un día' : `Hace ${elapsedDays} días`;
}

function inventoryObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export default async function MasterInventoryPage({ searchParams }: { searchParams: SearchParams }) {
  noStore();
  const query = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!isMasterOrAdminRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const [workspaceResult, alertWorkspaceResult, suspensionResult, productResult, activeCountsResult, recentCountsResult] = await Promise.all([
    ctx.supabase.rpc('inventory_reporting_workspace_v1', { p_horizon_days: 10 }),
    ctx.supabase.rpc('inventory_alert_workspace_v1', {
      p_surface: 'master_inventory',
      p_include_resolved: false,
    }),
    ctx.supabase
      .from('inventory_planned_flows')
      .select('id,inventory_item_id,effective_at,notes,created_at,capture_details')
      .eq('flow_type', 'declared_unavailability')
      .eq('status', 'active')
      .order('created_at', { ascending: false }),
    ctx.supabase
      .from('products')
      .select('id,sku,name,type,inventory_policy')
      .eq('is_active', true)
      .eq('inventory_configuration_status', 'ready')
      .neq('inventory_policy', 'none')
      .order('name', { ascending: true }),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,responsible_role,parent_count_id,due_at,submitted_at,reviewed_at,notes,created_at,shift_business_date')
      .in('status', ['open', 'submitted', 'recount_requested'])
      .order('created_at', { ascending: false }),
    ctx.supabase
      .from('inventory_counts')
      .select('id,count_kind,status,responsible_role,parent_count_id,due_at,submitted_at,reviewed_at,notes,created_at,shift_business_date')
      .order('created_at', { ascending: false })
      .limit(40),
  ]);

  const firstError = workspaceResult.error ?? alertWorkspaceResult.error ?? suspensionResult.error ?? productResult.error ?? activeCountsResult.error ?? recentCountsResult.error;
  if (firstError) throw new Error(`No se pudo cargar el control operativo de inventario: ${firstError.message}`);

  const activeCounts = (activeCountsResult.data ?? []) as CountHeaderRow[];
  const recentCounts = (recentCountsResult.data ?? []) as CountHeaderRow[];
  const counts = uniqueCountRows(activeCounts, recentCounts);
  const lineCountIds = Array.from(new Set(counts.map((count) => Number(count.id))));
  const linesResult = lineCountIds.length
    ? await ctx.supabase
        .from('inventory_count_lines')
        .select('id,inventory_count_id,inventory_item_id,counted_quantity_units,difference_quantity_units,line_status')
        .in('inventory_count_id', lineCountIds)
        .order('id')
    : { data: [], error: null };

  if (linesResult.error) throw new Error(`No se pudieron cargar las líneas de conteo: ${linesResult.error.message}`);

  const workspace = (workspaceResult.data ?? { generated_at: new Date().toISOString(), items: [], projection_events: [] }) as InventoryWorkspaceRow;
  const alertWorkspace = (alertWorkspaceResult.data ?? { alerts: [] }) as InventoryAlertWorkspaceRow;
  const rawItems = workspace.items ?? [];
  const supplies = (workspace.projection_events ?? [])
    .filter((flow) => flow.flow_type === 'expected_receipt' || flow.flow_type === 'planned_production')
    .map((flow) => {
      const captureDetails = inventoryObject(flow.capture_details);
      const sourceName = String(captureDetails.source_name ?? '').trim();
      return {
        id: Number(flow.id),
        type: flow.flow_type === 'planned_production' ? 'planned_production' as const : 'expected_receipt' as const,
        inventoryItemId: Number(flow.inventory_item_id),
        itemName: inventoryDisplayText(flow.inventory_item_name),
        unitName: inventoryUnitLabel(flow.unit_name),
        quantityUnits: Number(flow.quantity_units ?? 0),
        effectiveAt: flow.effective_at,
        sourceName: sourceName ? inventoryDisplayText(sourceName) : null,
        recipeId: flow.inventory_recipe_id == null ? null : Number(flow.inventory_recipe_id),
        notes: flow.notes ? inventoryDisplayText(flow.notes) : null,
      };
    });
  const itemNameById = new Map(rawItems.map((item) => [Number(item.id), inventoryDisplayText(item.name)]));
  const lines = (linesResult.data ?? []) as CountLineRow[];
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
    .filter((item) => item.initialized)
    .map((item) => {
      const stock = Number(item.stock_units ?? 0);
      const threshold = item.low_stock_threshold == null ? null : Number(item.low_stock_threshold);
      const lastCount = item.last_count;
      return {
        id: Number(item.id),
        name: inventoryDisplayText(item.name),
        unitName: inventoryUnitLabel(item.unit_name),
        inventoryGroup: item.inventory_group,
        currentStockUnits: stock,
        commitmentUnits: Number(item.commitment_units ?? 0),
        commitmentCount: Number(item.commitment_count ?? 0),
        availableWithoutIncomingUnits:
          item.available_without_incoming_units == null
            ? null
            : Number(item.available_without_incoming_units),
        projectedAvailableUnits:
          item.projected_available_units == null
            ? null
            : Number(item.projected_available_units),
        minimumProjectedAt: item.minimum_projected_at,
        dependsOnIncoming: item.depends_on_incoming,
        lowStockThreshold: threshold,
        targetStockUnits: item.target_stock_units == null ? null : Number(item.target_stock_units),
        primaryCountFrequency: item.primary_count_frequency,
        isLowStock: item.threshold_status === 'low' || item.threshold_status === 'out',
        pendingCountId: pendingCountByItem.get(Number(item.id)) ?? null,
        lastCountId: lastCount == null ? null : Number(lastCount.inventory_count_id),
        lastCountedUnits: lastCount?.counted_units == null ? null : Number(lastCount.counted_units),
        lastCountedAt: lastCount?.counted_at ?? null,
        lastCountedByName: lastCount?.counted_by_name
          ? inventoryDisplayText(lastCount.counted_by_name)
          : null,
        lastCountAgeText: inventoryCountAgeText(lastCount?.counted_at ?? null, workspace.generated_at),
      };
    });

  const itemById = new Map(items.map((item) => [item.id, item]));
  const products: MasterInventoryProduct[] = ((productResult.data ?? []) as InventoryProductRow[])
    .map((product) => ({
      id: Number(product.id),
      sku: product.sku ? inventoryDisplayText(product.sku) : null,
      name: inventoryDisplayText(product.name),
      type: product.type,
      inventoryPolicy: product.inventory_policy,
    }));
  const productById = new Map(products.map((product) => [product.id, product]));
  const generatedAtMs = new Date(workspace.generated_at).getTime();
  const suspensions: MasterInventorySuspension[] = ((suspensionResult.data ?? []) as InventorySuspensionRow[])
    .filter((flow) => {
      if (flow.effective_at == null) return true;
      const resumeAtMs = new Date(flow.effective_at).getTime();
      return Number.isFinite(resumeAtMs) && resumeAtMs > generatedAtMs;
    })
    .map((flow) => {
      const itemId = Number(flow.inventory_item_id);
      const item = itemById.get(itemId);
      const details = inventoryObject(flow.capture_details);
      const isProductScope = details.unavailability_scope === 'product';
      const productId = isProductScope ? Number(details.product_id ?? 0) : null;
      const product = productId ? productById.get(productId) : null;
      return {
        id: Number(flow.id),
        scope: isProductScope ? 'product' as const : 'inventory_item' as const,
        productId,
        inventoryItemId: itemId,
        itemName: product?.name
          ?? (details.product_name ? inventoryDisplayText(String(details.product_name)) : null)
          ?? item?.name
          ?? `Ítem #${itemId}`,
        unitName: item?.unitName ?? 'unidad',
        availableFrom: flow.effective_at,
        notes: flow.notes ? inventoryDisplayText(flow.notes) : null,
        createdAt: flow.created_at,
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
        shiftBusinessDate: count.shift_business_date,
        lineCount: countLines.length,
        varianceCount: countLines.filter((line) => line.counted_quantity_units != null && Number(line.difference_quantity_units) !== 0).length,
        itemNames,
      };
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const activeItemIds = new Set(items.map((item) => item.id));
  const alertKeys = new Set<string>();
  const alerts: MasterInventoryAlert[] = (alertWorkspace.alerts ?? [])
    .filter((alert) => {
      if (!alert.requires_action || !['open', 'managed'].includes(alert.status)) return false;
      const itemId = alert.inventory_item_id == null ? null : Number(alert.inventory_item_id);
      if (itemId != null && !activeItemIds.has(itemId)) return false;
      const key = `${alert.alert_category}:${itemId ?? 'general'}`;
      if (alertKeys.has(key)) return false;
      alertKeys.add(key);
      return true;
    })
    .map((alert) => ({
      id: Number(alert.id),
      category: alert.alert_category,
      type: alert.alert_type,
      severity: alert.severity === 'critical' ? 'critical' as const : 'warning' as const,
      inventoryItemId: alert.inventory_item_id == null ? null : Number(alert.inventory_item_id),
      inventoryItemName: alert.inventory_item_name ? inventoryDisplayText(alert.inventory_item_name) : null,
      title: inventoryDisplayText(alert.title),
      message: alert.message ? inventoryDisplayText(alert.message) : null,
      lastDetectedAt: alert.last_detected_at,
    }))
    .sort((left, right) => {
      const severityDelta = Number(right.severity === 'critical') - Number(left.severity === 'critical');
      return severityDelta || new Date(right.lastDetectedAt).getTime() - new Date(left.lastDetectedAt).getTime();
    })
    .slice(0, 8);

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
            <Link href="/app/inventory/alerts" prefetch={false} className="rounded-xl border border-amber-400/35 bg-amber-400/5 px-4 py-2.5 text-sm font-semibold text-amber-200">
              Alertas activas
            </Link>
            <Link href="/app/inventory/operations" prefetch={false} className="rounded-xl border border-sky-400/35 bg-sky-400/5 px-4 py-2.5 text-sm font-semibold text-sky-200">
              Entradas esperadas
            </Link>
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
        <MasterInventoryClient
          initialView={query.view === 'counts' ? 'counts' : 'overview'}
          products={products}
          items={items}
          counts={countSummaries}
          supplies={supplies}
          alerts={alerts}
          suspensions={suspensions}
        />
      </div>
    </main>
  );
}
