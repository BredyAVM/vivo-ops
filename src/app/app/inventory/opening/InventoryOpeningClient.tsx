'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import { submitInventoryOpeningAction } from '../actions';

export type InventoryOpeningItem = {
  id: number;
  name: string;
  inventoryGroup: string;
  unitName: string;
  trackingMode: string;
  openingStatus: 'pending' | 'under_review' | 'accepted';
  inventoryCountId: number | null;
};

type Props = {
  items: InventoryOpeningItem[];
  isAdmin: boolean;
};

const groupLabels: Record<string, string> = {
  raw: 'Producto crudo',
  prefried: 'Prefritos',
  sauces: 'Salsas',
  beverages: 'Bebidas',
  packaging: 'Empaque',
  other: 'Otros',
};

const statusLabels: Record<InventoryOpeningItem['openingStatus'], string> = {
  pending: 'Pendiente',
  under_review: 'En revisión',
  accepted: 'Aceptado',
};

function statusClass(status: InventoryOpeningItem['openingStatus']) {
  if (status === 'accepted') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
  if (status === 'under_review') return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
  return 'border-[#343444] bg-[#171720] text-[#B6B6C2]';
}

export default function InventoryOpeningClient({ items, isAdmin }: Props) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [query, setQuery] = useState('');
  const [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const normalizedQuery = query.trim().toLocaleLowerCase('es');
  const visibleItems = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) =>
            `${item.name} ${groupLabels[item.inventoryGroup] ?? item.inventoryGroup}`
              .toLocaleLowerCase('es')
              .includes(normalizedQuery),
          )
        : items,
    [items, normalizedQuery],
  );

  const filledPendingCount = useMemo(
    () =>
      items.reduce((total, item) => {
        if (item.openingStatus !== 'pending') return total;
        return String(quantities[item.id] ?? '').trim() ? total + 1 : total;
      }, 0),
    [items, quantities],
  );

  function handleSubmit() {
    setError(null);
    let validationError: string | null = null;
    const lines = items.flatMap((item) => {
      if (item.openingStatus !== 'pending') return [];
      const rawQuantity = String(quantities[item.id] ?? '').trim();
      if (!rawQuantity) return [];
      const quantity = parseDecimalInput(rawQuantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        validationError = `Revisa la cantidad contada de “${item.name}”.`;
        return [];
      }
      return [{ inventoryItemId: item.id, countedQuantityUnits: quantity }];
    });

    if (validationError) {
      setError(validationError);
      return;
    }
    if (lines.length === 0) {
      setError('Escribe al menos una cantidad física para presentar el conteo.');
      return;
    }
    if (!maintenanceConfirmed) {
      setError('Confirma primero la ventana de apertura sin entregas activas.');
      return;
    }

    startTransition(async () => {
      try {
        const result = await submitInventoryOpeningAction({
          operationId: crypto.randomUUID(),
          lines,
          notes,
        });
        router.push(`/app/inventory/counts/${result.countId}`);
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo presentar el conteo.');
      }
    });
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm text-amber-100">
        <div className="font-semibold">Ventana controlada de apertura</div>
        <p className="mt-1 max-w-4xl leading-6 text-amber-100/75">
          Desde el primer lote presentado y hasta aceptar todos los ítems, no deben cerrarse entregas. El
          sistema entra en transición y el consumo automático se enciende solamente al completar los{' '}
          {items.length} ítems aceptados que hoy forman el catálogo inventariable.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#111117] p-4 lg:flex-row lg:items-end lg:justify-between">
        <label className="block w-full max-w-xl text-sm">
          <span className="mb-2 block text-[#A6A6B2]">Buscar ítem</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. tequeños, salsa o bebida"
            className="w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70"
          />
        </label>
        <div className="text-sm text-[#92929F]">
          {visibleItems.length} ítems visibles · {filledPendingCount} con cantidad escrita
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
              <tr>
                <th className="px-4 py-3">Ítem</th>
                <th className="px-4 py-3">Grupo</th>
                <th className="px-4 py-3">Unidad</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Cantidad física</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#242433]">
              {visibleItems.map((item) => (
                <tr key={item.id} className="hover:bg-[#15151D]">
                  <td className="px-4 py-3 font-semibold">{item.name}</td>
                  <td className="px-4 py-3 text-[#A6A6B2]">
                    {groupLabels[item.inventoryGroup] ?? item.inventoryGroup}
                  </td>
                  <td className="px-4 py-3 text-[#A6A6B2]">{item.unitName}</td>
                  <td className="px-4 py-3">
                    {item.inventoryCountId != null ? (
                      <Link
                        href={`/app/inventory/counts/${item.inventoryCountId}`}
                        prefetch={false}
                        className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(item.openingStatus)}`}
                      >
                        {statusLabels[item.openingStatus]} · #{item.inventoryCountId}
                      </Link>
                    ) : (
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(item.openingStatus)}`}>
                        {statusLabels[item.openingStatus]}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {item.openingStatus === 'pending' && isAdmin ? (
                      <input
                        aria-label={`Cantidad física de ${item.name}`}
                        type="text"
                        inputMode="decimal"
                        value={quantities[item.id] ?? ''}
                        onChange={(event) =>
                          setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        disabled={isPending}
                        placeholder="Conteo ciego"
                        className="w-40 rounded-lg border border-[#343444] bg-[#0D0D12] px-3 py-2 text-right font-semibold text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
                      />
                    ) : item.openingStatus === 'pending' ? (
                      <span className="text-[#7F7F8C]">Requiere administración</span>
                    ) : (
                      <span className="text-[#7F7F8C]">Ya presentado</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin ? (
        <div className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <label className="block text-sm">
            <span className="mb-2 block text-[#A6A6B2]">Nota del lote (opcional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={1000}
              rows={3}
              disabled={isPending}
              className="w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
            />
          </label>

          <label className="mt-4 flex items-start gap-3 text-sm text-[#C7C7D0]">
            <input
              type="checkbox"
              checked={maintenanceConfirmed}
              onChange={(event) => setMaintenanceConfirmed(event.target.checked)}
              disabled={isPending}
              className="mt-0.5 h-4 w-4 accent-[#FEEF00]"
            />
            <span>Confirmo que no se cerrarán entregas durante esta ventana física de apertura.</span>
          </label>

          {error ? (
            <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-[#858591]">
              No se muestra la existencia previa. Al presentar, el saldo pasa a lo contado y Master puede
              aceptar o pedir reconteos selectivos.
            </p>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isPending || filledPendingCount === 0 || !maintenanceConfirmed}
              className="rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPending ? 'Presentando…' : `Presentar ${filledPendingCount} ítems`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
