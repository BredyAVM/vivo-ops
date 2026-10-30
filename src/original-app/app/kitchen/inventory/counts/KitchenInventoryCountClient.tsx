'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { parseDecimalInput } from '@/lib/number-input';
import { getKitchenShiftDateBounds } from '@/lib/kitchen/operations';
import {
  inventoryCountFolio,
  inventoryCountTitle,
} from '@/app/app/inventory/count-presentation';
import {
  cancelKitchenInventoryOpenCountAction,
  openKitchenInventoryShiftAction,
  submitKitchenInventoryCountAction,
} from '../actions';

export type KitchenCountItem = {
  id: number;
  name: string;
  unitName: string;
  inventoryGroup: string;
  countFrequency: string | null;
  countRole: string | null;
  countLocationCode: string | null;
  lastCountedAt: string | null;
  presentations: Array<{
    id: number;
    name: string;
    baseUnitsPerPresentation: number;
  }>;
};

export type KitchenOpenCount = {
  id: number;
  countKind: 'requested' | 'recount' | 'periodic' | 'shift_change';
  dueAt: string | null;
  notes: string | null;
  createdAt: string;
  shiftBusinessDate: string | null;
  openedByName: string;
  canCancel: boolean;
  items: Array<KitchenCountItem & { requestLineId: number }>;
};

export type KitchenRecentCount = {
  id: number;
  countKind: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  shiftBusinessDate: string | null;
  openedByName: string;
  submittedByName: string;
};

type ItemDraft = {
  baseUnits: string;
  presentationQuantities: Record<number, string>;
  note: string;
};

type KitchenPeriodicFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

const groupLabels: Record<string, string> = {
  raw: 'Crudos',
  prefried: 'Prefritos',
  sauces: 'Salsas y bases',
  beverages: 'Bebidas',
  other: 'Otros productos',
};

const groupOrder = ['raw', 'prefried', 'sauces', 'beverages', 'fried', 'packaging', 'other'];

const beverageLocationLabels: Record<string, string> = {
  beverage_pepsi: 'Cava Pepsi + reserva',
  beverage_coca_cola: 'Cava Coca-Cola + reserva',
  beverage_reserve: 'Reserva u otra ubicación',
};

function beverageLocationGroups(items: KitchenCountItem[]) {
  const groups = new Map<string, KitchenCountItem[]>();
  for (const item of items) {
    const locationCode = item.countLocationCode || 'beverage_reserve';
    const current = groups.get(locationCode) ?? [];
    current.push(item);
    groups.set(locationCode, current);
  }
  const locationOrder = ['beverage_pepsi', 'beverage_coca_cola', 'beverage_reserve'];
  return Array.from(groups.entries()).sort(
    ([left], [right]) => locationOrder.indexOf(left) - locationOrder.indexOf(right),
  );
}

const periodicPrograms: Array<{
  frequency: KitchenPeriodicFrequency;
  label: string;
  shortLabel: string;
  intervalDays: number | null;
}> = [
  { frequency: 'daily', label: 'Inventario diario', shortLabel: 'Diario', intervalDays: 1 },
  { frequency: 'weekly', label: 'Inventario semanal', shortLabel: 'Semanal', intervalDays: 7 },
  { frequency: 'biweekly', label: 'Inventario quincenal', shortLabel: 'Quincenal', intervalDays: 14 },
  { frequency: 'monthly', label: 'Inventario mensual', shortLabel: 'Mensual', intervalDays: null },
];

const statusLabels: Record<string, string> = {
  submitted: 'En revisión',
  accepted: 'Aceptado',
  recount_requested: 'Reconteo solicitado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
};

const inputClass = 'w-full rounded-xl border border-[#343444] bg-[#0B0B10] px-3 py-2 text-white outline-none focus:border-[#FEEF00]/70';

function emptyDraft(): ItemDraft {
  return { baseUnits: '', presentationQuantities: {}, note: '' };
}

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

function periodicDueAt(countedAt: string, intervalDays: number | null) {
  const dueAt = new Date(countedAt);
  if (!Number.isFinite(dueAt.getTime())) return Number.NaN;
  if (intervalDays == null) {
    dueAt.setUTCMonth(dueAt.getUTCMonth() + 1);
    return dueAt.getTime();
  }
  return dueAt.getTime() + intervalDays * 24 * 60 * 60 * 1000;
}

