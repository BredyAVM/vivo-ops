'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requestMasterInventoryCountAction } from './actions';

export type MasterInventoryItem = {
  id: number;
  name: string;
  unitName: string;
  inventoryGroup: string;
  currentStockUnits: number;
  commitmentUnits: number;
  commitmentCount: number;
  availableWithoutIncomingUnits: number | null;
  projectedAvailableUnits: number | null;
  minimumProjectedAt: string | null;
  dependsOnIncoming: boolean;
  lowStockThreshold: number | null;
  targetStockUnits: number | null;
  primaryCountFrequency: string | null;
  isLowStock: boolean;
  pendingCountId: number | null;
  lastCountId: number | null;
  lastCountedUnits: number | null;
  lastCountedAt: string | null;
  lastCountedByName: string | null;
  lastCountAgeText: string;
};

export type MasterInventoryCount = {
  id: number;
  countKind: string;
  status: string;
  responsibleRole: string;
  parentCountId: number | null;
  dueAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  notes: string | null;
  createdAt: string;
  lineCount: number;
  varianceCount: number;
  itemNames: string[];
};

export type MasterInventorySupply = {
  id: number;
  type: 'expected_receipt' | 'planned_production';
  inventoryItemId: number;
  itemName: string;
  unitName: string;
  quantityUnits: number;
  effectiveAt: string;
  sourceName: string | null;
  recipeId: number | null;
  notes: string | null;
};

export type MasterInventoryAlert = {
  id: number;
  category: string;
  type: string;
  severity: 'warning' | 'critical';
  inventoryItemId: number | null;
  inventoryItemName: string | null;
  title: string;
  message: string | null;
  lastDetectedAt: string;
};

type MasterInventoryView = 'overview' | 'stock' | 'counts';

const groupLabels: Record<string, string> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas y bases',
  beverages: 'Bebidas',
  packaging: 'Empaques y consumibles',
  other: 'Otros productos',
};

const countKindLabels: Record<string, string> = {
  opening: 'Apertura física',
  shift_change: 'Cambio de turno',
  requested: 'Conteo solicitado',
  recount: 'Reconteo',
  periodic: 'Conteo periódico',
};

const statusLabels: Record<string, string> = {
  open: 'Esperando a Cocina',
  submitted: 'Esperando a Máster',
  accepted: 'Aceptado',
  recount_requested: 'Reconteo solicitado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
};

const inputClass = 'w-full rounded-xl border border-[#343444] bg-[#0B0B10] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70';

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function inventoryValueClass(value: number | null, warning = false) {
  if (value == null) return 'text-[#777784]';
  if (value < -0.005) return 'text-rose-300';
  if (value <= 0.005 || warning) return 'text-amber-300';
  return 'text-white';
}

function inventoryRiskRank(item: MasterInventoryItem) {
  if (item.projectedAvailableUnits != null && item.projectedAvailableUnits < -0.005) return 4;
  if (item.availableWithoutIncomingUnits != null && item.availableWithoutIncomingUnits < -0.005) return 3;
  if (item.dependsOnIncoming) return 2;
  if (item.isLowStock) return 1;
  return 0;
}

function countItemSummary(count: MasterInventoryCount) {
  if (!count.itemNames.length) return `${count.lineCount} ítems`;
  const visible = count.itemNames.slice(0, 3).join(', ');
  const remaining = count.itemNames.length - 3;
  return remaining > 0 ? `${visible} y ${remaining} más` : visible;
}

