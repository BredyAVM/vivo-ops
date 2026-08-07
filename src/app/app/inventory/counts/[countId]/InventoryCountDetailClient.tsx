'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { reviewInventoryCountAction, submitInventoryOpenCountAction } from '../../actions';

export type InventoryCountDetail = {
  id: number;
  countKind: string;
  status: string;
  responsibleRole: string;
  parentCountId: number | null;
  notes: string | null;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
};

export type InventoryCountDetailLine = {
  id: number;
  inventoryItemId: number;
  itemName: string;
  unitName: string;
  expectedQuantityUnits: number;
  countedQuantityUnits: number | null;
  differenceQuantityUnits: number | null;
  lineStatus: string;
  note: string | null;
};

export type InventoryCountChild = {
  id: number;
  status: string;
};

type Props = {
  count: InventoryCountDetail;
  lines: InventoryCountDetailLine[];
  childrenCounts: InventoryCountChild[];
  isAdmin: boolean;
};

const kindLabels: Record<string, string> = {
  opening: 'Apertura física',
  shift_change: 'Cambio de turno',
  requested: 'Solicitado',
  recount: 'Reconteo',
  periodic: 'Periódico',
};

const statusLabels: Record<string, string> = {
  open: 'Abierto',
  submitted: 'En revisión',
  accepted: 'Aceptado',
  recount_requested: 'Reconteo solicitado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function formatQuantity(value: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function differenceClass(value: number | null) {
  if (value == null || value === 0) return 'text-[#A6A6B2]';
  return value > 0 ? 'text-emerald-300' : 'text-red-300';
}

