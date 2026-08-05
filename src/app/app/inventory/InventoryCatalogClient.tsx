'use client';

import { useMemo, useState } from 'react';

export type InventoryCatalogRow = {
  id: number;
  name: string;
  inventoryKind: string;
  inventoryGroup: string;
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  lowStockInclusive: boolean;
  trackingMode: 'transactional' | 'periodic_count' | 'not_tracked';
  consumptionTriggers: string[];
  availabilityMode: 'on_hand_only' | 'immediate_recipe' | 'scheduled_recipe' | null;
  targetStockUnits: number | null;
  shelfLifeDays: number | null;
  mergedIntoItemId: number | null;
  mergedIntoItemName: string | null;
  primaryCountFrequency: string | null;
  primaryCountRole: string | null;
  isActive: boolean;
};

type FilterMode = 'tracked' | InventoryCatalogRow['trackingMode'] | 'all';

const trackingLabels: Record<InventoryCatalogRow['trackingMode'], string> = {
  transactional: 'Transaccional',
  periodic_count: 'Conteo periódico',
  not_tracked: 'No controlado',
};

const availabilityLabels: Record<NonNullable<InventoryCatalogRow['availabilityMode']>, string> = {
  on_hand_only: 'Solo existencia real',
  immediate_recipe: 'Preparación inmediata',
  scheduled_recipe: 'Preparación programada',
};

const frequencyLabels: Record<string, string> = {
  per_shift: 'Por turno',
  daily: 'Diario',
  weekly: 'Semanal',
  biweekly: 'Quincenal',
  monthly: 'Mensual',
};

const triggerLabels: Record<string, string> = {
  sale: 'Venta',
  production: 'Producción',
  manual_issue: 'Salida manual',
};

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(value);
}

function thresholdText(item: InventoryCatalogRow) {
  if (item.lowStockThreshold == null) return 'Sin umbral';
  return `${item.lowStockInclusive ? '≤' : '<'} ${formatQuantity(item.lowStockThreshold)}`;
}

export default function InventoryCatalogClient({ items }: { items: InventoryCatalogRow[] }) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('tracked');

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('es');

    return items.filter((item) => {
      const matchesMode =
        filterMode === 'all' ||
        (filterMode === 'tracked'
          ? item.trackingMode !== 'not_tracked'
          : item.trackingMode === filterMode);
      const matchesSearch =
        !normalizedSearch ||
        item.name.toLocaleLowerCase('es').includes(normalizedSearch) ||
        item.mergedIntoItemName?.toLocaleLowerCase('es').includes(normalizedSearch) ||
        item.inventoryGroup.toLocaleLowerCase('es').includes(normalizedSearch);

      return matchesMode && Boolean(matchesSearch);
    });
  }, [filterMode, items, search]);

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
      <div className="flex flex-col gap-3 border-b border-[#242433] p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Clasificación canónica</h2>
          <p className="mt-1 text-sm text-[#9696A3]">
            {filteredItems.length} de {items.length} registros visibles
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar producto o ítem"
            className="min-w-[240px] rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm outline-none placeholder:text-[#696975] focus:border-[#FEEF00]/60"
          />
          <select
            value={filterMode}
            onChange={(event) => setFilterMode(event.target.value as FilterMode)}
            className="rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm outline-none focus:border-[#FEEF00]/60"
          >
            <option value="tracked">Control activo</option>
            <option value="transactional">Transaccionales</option>
            <option value="periodic_count">Conteo periódico</option>
            <option value="not_tracked">Históricos/no controlados</option>
            <option value="all">Todos</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1180px] w-full text-left text-sm">
          <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
            <tr>
              <th className="px-4 py-3">Ítem</th>
              <th className="px-4 py-3">Control</th>
              <th className="px-4 py-3">Existencia</th>
              <th className="px-4 py-3">Disponibilidad</th>
              <th className="px-4 py-3">Consumo</th>
              <th className="px-4 py-3">Conteo</th>
              <th className="px-4 py-3">Objetivo / alerta</th>
              <th className="px-4 py-3">Identidad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#242433]">
            {filteredItems.map((item) => (
              <tr key={item.id} className="align-top hover:bg-[#15151D]">
                <td className="px-4 py-3">
                  <div className="font-semibold text-[#F2F2F5]">{item.name}</div>
                  <div className="mt-1 text-xs text-[#7F7F8C]">
                    #{item.id} · {item.inventoryGroup} · {item.inventoryKind}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      item.trackingMode === 'not_tracked'
                        ? 'text-[#898995]'
                        : item.trackingMode === 'periodic_count'
                          ? 'text-[#7DD3FC]'
                          : 'text-[#86EFAC]'
                    }
                  >
                    {trackingLabels[item.trackingMode]}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="font-semibold">{formatQuantity(item.currentStockUnits)} {item.unitName}</div>
                  <div className="mt-1 text-xs text-[#7F7F8C]">
                    {item.packagingName
                      ? `${item.packagingName}${item.packagingSize ? ` × ${formatQuantity(item.packagingSize)}` : ''}`
                      : 'Sin presentación configurada'}
                  </div>
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {item.availabilityMode ? availabilityLabels[item.availabilityMode] : 'No aplica'}
                  {item.shelfLifeDays != null ? (
                    <div className="mt-1 text-xs text-[#7F7F8C]">Vida útil: {item.shelfLifeDays} días</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {item.consumptionTriggers.length
                    ? item.consumptionTriggers.map((trigger) => triggerLabels[trigger] ?? trigger).join(', ')
                    : 'No aplica'}
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {item.primaryCountFrequency
                    ? frequencyLabels[item.primaryCountFrequency] ?? item.primaryCountFrequency
                    : 'Sin frecuencia'}
                  {item.primaryCountRole ? (
                    <div className="mt-1 text-xs uppercase text-[#7F7F8C]">{item.primaryCountRole}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  <div>Objetivo: {item.targetStockUnits == null ? '—' : formatQuantity(item.targetStockUnits)}</div>
                  <div className="mt-1 text-xs text-[#7F7F8C]">Alerta: {thresholdText(item)}</div>
                </td>
                <td className="px-4 py-3 text-[#C9C9D2]">
                  {item.mergedIntoItemName ? (
                    <>
                      <div className="text-[#FBBF24]">Alias histórico</div>
                      <div className="mt-1 text-xs text-[#A6A6B2]">Usa: {item.mergedIntoItemName}</div>
                    </>
                  ) : (
                    'Canónica'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filteredItems.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-[#8F8F9C]">
          No hay registros que coincidan con el filtro.
        </div>
      ) : null}
    </section>
  );
}