function usesPresentations(item: KitchenCountItem) {
  return item.presentations.some((presentation) => presentation.baseUnitsPerPresentation !== 1);
}

function usesPrefriedServiceAndUnits(item: KitchenCountItem) {
  return item.inventoryGroup === 'prefried' && usesPresentations(item);
}

function prefriedCountBreakdown(item: KitchenCountItem, total: number) {
  const loosePresentation = item.presentations.find(
    (presentation) => presentation.baseUnitsPerPresentation > 0
      && presentation.baseUnitsPerPresentation < 1,
  );
  if (!loosePresentation) return null;

  const unitsPerService = Math.round(1 / loosePresentation.baseUnitsPerPresentation);
  if (
    unitsPerService <= 1
    || Math.abs(unitsPerService * loosePresentation.baseUnitsPerPresentation - 1) > 0.000001
  ) return null;

  let services = Math.floor(total + 0.000001);
  let looseUnits = Math.round((total - services) * unitsPerService);
  if (looseUnits >= unitsPerService) {
    services += 1;
    looseUnits -= unitsPerService;
  }
  return `${formatQuantity(services)} servicios + ${formatQuantity(looseUnits)} UND`;
}

function countedTotal(item: KitchenCountItem, draft: ItemDraft) {
  if (!usesPresentations(item)) {
    const raw = draft.baseUnits.trim();
    return raw ? parseDecimalInput(raw) : null;
  }

  const prefriedServiceAndUnits = usesPrefriedServiceAndUnits(item);
  const hasValue = (!prefriedServiceAndUnits && draft.baseUnits.trim() !== '') || item.presentations.some(
    (presentation) => String(draft.presentationQuantities[presentation.id] ?? '').trim() !== '',
  );
  if (!hasValue) return null;

  const looseCanonicalUnits = !prefriedServiceAndUnits && draft.baseUnits.trim()
    ? parseDecimalInput(draft.baseUnits)
    : 0;
  if (!Number.isFinite(looseCanonicalUnits) || looseCanonicalUnits < 0) return Number.NaN;

  return item.presentations.reduce((total, presentation) => {
    const raw = String(draft.presentationQuantities[presentation.id] ?? '').trim();
    if (!raw) return total;
    const quantity = parseDecimalInput(raw);
    if (
      !Number.isFinite(quantity)
      || quantity < 0
      || (prefriedServiceAndUnits && !Number.isSafeInteger(quantity))
    ) return Number.NaN;
    return total + quantity * presentation.baseUnitsPerPresentation;
  }, looseCanonicalUnits);
}