export default function InventoryCountDetailClient({ count, lines, childrenCounts, isAdmin }: Props) {
  const router = useRouter();
  const [selectedLineIds, setSelectedLineIds] = useState<Set<number>>(() => new Set());
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submittedLineIds = useMemo(
    () => lines.filter((line) => line.lineStatus === 'submitted').map((line) => line.id),
    [lines],
  );
  const canSubmitOpen =
    isAdmin &&
    count.status === 'open' &&
    ['recount', 'requested', 'periodic', 'shift_change'].includes(count.countKind);

  function toggleLine(lineId: number) {
    setSelectedLineIds((current) => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  function handleOpenCountSubmit() {
    setError(null);
    let validationError: string | null = null;
    const submittedLines = lines.flatMap((line) => {
      const rawQuantity = String(quantities[line.id] ?? '').trim().replace(',', '.');
      if (!rawQuantity) {
        validationError = `Falta contar “${line.itemName}”.`;
        return [];
      }
      const quantity = Number(rawQuantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        validationError = `Revisa la cantidad de “${line.itemName}”.`;
        return [];
      }
      return [{ inventoryItemId: line.inventoryItemId, countedQuantityUnits: quantity }];
    });

    if (validationError) {
      setError(validationError);
      return;
    }

    startTransition(async () => {
      try {
        await submitInventoryOpenCountAction({
          operationId: crypto.randomUUID(),
          countId: count.id,
          countKind: count.countKind as 'recount' | 'requested' | 'periodic' | 'shift_change',
          lines: submittedLines,
          notes,
        });
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo presentar el conteo.');
      }
    });
  }

  function handleReview(action: 'accept' | 'request_recount') {
    setError(null);
    if (action === 'request_recount' && selectedLineIds.size === 0) {
      setError('Selecciona al menos un ítem para solicitar el reconteo.');
      return;
    }

    startTransition(async () => {
      try {
        const result = await reviewInventoryCountAction({
          countId: count.id,
          action,
          lineIds: action === 'request_recount' ? Array.from(selectedLineIds) : undefined,
          notes,
        });
        if (result.recountCountId != null) {
          router.push(`/app/inventory/counts/${result.recountCountId}`);
        }
        router.refresh();
      } catch (reviewError) {
        setError(reviewError instanceof Error ? reviewError.message : 'No se pudo revisar el conteo.');
      }
    });
  }

  return (
    <section>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-sm text-[#8F8F9C]">{kindLabels[count.countKind] ?? count.countKind}</div>
          <h2 className="mt-1 text-2xl font-semibold">Conteo #{count.id}</h2>
          <p className="mt-2 text-sm text-[#9696A3]">
            Creado {formatDate(count.createdAt)} · Responsable {count.responsibleRole.toUpperCase()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-[#343444] bg-[#171720] px-3 py-1 text-sm text-[#D1D1DA]">
            {statusLabels[count.status] ?? count.status}
          </span>
          <Link
            href="/app/inventory/counts"
            prefetch={false}
            className="rounded-xl border border-[#343444] px-3 py-1.5 text-sm text-[#B7B7C2]"
          >
            Historial
          </Link>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <InfoCard label="Presentado" value={formatDate(count.submittedAt)} />
        <InfoCard label="Revisado" value={formatDate(count.reviewedAt)} />
        <InfoCard label="Líneas" value={String(lines.length)} />
      </div>

      {count.parentCountId != null || childrenCounts.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2 rounded-2xl border border-[#242433] bg-[#111117] p-4 text-sm">
          {count.parentCountId != null ? (
            <Link href={`/app/inventory/counts/${count.parentCountId}`} prefetch={false} className="text-[#FEEF00]">
              Conteo padre #{count.parentCountId}
            </Link>
          ) : null}
          {childrenCounts.map((child) => (
            <Link key={child.id} href={`/app/inventory/counts/${child.id}`} prefetch={false} className="text-sky-300">
              Reconteo #{child.id} · {statusLabels[child.status] ?? child.status}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
              <tr>
                {count.status === 'submitted' ? <th className="w-12 px-4 py-3">Recontar</th> : null}
                <th className="px-4 py-3">Ítem</th>
                <th className="px-4 py-3">Unidad</th>
                <th className="px-4 py-3 text-right">Sistema</th>
                <th className="px-4 py-3 text-right">Contado</th>
                <th className="px-4 py-3 text-right">Diferencia</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Nota</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#242433]">
              {lines.map((line) => (
                <tr key={line.id} className="hover:bg-[#15151D]">
                  {count.status === 'submitted' ? (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Solicitar reconteo de ${line.itemName}`}
                        checked={selectedLineIds.has(line.id)}
                        onChange={() => toggleLine(line.id)}
                        disabled={line.lineStatus !== 'submitted' || isPending}
                        className="h-4 w-4 accent-[#FEEF00]"
                      />
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-semibold">{line.itemName}</td>
                  <td className="px-4 py-3 text-[#A6A6B2]">{line.unitName}</td>
                  <td className="px-4 py-3 text-right text-[#A6A6B2]">
                    {count.status === 'open' ? 'Oculto' : formatQuantity(line.expectedQuantityUnits)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {canSubmitOpen ? (
                      <input
                        aria-label={`Cantidad contada de ${line.itemName}`}
                        type="text"
                        inputMode="decimal"
                        value={quantities[line.id] ?? ''}
                        onChange={(event) =>
                          setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                        }
                        disabled={isPending}
                        placeholder="Conteo ciego"
                        className="w-36 rounded-lg border border-[#343444] bg-[#0D0D12] px-3 py-2 text-right text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
                      />
                    ) : formatQuantity(line.countedQuantityUnits)}
                  </td>
                  <td className={`px-4 py-3 text-right font-semibold ${differenceClass(line.differenceQuantityUnits)}`}>
                    {count.status === 'open' ? '—' : formatQuantity(line.differenceQuantityUnits)}
                  </td>
                  <td className="px-4 py-3 text-[#A6A6B2]">{statusLabels[line.lineStatus] ?? line.lineStatus}</td>
                  <td className="max-w-xs px-4 py-3 text-[#A6A6B2]">{line.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {count.notes ? (
        <div className="mt-4 rounded-2xl border border-[#242433] bg-[#111117] p-4 text-sm text-[#C6C6CF]">
          <div className="mb-1 text-xs uppercase tracking-wide text-[#858591]">Notas registradas</div>
          <div className="whitespace-pre-wrap">{count.notes}</div>
        </div>
      ) : null}

      {canSubmitOpen || count.status === 'submitted' ? (
        <div className="mt-5 rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <label className="block text-sm">
            <span className="mb-2 block text-[#A6A6B2]">Nota de esta acción (opcional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={1000}
              rows={3}
              disabled={isPending}
              className="w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
            />
          </label>

          {error ? (
            <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-3">
            {canSubmitOpen ? (
              <button
                type="button"
                onClick={handleOpenCountSubmit}
                disabled={isPending}
                className="rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40"
              >
                {isPending ? 'Presentando…' : 'Presentar reconteo'}
              </button>
            ) : null}
            {count.status === 'submitted' ? (
              <>
                <button
                  type="button"
                  onClick={() => handleReview('request_recount')}
                  disabled={isPending || selectedLineIds.size === 0}
                  className="rounded-xl border border-amber-400/40 px-4 py-2.5 text-sm font-semibold text-amber-200 disabled:opacity-40"
                >
                  Solicitar reconteo ({selectedLineIds.size})
                </button>
                <button
                  type="button"
                  onClick={() => handleReview('accept')}
                  disabled={isPending || submittedLineIds.length === 0}
                  className="rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40"
                >
                  {isPending ? 'Procesando…' : 'Aceptar conteo completo'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className="mt-2 font-semibold text-white">{value}</div>
    </div>
  );
}
