import Link from 'next/link';
import type { ReactNode } from 'react';
import InventoryCatalogClient, { type InventoryCatalogRow } from './InventoryCatalogClient';
import { getAuthContext } from '@/lib/auth';
import { inventoryDisplayText } from './display';

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
  const itemNameById = new Map(
    rawItems.map((item) => [Number(item.id), inventoryDisplayText(item.name)]),
  );
  const items: InventoryCatalogRow[] = rawItems.map((item) => ({
    id: Number(item.id),
    name: inventoryDisplayText(item.name),
    inventoryKind: item.inventory_kind,
    inventoryGroup: item.inventory_group ?? 'other',
    unitName: inventoryDisplayText(item.unit_name, 'unidad'),
    packagingName: item.packaging_name
      ? inventoryDisplayText(item.packaging_name)
      : null,
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
              Existencia física vigente y controles de cada ítem. Los movimientos canónicos ya
              actualizan estos saldos; esta pantalla no los modifica al consultarlos.
            </p>
          </div>
          <div className="rounded-full border border-emerald-400/25 bg-emerald-400/5 px-3 py-1 text-xs text-emerald-200">
            Centro canónico activo
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

      <section className="mt-6 rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <h3 className="font-semibold">Cómo usar este centro</h3>
        <p className="mt-1 text-sm text-[#92929F]">
          Cada apartado responde una pregunta distinta; abrir uno no precarga los demás.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <GuideLink href="/app/inventory" title="¿Cuánto hay?">
            Existencias muestra el saldo físico, unidad, mínimo y método de conteo.
          </GuideLink>
          <GuideLink href="/app/inventory/products" title="¿Qué descuenta una venta?">
            Productos muestra la política comercial y su fuente física.
          </GuideLink>
          <GuideLink href="/app/inventory/recipes" title="¿Qué se está preparando?">
            Producción ejecuta recetas activas y controla sus tiempos; no edita fórmulas.
          </GuideLink>
          {ctx.roles.includes('admin') ? (
            <GuideLink href="/app/inventory/configure" title="¿Cómo cambio una regla?">
              Reglas y catálogo permite editar, versionar recetas y crear borradores nuevos.
            </GuideLink>
          ) : (
            <GuideLink href="/app/inventory/counts" title="¿Qué se contó?">
              Conteos conserva cierres, diferencias, decisiones y reconteos.
            </GuideLink>
          )}
        </div>
      </section>

      <InventoryCatalogClient items={items} />
    </>
  );
}

function GuideLink({ href, title, children }: {
  href: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} prefetch={false} className="rounded-xl border border-[#2B2B38] bg-[#0D0D12] p-4 hover:border-[#FEEF00]/40">
      <div className="text-sm font-semibold text-[#FEEF00]">{title}</div>
      <p className="mt-2 text-xs leading-5 text-[#9696A3]">{children}</p>
    </Link>
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