export default function KitchenInventoryCountClient({
  items,
  openCounts,
  recentCounts,
}: {
  items: KitchenCountItem[];
  openCounts: KitchenOpenCount[];
  recentCounts: KitchenRecentCount[];
}) {
  const router = useRouter();
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
  const [shiftDateBounds] = useState(() => getKitchenShiftDateBounds(new Date(Date.now())));
  const [shiftBusinessDate, setShiftBusinessDate] = useState(() => shiftDateBounds.max);
  const [manualItemId, setManualItemId] = useState<number | null>(null);
  const [selectedFrequency, setSelectedFrequency] = useState<KitchenPeriodicFrequency | null>(null);
  const [activeGroup, setActiveGroup] = useState('all');
  const [scheduleNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<number, ItemDraft>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedRequest = useMemo(
    () => openCounts.find((count) => count.id === selectedRequestId) ?? null,
    [openCounts, selectedRequestId],
  );
  const manualItem = useMemo(
    () => items.find((item) => item.id === manualItemId) ?? null,
    [items, manualItemId],
  );
  const periodicItems = useMemo(
    () => selectedFrequency
      ? items.filter((item) => item.countFrequency === selectedFrequency && item.countRole === 'kitchen')
      : [],
    [items, selectedFrequency],
  );
  const activeItems = useMemo(
    () => selectedRequest?.items ?? (manualItem ? [manualItem] : periodicItems),
    [manualItem, periodicItems, selectedRequest],
  );
  const groupedItems = useMemo(() => {
    const groups = new Map<string, KitchenCountItem[]>();
    for (const item of activeItems) {
      const groupItems = groups.get(item.inventoryGroup) ?? [];
      groupItems.push(item);
      groups.set(item.inventoryGroup, groupItems);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => {
      const leftIndex = groupOrder.indexOf(left);
      const rightIndex = groupOrder.indexOf(right);
      return (leftIndex === -1 ? groupOrder.length : leftIndex)
        - (rightIndex === -1 ? groupOrder.length : rightIndex);
    });
  }, [activeItems]);
  const visibleGroups = useMemo(
    () => activeGroup === 'all'
      ? groupedItems
      : groupedItems.filter(([group]) => group === activeGroup),
    [activeGroup, groupedItems],
  );
  const countedItemCount = useMemo(
    () => activeItems.filter((item) => {
      const total = countedTotal(item, drafts[item.id] ?? emptyDraft());
      return total != null && Number.isFinite(total) && total >= 0;
    }).length,
    [activeItems, drafts],
  );
  const availableGroups = useMemo(
    () => Array.from(new Set(activeItems.map((item) => item.inventoryGroup))),
    [activeItems],
  );
  const configuredPeriodicPrograms = useMemo(
    () => periodicPrograms.map((program) => {
      const programItems = items.filter(
        (item) => item.countFrequency === program.frequency && item.countRole === 'kitchen',
      );
      return {
        ...program,
        itemCount: programItems.length,
        dueCount: programItems.filter((item) => {
          if (!item.lastCountedAt) return true;
          const dueAt = periodicDueAt(item.lastCountedAt, program.intervalDays);
          return !Number.isFinite(dueAt) || dueAt < scheduleNow;
        }).length,
      };
    }),
    [items, scheduleNow],
  );
  const openShiftCount = useMemo(
    () => openCounts.find(
      (count) => count.countKind === 'shift_change' && count.shiftBusinessDate === shiftBusinessDate,
    ) ?? null,
    [openCounts, shiftBusinessDate],
  );
  const completedShiftCounts = useMemo(
    () => recentCounts.filter(
      (count) => count.countKind === 'shift_change'
        && count.shiftBusinessDate === shiftBusinessDate
        && ['submitted', 'accepted', 'recount_requested'].includes(count.status),
    ),
    [recentCounts, shiftBusinessDate],
  );

  function draftFor(itemId: number) {
    return drafts[itemId] ?? emptyDraft();
  }

  function updateDraft(itemId: number, patch: Partial<ItemDraft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? emptyDraft()), ...patch },
    }));
  }

  function chooseRequest(countId: number | null) {
    setSelectedRequestId(countId);
    setManualItemId(null);
    setSelectedFrequency(null);
    setActiveGroup('all');
    setDrafts({});
    setNotes('');
    setError(null);
    setMessage(null);
  }

  function choosePeriodicProgram(frequency: KitchenPeriodicFrequency) {
    setSelectedRequestId(null);
    setManualItemId(null);
    setSelectedFrequency(frequency);
    setActiveGroup('all');
    setDrafts({});
    setNotes('');
    setError(null);
    setMessage(null);
  }

  function submitCount() {
    setError(null);
    setMessage(null);
    const lines: Array<{ inventoryItemId: number; countedQuantityUnits: number; note: string | null }> = [];

    for (const item of activeItems) {
      const draft = draftFor(item.id);
      const total = countedTotal(item, draft);
      if (total == null) {
        setError(`Falta contar “${item.name}”. Escribe 0 cuando no haya existencia.`);
        return;
      }
      if (!Number.isFinite(total) || total < 0) {
        setError(`Revisa la cantidad de “${item.name}”.`);
        return;
      }
      lines.push({
        inventoryItemId: item.id,
        countedQuantityUnits: total,
        note: draft.note.trim() || null,
      });
    }

    startTransition(async () => {
      try {
        const result = await submitKitchenInventoryCountAction({
          operationId: crypto.randomUUID(),
          countKind: selectedRequest?.countKind ?? (manualItem ? 'requested' : 'periodic'),
          countFrequency: selectedRequest || manualItem ? null : selectedFrequency,
          countId: selectedRequest?.id ?? null,
          lines,
          notes,
        });
        setMessage(
          result.recountCountId != null
            ? `${inventoryCountFolio(result.countId)} quedó aplicado. Hay ${result.varianceCount} ${result.varianceCount === 1 ? 'diferencia en bebidas' : 'diferencias en bebidas'}; completa ahora la segunda verificación ciega.`
            : `${inventoryCountFolio(result.countId)} enviado a revisión. La existencia ya quedó ajustada a lo contado.`,
        );
        setDrafts({});
        setNotes('');
        setSelectedRequestId(result.recountCountId ?? null);
        setManualItemId(null);
        setSelectedFrequency(null);
        setActiveGroup('all');
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo presentar el conteo.');
      }
    });
  }

  function openShift() {
    if (openShiftCount) {
      chooseRequest(openShiftCount.id);
      return;
    }

    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await openKitchenInventoryShiftAction({
          operationId: crypto.randomUUID(),
          businessDate: shiftBusinessDate,
        });
        setSelectedRequestId(result.countId);
        router.refresh();
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : 'No se pudo abrir el conteo por turno.');
      }
    });
  }

  function cancelOpenCount(count: KitchenOpenCount) {
    const folio = inventoryCountFolio(count.id);
    if (!window.confirm(`¿Eliminar ${folio}? Se quitará de los conteos abiertos y no modificará las existencias.`)) {
      return;
    }

    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        await cancelKitchenInventoryOpenCountAction({ countId: count.id });
        if (selectedRequestId === count.id) chooseRequest(null);
        setMessage(`${folio} fue eliminado de los conteos abiertos.`);
        router.refresh();
      } catch (cancelError) {
        setError(cancelError instanceof Error ? cancelError.message : 'No se pudo eliminar el conteo abierto.');
      }
    });
  }

  return (
    <section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold">Conteos ciegos</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
            Primero selecciona el tipo de inventario. Solo aparecerán los ítems configurados para ese momento y el saldo esperado permanecerá oculto.
          </p>
        </div>
        <span className="rounded-full border border-[#343444] px-3 py-1.5 text-sm text-[#C4C4CE]">
          Lista automática por turno
        </span>
      </div>

      <div className="mt-5 rounded-2xl border border-[#FEEF00]/30 bg-[#FEEF00]/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="font-bold text-[#FEEF00]">Conteo por turno</h3>
            <p className="mt-1 text-xs leading-5 text-[#C4C4CE]">
              Crudos, prefritos y salsas conservan su rutina. Bebidas muestra solo la ruta que corresponde por ciclo o porque requiere atención. Puedes registrar tantos conteos como ocurran durante el día.
            </p>
          </div>
          <label className="text-xs text-[#A6A6B2]">
            <span className="mb-1.5 block">Fecha operativa</span>
            <input
              type="date"
              value={shiftBusinessDate}
              min={shiftDateBounds.min}
              max={shiftDateBounds.max}
              onChange={(event) => setShiftBusinessDate(event.target.value)}
              disabled={isPending}
              className={inputClass}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={openShift}
            disabled={isPending || !shiftBusinessDate}
            className="min-h-14 flex-1 rounded-xl border border-[#FEEF00]/35 bg-[#111117] px-4 py-3 text-sm font-black text-[#FEEF00] disabled:opacity-50"
          >
            {openShiftCount ? 'Continuar conteo por turno' : 'Iniciar conteo por turno'}
          </button>
          <div className="rounded-xl border border-[#343444] bg-[#111117] px-4 py-3 text-sm text-[#C4C4CE]">
            {completedShiftCounts.length === 0
              ? 'Ningún conteo presentado en esta fecha'
              : `${completedShiftCounts.length} ${completedShiftCounts.length === 1 ? 'conteo presentado' : 'conteos presentados'} en esta fecha`}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-[#292938] bg-[#111117] p-4">
        <div>
          <h3 className="font-bold">Otros ciclos configurados</h3>
          <p className="mt-1 text-xs leading-5 text-[#A6A6B2]">
            Diario, semanal, quincenal o mensual. Cada opción toma automáticamente los ítems que Administración haya asignado a ese ciclo.
          </p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {configuredPeriodicPrograms.map((program) => (
            <button
              key={program.frequency}
              type="button"
              onClick={() => choosePeriodicProgram(program.frequency)}
              disabled={isPending || program.itemCount === 0}
              className={[
                'rounded-xl border p-3 text-left transition',
                selectedFrequency === program.frequency
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10'
                  : 'border-[#30303F] bg-[#15151D] hover:border-[#FEEF00]/50',
                'disabled:cursor-not-allowed disabled:opacity-45',
              ].join(' ')}
            >
              <div className="font-semibold text-[#F5F5F7]">{program.shortLabel}</div>
              <div className="mt-1 text-xs text-[#A6A6B2]">
                {program.itemCount === 0
                  ? 'Sin ítems configurados'
                  : `${program.itemCount} ítems · ${program.dueCount} pendientes`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {openCounts.length ? (
        <div className="mt-5 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
          <h3 className="font-bold text-amber-100">Conteos abiertos</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {openCounts.map((count) => (
              <div
                key={count.id}
                className="rounded-xl border border-amber-400/25 bg-[#111117] p-4 text-left"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                  <span>
                    {inventoryCountTitle({
                      countKind: count.countKind,
                      createdAt: count.createdAt,
                      shiftBusinessDate: count.shiftBusinessDate,
                    })}
                  </span>
                  {count.dueAt && new Date(count.dueAt).getTime() < scheduleNow ? (
                    <span className="rounded-full border border-red-400/35 bg-red-400/10 px-2 py-0.5 text-[11px] text-red-100">
                      Vencido
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-[#B9B9C4]">
                  {count.items.length} ítems
                  {count.countKind === 'shift_change'
                    ? ` · ${inventoryCountFolio(count.id)} · abierto por ${count.openedByName}`
                    : ` · vence ${formatDate(count.dueAt)}`}
                </div>
                {count.notes ? <div className="mt-2 text-xs leading-5 text-amber-100/80">{count.notes}</div> : null}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {count.canCancel ? (
                    <button
                      type="button"
                      onClick={() => cancelOpenCount(count)}
                      disabled={isPending}
                      className="rounded-lg border border-red-400/35 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-40"
                    >
                      Eliminar
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => chooseRequest(count.id)}
                    disabled={isPending}
                    className="rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs font-bold text-amber-100 disabled:opacity-40"
                  >
                    Continuar conteo
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#292938] bg-[#111117] p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-[#858591]">Conteo activo</div>
          <div className="mt-1 font-bold">
            {selectedRequest
              ? inventoryCountTitle({
                  countKind: selectedRequest.countKind,
                  createdAt: selectedRequest.createdAt,
                  shiftBusinessDate: selectedRequest.shiftBusinessDate,
                })
              : manualItem
                ? `Conteo puntual · ${manualItem.name}`
                : selectedFrequency
                  ? periodicPrograms.find((program) => program.frequency === selectedFrequency)?.label
                  : 'Selecciona el tipo de inventario'}
          </div>
        </div>
        {selectedRequest || selectedFrequency ? (
          <div className="flex flex-wrap gap-2">
            {selectedRequest?.canCancel ? (
              <button
                type="button"
                onClick={() => cancelOpenCount(selectedRequest)}
                disabled={isPending}
                className="rounded-xl border border-red-400/35 px-3 py-2 text-sm font-semibold text-red-200 disabled:opacity-40"
              >
                Eliminar conteo abierto
              </button>
            ) : null}
            <button type="button" onClick={() => chooseRequest(null)} className="rounded-xl border border-[#3A3A48] px-3 py-2 text-sm">
              Cerrar vista
            </button>
          </div>
        ) : (
          <label className="min-w-64 text-xs text-[#A6A6B2]">
            <span className="mb-1.5 block">Alcance</span>
            <select
              value={manualItemId ?? ''}
              onChange={(event) => {
                setManualItemId(event.target.value ? Number(event.target.value) : null);
                setSelectedFrequency(null);
                setActiveGroup('all');
                setDrafts({});
                setNotes('');
                setError(null);
                setMessage(null);
              }}
              disabled={isPending}
              className={inputClass}
            >
              <option value="">Sin conteo puntual</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>Puntual · {item.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error ? <Feedback tone="danger">{error}</Feedback> : null}
      {message ? <Feedback tone="good">{message}</Feedback> : null}

      {activeItems.length ? (
        <div className="mt-4 rounded-2xl border border-[#292938] bg-[#111117] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#F5F5F7]">
                Progreso: {countedItemCount} de {activeItems.length}
              </div>
              <div className="mt-1 text-xs text-[#858591]">
                Escribe 0 cuando no haya existencia. Puedes cambiar de familia sin perder lo contado.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setActiveGroup('all')}
                className={activeGroup === 'all'
                  ? 'rounded-full border border-[#FEEF00] bg-[#FEEF00] px-3 py-1.5 text-xs font-bold text-black'
                  : 'rounded-full border border-[#343444] px-3 py-1.5 text-xs text-[#C4C4CE]'}
              >
                Todas
              </button>
              {availableGroups.map((group) => {
                const groupItems = activeItems.filter((item) => item.inventoryGroup === group);
                const completed = groupItems.filter((item) => {
                  const total = countedTotal(item, drafts[item.id] ?? emptyDraft());
                  return total != null && Number.isFinite(total) && total >= 0;
                }).length;
                return (
                  <button
                    key={group}
                    type="button"
                    onClick={() => setActiveGroup(group)}
                    className={activeGroup === group
                      ? 'rounded-full border border-[#FEEF00] bg-[#FEEF00] px-3 py-1.5 text-xs font-bold text-black'
                      : 'rounded-full border border-[#343444] px-3 py-1.5 text-xs text-[#C4C4CE]'}
                  >
                    {groupLabels[group] ?? group} {completed}/{groupItems.length}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#242433]">
            <div
              className="h-full rounded-full bg-[#FEEF00] transition-all"
              style={{ width: `${activeItems.length ? (countedItemCount / activeItems.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {activeItems.length ? (
        <>
          <div className="mt-4 space-y-4">
            {visibleGroups.map(([group, groupItems]) => (
              <details key={group} open className="overflow-hidden rounded-2xl border border-[#292938] bg-[#111117]">
                <summary className="cursor-pointer bg-[#171720] px-4 py-3 font-bold">
                  {groupLabels[group] ?? group} · {groupItems.length}
                </summary>
                {group === 'beverages' ? (
                  <div className="space-y-3 p-3">
                    {beverageLocationGroups(groupItems).map(([locationCode, locationItems]) => (
                      <section key={locationCode} className="overflow-hidden rounded-xl border border-[#30303F] bg-[#0D0D12]">
                        <div className="border-b border-[#30303F] bg-[#15151D] px-4 py-2.5 text-sm font-semibold text-sky-200">
                          {beverageLocationLabels[locationCode] ?? 'Ruta de bebidas'} · {locationItems.length}
                        </div>
                        <div className="divide-y divide-[#292938]">
                          {locationItems.map((item) => (
                            <CountItemEditor
                              key={item.id}
                              item={item}
                              draft={draftFor(item.id)}
                              onChange={(patch) => updateDraft(item.id, patch)}
                              disabled={isPending}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-[#292938]">
                    {groupItems.map((item) => (
                      <CountItemEditor
                        key={item.id}
                        item={item}
                        draft={draftFor(item.id)}
                        onChange={(patch) => updateDraft(item.id, patch)}
                        disabled={isPending}
                      />
                    ))}
                  </div>
                )}
              </details>
            ))}
          </div>

          <div className="mt-5 rounded-2xl border border-[#292938] bg-[#111117] p-5">
            <label className="block text-sm text-[#C4C4CE]">
              <span className="mb-2 block">Nota general opcional</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={1000}
                rows={3}
                disabled={isPending}
                className={inputClass}
                placeholder="Ej.: una bolsa parecía traer menos unidades y fue recontada."
              />
            </label>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={submitCount}
                disabled={isPending || countedItemCount !== activeItems.length}
                className="rounded-xl bg-[#FEEF00] px-5 py-3 font-black text-black disabled:opacity-40"
              >
                {isPending
                  ? 'Presentando…'
                  : countedItemCount === activeItems.length
                    ? `Presentar ${activeItems.length} ítems`
                    : `Faltan ${activeItems.length - countedItemCount} ítems`}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">
          Selecciona un conteo por turno, un ciclo configurado, una solicitud abierta o un conteo puntual para comenzar.
        </div>
      )}

      <RecentCounts counts={recentCounts} />
    </section>
  );
}

function CountItemEditor({
  item,
  draft,
  onChange,
  disabled,
}: {
  item: KitchenCountItem;
  draft: ItemDraft;
  onChange: (patch: Partial<ItemDraft>) => void;
  disabled: boolean;
}) {
  const presentationMode = usesPresentations(item);
  const prefriedServiceAndUnits = usesPrefriedServiceAndUnits(item);
  const orderedPresentations = prefriedServiceAndUnits
    ? [...item.presentations].sort(
        (left, right) => right.baseUnitsPerPresentation - left.baseUnitsPerPresentation,
      )
    : item.presentations;
  const total = countedTotal(item, draft);
  const prefriedBreakdown = prefriedServiceAndUnits && total != null && Number.isFinite(total)
    ? prefriedCountBreakdown(item, total)
    : null;

  return (
    <article className="p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 lg:w-64">
          <div className="font-semibold">{item.name}</div>
          <div className="mt-1 text-xs text-[#858591]">Unidad canónica: {item.unitName}</div>
        </div>
        <div className="grid flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {presentationMode ? orderedPresentations.map((presentation) => (
            <label key={presentation.id} className="text-xs text-[#A6A6B2]">
              <span className="mb-1.5 block">
                {prefriedServiceAndUnits
                  ? presentation.baseUnitsPerPresentation === 1
                    ? 'Servicios completos'
                    : 'UND sueltas adicionales'
                  : `${presentation.name} × ${formatQuantity(presentation.baseUnitsPerPresentation)} ${item.unitName}`}
              </span>
              <input
                value={draft.presentationQuantities[presentation.id] ?? ''}
                onChange={(event) => onChange({
                  presentationQuantities: {
                    ...draft.presentationQuantities,
                    [presentation.id]: event.target.value,
                  },
                })}
                inputMode={prefriedServiceAndUnits ? 'numeric' : 'decimal'}
                min="0"
                step={prefriedServiceAndUnits ? '1' : 'any'}
                disabled={disabled}
                placeholder="0"
                className={inputClass}
              />
            </label>
          )) : null}
          {!prefriedServiceAndUnits ? (
            <label className="text-xs text-[#A6A6B2]">
              <span className="mb-1.5 block">{presentationMode ? `Sueltas (${item.unitName})` : `Cantidad (${item.unitName})`}</span>
              <input
                value={draft.baseUnits}
                onChange={(event) => onChange({ baseUnits: event.target.value })}
                inputMode="decimal"
                disabled={disabled}
                placeholder="0"
                className={inputClass}
              />
            </label>
          ) : null}
          <label className="text-xs text-[#A6A6B2]">
            <span className="mb-1.5 block">Nota opcional</span>
            <input
              value={draft.note}
              onChange={(event) => onChange({ note: event.target.value })}
              maxLength={1000}
              disabled={disabled}
              className={inputClass}
            />
          </label>
        </div>
      </div>
      <div className="mt-3 text-right text-sm font-semibold text-[#FEEF00]">
        Total contado: {total == null || !Number.isFinite(total)
          ? 'pendiente'
          : prefriedBreakdown ?? `${formatQuantity(total)} ${item.unitName}`}
        {prefriedBreakdown && total != null ? (
          <div className="mt-1 text-xs font-normal text-[#A6A6B2]">
            Equivale a {formatQuantity(total)} servicios en el sistema.
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Feedback({ tone, children }: { tone: 'good' | 'danger'; children: string }) {
  const classes = tone === 'good'
    ? 'border-emerald-400/30 bg-emerald-400/5 text-emerald-100'
    : 'border-red-400/30 bg-red-400/5 text-red-200';
  return <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${classes}`}>{children}</div>;
}

function RecentCounts({ counts }: { counts: KitchenRecentCount[] }) {
  return (
    <section className="mt-6 rounded-2xl border border-[#292938] bg-[#111117] p-5">
      <h3 className="font-bold">Conteos recientes</h3>
      <div className="mt-3 space-y-2">
        {counts.length ? counts.map((count) => (
          <div key={count.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#292938] bg-[#15151D] px-4 py-3 text-sm">
            <div>
              <div className="font-semibold">
                {inventoryCountTitle({
                  countKind: count.countKind,
                  createdAt: count.createdAt,
                  shiftBusinessDate: count.shiftBusinessDate,
                })}
              </div>
              <div className="mt-1 text-xs text-[#858591]">
                {count.countKind === 'shift_change' && count.shiftBusinessDate
                  ? `${inventoryCountFolio(count.id)} · abierto por ${count.openedByName} · presentado por ${count.submittedByName} ${formatDate(count.submittedAt)}`
                  : `${inventoryCountFolio(count.id)} · ${formatDate(count.submittedAt ?? count.createdAt)}`}
              </div>
            </div>
            <span className="rounded-full border border-[#3A3A48] px-2.5 py-1 text-xs text-[#C4C4CE]">
              {statusLabels[count.status] ?? count.status}
            </span>
          </div>
        )) : (
          <div className="rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">
            Todavía no hay conteos operativos registrados.
          </div>
        )}
      </div>
    </section>
  );
}
