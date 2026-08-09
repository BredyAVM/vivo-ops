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
  lowStockThreshold: number | null;
  targetStockUnits: number | null;
  primaryCountFrequency: string | null;
  isLowStock: boolean;
  pendingCountId: number | null;
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

function countItemSummary(count: MasterInventoryCount) {
  if (!count.itemNames.length) return `${count.lineCount} ítems`;
  const visible = count.itemNames.slice(0, 3).join(', ');
  const remaining = count.itemNames.length - 3;
  return remaining > 0 ? `${visible} y ${remaining} más` : visible;
}

export default function MasterInventoryClient({
  items,
  counts,
}: {
  items: MasterInventoryItem[];
  counts: MasterInventoryCount[];
}) {
  const router = useRouter();
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
      .sort((left, right) => Number(right.isLowStock) - Number(left.isLowStock) || left.name.localeCompare(right.name, 'es'));
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Saldo disponible" value={items.length} detail="ítems inicializados" />
        <SummaryCard label="Esperando a Cocina" value={waitingKitchen.length} detail="solicitudes abiertas" tone={waitingKitchen.length ? 'warning' : 'default'} />
        <SummaryCard label="Esperando a Máster" value={waitingMaster.length} detail="reportes por decidir" tone={waitingMaster.length ? 'danger' : 'default'} />
        <SummaryCard label="Stock bajo" value={lowStockCount} detail="según umbral configurado" tone={lowStockCount ? 'warning' : 'default'} />
      </div>

      {waitingMaster.length ? (
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

      <div className="grid gap-5 xl:grid-cols-[0.95fr_1.35fr]">
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
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="sticky top-0 bg-[#171720] text-xs uppercase tracking-wide text-[#92929F]">
                  <tr><th className="px-4 py-3">Ítem</th><th className="px-4 py-3">Grupo</th><th className="px-4 py-3 text-right">Saldo</th><th className="px-4 py-3 text-right">Alerta</th><th className="px-4 py-3">Conteo</th></tr>
                </thead>
                <tbody className="divide-y divide-[#292938]">
                  {visibleStock.map((item) => (
                    <tr key={item.id} className={item.isLowStock ? 'bg-amber-400/5' : ''}>
                      <td className="px-4 py-3 font-semibold">{item.name}</td>
                      <td className="px-4 py-3 text-[#A6A6B2]">{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</td>
                      <td className="px-4 py-3 text-right"><span className="font-bold text-white">{formatQuantity(item.currentStockUnits)}</span> <span className="text-xs text-[#8F8F9C]">{item.unitName}</span></td>
                      <td className="px-4 py-3 text-right">{item.lowStockThreshold == null ? <span className="text-[#777784]">—</span> : <span className={item.isLowStock ? 'font-semibold text-amber-300' : 'text-[#A6A6B2]'}>{formatQuantity(item.lowStockThreshold)}</span>}</td>
                      <td className="px-4 py-3">{item.pendingCountId ? <Link href={`/app/inventory/counts/${item.pendingCountId}`} prefetch={false} className="font-semibold text-amber-300 hover:underline">#{item.pendingCountId}</Link> : <span className="text-[#777784]">Sin pendiente</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {waitingKitchen.length ? (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 sm:p-5">
          <h2 className="text-lg font-bold text-amber-100">Conteos que debe responder Cocina</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {waitingKitchen.map((count) => <CountCard key={count.id} count={count} actionLabel="Ver solicitud" />)}
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold">Actividad reciente</h2><p className="mt-1 text-sm text-[#92929F]">Trazabilidad resumida; el detalle conserva cada diferencia y decisión.</p></div>
          <Link href="/app/inventory/counts" prefetch={false} className="text-sm font-semibold text-[#FEEF00] hover:underline">Ver todo</Link>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {recentCounts.length ? recentCounts.map((count) => <CountCard key={count.id} count={count} actionLabel="Abrir reporte" />) : <div className="text-sm text-[#8F8F9C]">Todavía no hay actividad cerrada.</div>}
        </div>
      </div>
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
