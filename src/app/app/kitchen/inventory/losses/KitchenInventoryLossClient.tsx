'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { parseDecimalInput } from '@/lib/number-input';
import { recordKitchenInventoryLossAction } from '../actions';

type LossKind = 'damage' | 'waste' | 'quality_taste';

export type KitchenLossItem = {
  id: number;
  name: string;
  unitName: string;
  inventoryGroup: string;
};

export type KitchenLossMovement = {
  id: number;
  inventoryItemId: number;
  itemName: string;
  unitName: string;
  lossKind: LossKind;
  quantityUnits: number;
  notes: string | null;
  createdAt: string;
};

const lossKinds: Array<{
  value: LossKind;
  title: string;
  detail: string;
}> = [
  {
    value: 'damage',
    title: 'Avería',
    detail: 'Unidad que se frió y no cumple el estándar de calidad.',
  },
  {
    value: 'waste',
    title: 'Merma',
    detail: 'Unidad cruda apartada antes de freír por su aspecto.',
  },
  {
    value: 'quality_taste',
    title: 'Prueba de calidad',
    detail: 'Cantidad exacta utilizada por el personal para comprobar calidad.',
  },
];

const groupLabels: Record<string, string> = {
  raw: 'Crudos',
  prefried: 'Prefritos',
  sauces: 'Salsas y bases',
  other: 'Bebidas y otros',
};

const inputClass = 'w-full rounded-xl border border-[#343444] bg-[#0B0B10] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70';

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

export default function KitchenInventoryLossClient({
  items,
  movements,
}: {
  items: KitchenLossItem[];
  movements: KitchenLossMovement[];
}) {
  const router = useRouter();
  const [lossKind, setLossKind] = useState<LossKind>('damage');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedItem = items.find((item) => item.id === Number(itemId));
  const groupedItems = useMemo(() => {
    const groups = new Map<string, KitchenLossItem[]>();
    for (const item of items) {
      const groupItems = groups.get(item.inventoryGroup) ?? [];
      groupItems.push(item);
      groups.set(item.inventoryGroup, groupItems);
    }
    return Array.from(groups.entries());
  }, [items]);

  function submitLoss() {
    setError(null);
    setMessage(null);
    const parsedQuantity = parseDecimalInput(quantity);
    if (!selectedItem) {
      setError('Selecciona el producto afectado.');
      return;
    }
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setError('Escribe una cantidad mayor que cero.');
      return;
    }

    startTransition(async () => {
      try {
        await recordKitchenInventoryLossAction({
          operationId: crypto.randomUUID(),
          inventoryItemId: selectedItem.id,
          lossKind,
          quantityUnits: parsedQuantity,
          notes,
        });
        const label = lossKinds.find((kind) => kind.value === lossKind)?.title ?? 'Salida';
        setMessage(`${label} registrada: ${formatQuantity(parsedQuantity)} ${selectedItem.unitName} de ${selectedItem.name}.`);
        setItemId('');
        setQuantity('');
        setNotes('');
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo registrar la salida.');
      }
    });
  }

  return (
    <section>
      <div>
        <h2 className="text-xl font-bold">Averías, mermas y pruebas</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
          La cantidad sale del inventario inmediatamente. No requiere fotografía, explicación ni aprobación previa; la nota es opcional.
        </p>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {lossKinds.map((kind) => (
          <button
            key={kind.value}
            type="button"
            onClick={() => setLossKind(kind.value)}
            disabled={isPending}
            className={`rounded-2xl border p-4 text-left ${
              lossKind === kind.value
                ? 'border-[#FEEF00]/70 bg-[#FEEF00]/10'
                : 'border-[#292938] bg-[#111117]'
            }`}
          >
            <div className="font-bold">{kind.title}</div>
            <div className="mt-1 text-xs leading-5 text-[#A6A6B2]">{kind.detail}</div>
          </button>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-[#292938] bg-[#111117] p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-[#C4C4CE]">
            <span className="mb-2 block">Producto afectado</span>
            <select value={itemId} onChange={(event) => setItemId(event.target.value)} disabled={isPending} className={inputClass}>
              <option value="">Seleccionar…</option>
              {groupedItems.map(([group, groupItems]) => (
                <optgroup key={group} label={groupLabels[group] ?? group}>
                  {groupItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-sm text-[#C4C4CE]">
            <span className="mb-2 block">Cantidad exacta {selectedItem ? `(${selectedItem.unitName})` : ''}</span>
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="decimal"
              disabled={isPending}
              placeholder="Ej. 3"
              className={inputClass}
            />
          </label>
        </div>
        <label className="mt-4 block text-sm text-[#C4C4CE]">
          <span className="mb-2 block">Nota opcional</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
            rows={3}
            disabled={isPending}
            className={inputClass}
          />
        </label>

        {error ? <Feedback tone="danger">{error}</Feedback> : null}
        {message ? <Feedback tone="good">{message}</Feedback> : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={submitLoss}
            disabled={isPending}
            className="rounded-xl bg-[#FEEF00] px-5 py-3 font-black text-black disabled:opacity-40"
          >
            {isPending ? 'Registrando…' : `Registrar ${lossKinds.find((kind) => kind.value === lossKind)?.title.toLowerCase()}`}
          </button>
        </div>
      </div>

      <section className="mt-6 rounded-2xl border border-[#292938] bg-[#111117] p-5">
        <h3 className="font-bold">Registros recientes</h3>
        <div className="mt-3 space-y-2">
          {movements.length ? movements.map((movement) => (
            <div key={movement.id} className="rounded-xl border border-[#292938] bg-[#15151D] px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{movement.itemName}</span>
                <span className="rounded-full border border-[#3A3A48] px-2.5 py-1 text-xs">
                  {lossKinds.find((kind) => kind.value === movement.lossKind)?.title}
                </span>
              </div>
              <div className="mt-1 text-xs text-[#A6A6B2]">
                {formatQuantity(movement.quantityUnits)} {movement.unitName} · {formatDate(movement.createdAt)}
              </div>
              {movement.notes ? <div className="mt-2 text-xs text-[#C4C4CE]">{movement.notes}</div> : null}
            </div>
          )) : (
            <div className="rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">
              Todavía no hay averías, mermas ni pruebas registradas.
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function Feedback({ tone, children }: { tone: 'good' | 'danger'; children: string }) {
  const classes = tone === 'good'
    ? 'border-emerald-400/30 bg-emerald-400/5 text-emerald-100'
    : 'border-red-400/30 bg-red-400/5 text-red-200';
  return <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${classes}`}>{children}</div>;
}