export default function MasterInventoryClient({
  items,
  counts,
  supplies,
  alerts,
}: {
  items: MasterInventoryItem[];
  counts: MasterInventoryCount[];
  supplies: MasterInventorySupply[];
  alerts: MasterInventoryAlert[];
}) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<MasterInventoryView>('overview');
  const [search, setSearch] = useState('');
  const [stockSearch, setStockSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdCountId, setCreatedCountId] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefresh] = useTransition();

  const waitingKitchen = counts.filter((count) => count.status === 'open');
  const waitingMaster = counts.filter((count) => count.status === 'submitted');
  const recentCounts = counts.filter((count) => !['open', 'submitted'].includes(count.status)).slice(0, 12);
  const lowStockCount = items.filter((item) => item.isLowStock).length;
  const dependsOnIncomingCount = items.filter((item) => item.dependsOnIncoming).length;
  const attentionItems = useMemo(
    () => [...items]
      .filter((item) => inventoryRiskRank(item) > 0)
      .sort((left, right) => inventoryRiskRank(right) - inventoryRiskRank(left) || left.name.localeCompare(right.name, 'es'))
      .slice(0, 8),
    [items],
  );
  const selectableItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    return items.filter((item) => {
      if (!query) return true;
      return `${item.name} ${groupLabels[item.inventoryGroup] ?? item.inventoryGroup}`.toLocaleLowerCase('es').includes(query);
    });
  }, [items, search]);
  const visibleStock = useMemo(() => {
    const query = stockSearch.trim().toLocaleLowerCase('es');
    return [...items]
      .filter((item) => !query || `${item.name} ${groupLabels[item.inventoryGroup] ?? item.inventoryGroup}`.toLocaleLowerCase('es').includes(query))
      .sort((left, right) => inventoryRiskRank(right) - inventoryRiskRank(left) || left.name.localeCompare(right.name, 'es'));
  }, [items, stockSearch]);

  function toggleItem(itemId: number) {
    setSelectedIds((current) => current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]);
  }

  function selectVisible() {
    const selectableIds = selectableItems.filter((item) => item.pendingCountId == null).map((item) => item.id);
    setSelectedIds((current) => Array.from(new Set([...current, ...selectableIds])));
  }

  function submitRequest() {
    setError(null);
    setCreatedCountId(null);
    if (!selectedIds.length) {
      setError('Selecciona al menos un ítem para solicitar el conteo.');
      return;
    }

    let dueAtIso: string | null = null;
    if (dueAt) {
      const parsedDueAt = new Date(dueAt);
      if (!Number.isFinite(parsedDueAt.getTime())) {
        setError('Revisa la fecha límite.');
        return;
      }
      dueAtIso = parsedDueAt.toISOString();
    }

    startTransition(async () => {
      try {
        const result = await requestMasterInventoryCountAction({
          operationId: crypto.randomUUID(),
          inventoryItemIds: selectedIds,
          dueAt: dueAtIso,
          notes,
        });
        setCreatedCountId(result.countId);
        setSelectedIds([]);
        setDueAt('');
        setNotes('');
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo solicitar el conteo.');
      }
    });
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm leading-6 text-emerald-100 sm:flex-row sm:items-center sm:justify-between">
        <span>Esta vista se carga solamente al abrir Inventario. Solicitar o revisar un conteo no bloquea pedidos ni descuenta productos.</span>
        <button type="button" disabled={isRefreshing} onClick={() => startRefresh(() => router.refresh())} className="shrink-0 rounded-xl border border-emerald-300/30 px-3 py-2 text-xs font-bold disabled:opacity-50">
          {isRefreshing ? 'Actualizando…' : 'Actualizar saldos'}
        </button>
      </div>

      <nav aria-label="Secciones del inventario de Máster" className="flex gap-2 overflow-x-auto rounded-2xl border border-[#292938] bg-[#111117] p-2">
        {([
          ['overview', 'Resumen'],
          ['stock', 'Existencias y compromisos'],
          ['counts', 'Conteos y revisiones'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeView === key}
            onClick={() => setActiveView(key)}
            className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition ${activeView === key ? 'bg-[#FEEF00] text-black' : 'text-[#B8B8C4] hover:bg-[#1A1A23] hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Ítems operativos" value={items.length} detail={dependsOnIncomingCount ? `${dependsOnIncomingCount} dependen de reposición` : 'sin dependencia de reposición'} tone={dependsOnIncomingCount ? 'warning' : 'default'} />
        <SummaryCard label="Esperando a Cocina" value={waitingKitchen.length} detail="solicitudes abiertas" tone={waitingKitchen.length ? 'warning' : 'default'} />
        <SummaryCard label="Esperando a Máster" value={waitingMaster.length} detail="reportes por decidir" tone={waitingMaster.length ? 'danger' : 'default'} />
        <SummaryCard label="Stock bajo" value={lowStockCount} detail="según umbral configurado" tone={lowStockCount ? 'warning' : 'default'} />
      </div>

      {activeView === 'overview' ? (
        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-amber-100">Atención del Máster</h2>
                <p className="mt-1 text-sm leading-6 text-[#BFB18C]">Solo decisiones operativas vigentes, sin duplicar avisos informativos.</p>
              </div>
              <Link href="/app/inventory/alerts" prefetch={false} className="shrink-0 text-xs font-bold text-amber-200 hover:underline">Ver centro</Link>
            </div>
            <div className="mt-4 space-y-2">
              {alerts.length ? alerts.map((alert) => (
                <article key={alert.id} className={`rounded-xl border p-3 ${alert.severity === 'critical' ? 'border-rose-400/30 bg-rose-400/5' : 'border-amber-300/20 bg-[#15130D]'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">{alert.title}</div>
                      {alert.message ? <p className="mt-1 text-xs leading-5 text-[#B8B1A0]">{alert.message}</p> : null}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black ${alert.severity === 'critical' ? 'bg-rose-400/15 text-rose-200' : 'bg-amber-300/15 text-amber-100'}`}>
                      {alert.severity === 'critical' ? 'CRÍTICA' : 'ATENCIÓN'}
                    </span>
                  </div>
                </article>
              )) : (
                <div className="rounded-xl border border-dashed border-emerald-300/20 px-4 py-5 text-sm text-emerald-100">No hay decisiones de inventario pendientes para Máster.</div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Productos que conviene revisar</h2>
                <p className="mt-1 text-sm leading-6 text-[#A6A6B2]">Ordenados por riesgo de compromisos, reposición y umbral.</p>
              </div>
              <button type="button" onClick={() => setActiveView('stock')} className="shrink-0 text-xs font-bold text-[#FEEF00] hover:underline">Ver todos</button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {attentionItems.length ? attentionItems.map((item) => (
                <article key={item.id} className="rounded-xl border border-[#30303F] bg-[#0D0D12] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">{item.name}</div>
                      <div className="mt-1 text-xs text-[#8F8F9C]">{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</div>
                    </div>
                    <span className={`shrink-0 text-sm font-black ${inventoryValueClass(item.availableWithoutIncomingUnits, item.dependsOnIncoming)}`}>
                      {item.availableWithoutIncomingUnits == null ? '—' : formatQuantity(item.availableWithoutIncomingUnits)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-[#A6A6B2]">
                    {item.dependsOnIncoming
                      ? 'Este saldo depende de una entrada o producción esperada.'
                      : item.commitmentUnits > 0
                        ? `${formatQuantity(item.commitmentUnits)} ${item.unitName} comprometidos.`
                        : 'Está dentro o por debajo del umbral configurado.'}
                  </div>
                </article>
              )) : (
                <div className="sm:col-span-2 rounded-xl border border-dashed border-emerald-300/20 px-4 py-5 text-sm text-emerald-100">No hay existencias en riesgo dentro del horizonte.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {activeView === 'overview' ? (
      <div className="rounded-2xl border border-sky-400/25 bg-sky-400/5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-sky-100">Suministros próximos</h2>
            <p className="mt-1 text-sm leading-6 text-[#A8BBC8]">
              Entradas y producciones activas incluidas en la proyección de los próximos 10 días. Todavía no son existencia física.
            </p>
          </div>
          <Link href="/app/inventory/operations" prefetch={false} className="rounded-xl border border-sky-300/30 px-3 py-2 text-xs font-bold text-sky-100 hover:border-sky-300/60">
            Ver operaciones
          </Link>
        </div>

        {supplies.length ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {supplies.slice(0, 12).map((supply) => (
              <article key={supply.id} className="rounded-xl border border-sky-300/20 bg-[#0B1118] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-white">{supply.itemName}</div>
                    <div className="mt-1 text-xs text-[#93A8B8]">{formatDate(supply.effectiveAt)}</div>
                  </div>
                  <span className="shrink-0 rounded-full border border-sky-300/25 px-2 py-1 text-[10px] font-semibold text-sky-100">
                    {supply.type === 'expected_receipt' ? 'ENTRADA' : 'PRODUCCIÓN'}
                  </span>
                </div>
                <div className="mt-3 text-lg font-black text-sky-100">+{formatQuantity(supply.quantityUnits)} {supply.unitName}</div>
                <div className="mt-1 text-xs font-semibold text-amber-200">
                  {supply.type === 'expected_receipt' ? 'Programada · no recibida' : 'Planificada · no disponible'}
                </div>
                {supply.sourceName ? <div className="mt-2 text-xs text-[#A6B5C1]">Origen: {supply.sourceName}</div> : null}
                {!supply.sourceName && supply.recipeId ? <div className="mt-2 text-xs text-[#A6B5C1]">Receta #{supply.recipeId}</div> : null}
                {supply.notes ? <div className="mt-1 line-clamp-2 text-xs text-[#8395A3]">{supply.notes}</div> : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-sky-300/20 px-4 py-5 text-sm text-[#93A8B8]">
            No hay entradas ni producciones activas dentro de los próximos 10 días.
          </div>
        )}

        {supplies.length > 12 ? <div className="mt-3 text-xs text-[#93A8B8]">Mostrando 12 de {supplies.length}. Abre Operaciones para ver el calendario completo.</div> : null}
      </div>
      ) : null}

      {activeView !== 'stock' && waitingMaster.length ? (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-400/5 p-4">
          <h2 className="text-lg font-bold text-rose-100">Reportes que requieren decisión</h2>
          <p className="mt-1 text-sm text-[#C8AEB4]">Abre el reporte completo para aceptarlo o solicitar reconteos de ítems específicos.</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {waitingMaster.map((count) => (
              <CountCard key={count.id} count={count} actionLabel="Revisar reporte" />
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-5">
        {activeView === 'counts' ? (
        <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Solicitar conteo a Cocina</h2>
              <p className="mt-1 text-sm leading-6 text-[#A6A6B2]">Cocina no verá el saldo esperado. Si no indicas límite, vencerá en 30 minutos.</p>
            </div>
            <span className="rounded-full border border-[#343444] px-3 py-1 text-xs text-[#C7C7D0]">{selectedIds.length} seleccionados</span>
          </div>

          <div className="mt-4 flex gap-2">
            <input aria-label="Buscar ítems para solicitar conteo" value={search} onChange={(event) => setSearch(event.target.value)} className={inputClass} placeholder="Buscar producto o grupo" />
            <button type="button" onClick={selectVisible} className="shrink-0 rounded-xl border border-[#3A3A49] px-3 text-xs font-semibold hover:border-[#FEEF00]/60">Seleccionar visibles</button>
          </div>

          <div className="mt-3 max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {selectableItems.map((item) => {
              const selected = selectedIds.includes(item.id);
              const disabled = item.pendingCountId != null;
              return (
                <label key={item.id} className={`flex items-start gap-3 rounded-xl border p-3 ${disabled ? 'cursor-not-allowed border-[#242433] opacity-55' : selected ? 'border-[#FEEF00]/55 bg-[#FEEF00]/5' : 'border-[#292938] bg-[#0D0D12]'}`}>
                  <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleItem(item.id)} className="mt-1 h-4 w-4 accent-[#FEEF00]" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{item.name}</span>
                    <span className="mt-0.5 block text-xs text-[#92929F]">{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</span>
                    {disabled ? <span className="mt-1 block text-xs text-amber-300">Ya está en el conteo #{item.pendingCountId}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-[#C5C5CE]">Fecha límite
              <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className={`mt-1 ${inputClass}`} />
            </label>
            <label className="text-sm text-[#C5C5CE] sm:col-span-2">Nota opcional
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} className={`mt-1 ${inputClass}`} placeholder="Ej. Recontar bolsas y unidades sueltas de mandocas" />
            </label>
          </div>

          {error ? <div className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</div> : null}
          {createdCountId ? (
            <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
              Solicitud #{createdCountId} enviada a Cocina. <Link href={`/app/inventory/counts/${createdCountId}`} prefetch={false} className="font-bold underline">Abrir registro</Link>
            </div>
          ) : null}

          <div className="mt-4 flex justify-end">
            <button type="button" disabled={isPending || !selectedIds.length} onClick={submitRequest} className="rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-45">
              {isPending ? 'Enviando…' : 'Solicitar conteo'}
            </button>
          </div>
        </div>
        ) : null}

        {activeView === 'stock' ? (
        <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-bold">Saldo del sistema</h2>
              <p className="mt-1 text-sm text-[#A6A6B2]">Último conteo aceptado, entradas, producción, ventas y salidas registradas.</p>
            </div>
            <input aria-label="Buscar en el saldo del sistema" value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} className={`${inputClass} sm:max-w-xs`} placeholder="Buscar existencia" />
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-[#292938]">
            <div className="max-h-[610px] overflow-auto">
              <table className="w-full min-w-[1160px] text-left text-sm">
                <thead className="sticky top-0 bg-[#171720] text-xs uppercase tracking-wide text-[#92929F]">
                  <tr>
                    <th className="px-4 py-3">Ítem</th>
                    <th className="px-4 py-3 text-right">Existencia</th>
                    <th className="px-4 py-3 text-right">Comprometido</th>
                    <th className="px-4 py-3 text-right">Libre sin entradas</th>
                    <th className="px-4 py-3 text-right">Proyección 10 días</th>
                    <th className="px-4 py-3">Último conteo</th>
                    <th className="px-4 py-3">Conteo pendiente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292938]">
                  {visibleStock.map((item) => (
                    <tr key={item.id} className={item.isLowStock ? 'bg-amber-400/5' : ''}>
                      <td className="px-4 py-3">
                        <div className="font-semibold">{item.name}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-[#8F8F9C]">
                          <span>{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</span>
                          {item.lowStockThreshold == null ? null : <span>Umbral {formatQuantity(item.lowStockThreshold)}</span>}
                          {item.isLowStock ? <span className="rounded-full border border-amber-400/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">STOCK BAJO</span> : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-bold text-white">{formatQuantity(item.currentStockUnits)}</span>{' '}
                        <span className="text-xs text-[#8F8F9C]">{item.unitName}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {item.commitmentUnits > 0.005 ? (
                          <>
                            <div className="font-semibold text-violet-200">{formatQuantity(item.commitmentUnits)} {item.unitName}</div>
                            <div className="mt-1 text-xs text-[#858591]">{item.commitmentCount} compromiso{item.commitmentCount === 1 ? '' : 's'}</div>
                          </>
                        ) : <span className="text-[#777784]">—</span>}
                      </td>
                      <td className={`px-4 py-3 text-right font-bold ${inventoryValueClass(item.availableWithoutIncomingUnits)}`}>
                        {item.availableWithoutIncomingUnits == null ? '—' : `${formatQuantity(item.availableWithoutIncomingUnits)} ${item.unitName}`}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className={`font-bold ${inventoryValueClass(item.projectedAvailableUnits, item.dependsOnIncoming)}`}>
                          {item.projectedAvailableUnits == null ? '—' : `${formatQuantity(item.projectedAvailableUnits)} ${item.unitName}`}
                        </div>
                        {item.dependsOnIncoming ? <div className="mt-1 text-xs font-semibold text-amber-300">Depende de reposición</div> : null}
                        {item.minimumProjectedAt && (item.commitmentCount > 0 || item.dependsOnIncoming || (item.projectedAvailableUnits ?? 1) <= 0.005) ? <div className="mt-1 text-xs text-[#858591]">Mínimo: {formatDate(item.minimumProjectedAt)}</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        {item.lastCountId && item.lastCountedAt ? (
                          <div className="min-w-[190px]">
                            <Link href={`/app/inventory/counts/${item.lastCountId}`} prefetch={false} className="font-semibold text-[#FEEF00] hover:underline">
                              {formatDate(item.lastCountedAt)}
                            </Link>
                            <div className="mt-1 text-xs text-[#A6A6B2]">
                              {item.lastCountedUnits == null ? 'Cantidad no disponible' : `${formatQuantity(item.lastCountedUnits)} ${item.unitName}`} · {item.lastCountAgeText}
                            </div>
                            <div className="mt-0.5 text-xs text-[#858591]">Por: {item.lastCountedByName ?? 'Sin responsable'}</div>
                          </div>
                        ) : <span className="text-[#777784]">Sin conteo</span>}
                      </td>
                      <td className="px-4 py-3">{item.pendingCountId ? <Link href={`/app/inventory/counts/${item.pendingCountId}`} prefetch={false} className="font-semibold text-amber-300 hover:underline">#{item.pendingCountId}</Link> : <span className="text-[#777784]">Sin pendiente</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#858591]">
            Libre sin entradas descuenta los compromisos activos sin contar reposiciones futuras. La proyección incorpora entradas y producciones conocidas dentro de los próximos 10 días; es informativa y no mueve inventario.
          </p>
        </div>
        ) : null}
      </div>

      {activeView === 'counts' && waitingKitchen.length ? (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 sm:p-5">
          <h2 className="text-lg font-bold text-amber-100">Conteos que debe responder Cocina</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {waitingKitchen.map((count) => <CountCard key={count.id} count={count} actionLabel="Ver solicitud" />)}
          </div>
        </div>
      ) : null}

      {activeView === 'counts' ? (
      <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold">Actividad reciente</h2><p className="mt-1 text-sm text-[#92929F]">Trazabilidad resumida; el detalle conserva cada diferencia y decisión.</p></div>
          <Link href="/app/inventory/counts" prefetch={false} className="text-sm font-semibold text-[#FEEF00] hover:underline">Ver todo</Link>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {recentCounts.length ? recentCounts.map((count) => <CountCard key={count.id} count={count} actionLabel="Abrir reporte" />) : <div className="text-sm text-[#8F8F9C]">Todavía no hay actividad cerrada.</div>}
        </div>
      </div>
      ) : null}
    </section>
  );
}

function SummaryCard({ label, value, detail, tone = 'default' }: { label: string; value: number; detail: string; tone?: 'default' | 'warning' | 'danger' }) {
  const valueClass = tone === 'danger' ? 'text-rose-300' : tone === 'warning' ? 'text-amber-300' : 'text-white';
  return <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4"><div className="text-xs uppercase tracking-wide text-[#8F8F9C]">{label}</div><div className={`mt-2 text-3xl font-black ${valueClass}`}>{value}</div><div className="mt-1 text-xs text-[#858591]">{detail}</div></div>;
}

function CountCard({ count, actionLabel }: { count: MasterInventoryCount; actionLabel: string }) {
  return (
    <article className="rounded-xl border border-[#30303F] bg-[#111117] p-4">
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-xs uppercase tracking-wide text-[#90909D]">{countKindLabels[count.countKind] ?? count.countKind}</div><h3 className="mt-1 font-bold">Conteo #{count.id}</h3></div>
        <span className="rounded-full border border-[#3A3A49] px-2.5 py-1 text-[11px] text-[#D0D0D8]">{statusLabels[count.status] ?? count.status}</span>
      </div>
      <p className="mt-3 text-sm leading-5 text-[#B5B5C0]">{countItemSummary(count)}</p>
      <div className="mt-2 text-xs text-[#858591]">{count.lineCount} ítems · {count.varianceCount} diferencias · {count.status === 'open' ? `vence ${formatDate(count.dueAt)}` : formatDate(count.submittedAt ?? count.reviewedAt ?? count.createdAt)}</div>
      {count.notes ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#A6A6B2]">{count.notes}</p> : null}
      <Link href={`/app/inventory/counts/${count.id}`} prefetch={false} className="mt-3 inline-flex text-sm font-bold text-[#FEEF00] hover:underline">{actionLabel} →</Link>
    </article>
  );
}
