import InventoryCatalogClient, { type InventoryCatalogRow } from './InventoryCatalogClient';
import { getAuthContext } from '@/lib/auth';

type RawInventoryItem = {
  id: number;
  name: string;
  inventory_kind: string;
  inventory_group: string | null;
  unit_name: string | null;
  packaging_name: string | null;
  packaging_size: number | string | null;
  current_stock_units: number | string | null;
  low_stock_threshold: number | string | null;
  low_stock_inclusive: boolean;
  tracking_mode: InventoryCatalogRow['trackingMode'];
  consumption_triggers: string[] | null;
  availability_mode: InventoryCatalogRow['availabilityMode'];
  target_stock_units: number | string | null;
  shelf_life_days: number | null;
  merged_into_item_id: number | null;
  primary_count_frequency: string | null;
  primary_count_role: string | null;
  is_active: boolean;
};

function toNullableNumber(value: number | string | null) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function InventoryPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(`
      id,
      name,
      inventory_kind,
      inventory_group,
      unit_name,
      packaging_name,
      packaging_size,
      current_stock_units,
      low_stock_threshold,
      low_stock_inclusive,
      tracking_mode,
      consumption_triggers,
      availability_mode,
      target_stock_units,
      shelf_life_days,
      merged_into_item_id,
      primary_count_frequency,
      primary_count_role,
      is_active
    `)
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`No se pudo cargar el catálogo de inventario: ${error.message}`);
  }

  const rawItems = (data ?? []) as RawInventoryItem[];
  const itemNameById = new Map(rawItems.map((item) => [Number(item.id), item.name]));
  const items: InventoryCatalogRow[] = rawItems.map((item) => ({
    id: Number(item.id),
    name: item.name,
    inventoryKind: item.inventory_kind,
    inventoryGroup: item.inventory_group ?? 'other',
    unitName: item.unit_name ?? 'unidad',
    packagingName: item.packaging_name,
    packagingSize: toNullableNumber(item.packaging_size),
    currentStockUnits: toNullableNumber(item.current_stock_units) ?? 0,
    lowStockThreshold: toNullableNumber(item.low_stock_threshold),
    lowStockInclusive: item.low_stock_inclusive,
    trackingMode: item.tracking_mode,
    consumptionTriggers: item.consumption_triggers ?? [],
    availabilityMode: item.availability_mode,
    targetStockUnits: toNullableNumber(item.target_stock_units),
    shelfLifeDays: item.shelf_life_days,
    mergedIntoItemId: item.merged_into_item_id,
    mergedIntoItemName: item.merged_into_item_id
      ? itemNameById.get(Number(item.merged_into_item_id)) ?? null
      : null,
    primaryCountFrequency: item.primary_count_frequency,
    primaryCountRole: item.primary_count_role,
    isActive: item.is_active,
  }));

  const transactionalCount = items.filter((item) => item.trackingMode === 'transactional').length;
  const periodicCount = items.filter((item) => item.trackingMode === 'periodic_count').length;
  const aliasCount = items.filter((item) => item.mergedIntoItemId != null).length;
  const lowStockCount = items.filter((item) => {
    if (item.trackingMode === 'not_tracked' || item.lowStockThreshold == null) return false;
    return item.lowStockInclusive
      ? item.currentStockUnits <= item.lowStockThreshold
      : item.currentStockUnits < item.lowStockThreshold;
  }).length;

  return (
    <>
      <section>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Estado del catálogo inventariable</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
              Esta vista lee la clasificación canónica aplicada en Supabase. Todavía no activa nuevas
              deducciones ni modifica existencias.
            </p>
          </div>
          <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
            Solo lectura · Bloque de clasificación
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SummaryCard label="Registros" value={items.length} />
          <SummaryCard label="Transaccionales" value={transactionalCount} tone="good" />
          <SummaryCard label="Conteo periódico" value={periodicCount} tone="info" />
          <SummaryCard label="Alias históricos" value={aliasCount} tone="warn" />
          <SummaryCard label="Alertas por umbral" value={lowStockCount} tone="danger" />
        </div>
      </section>

      <InventoryCatalogClient items={items} />
    </>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'good' | 'info' | 'warn' | 'danger';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-[#86EFAC]',
    info: 'text-[#7DD3FC]',
    warn: 'text-[#FBBF24]',
    danger: 'text-[#FB7185]',
  }[tone];

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
