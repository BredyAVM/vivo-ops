'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { parseDecimalInput } from '@/lib/number-input';
import {
  adjustInventoryStockAction,
  submitInventoryAdministrativeCountAction,
} from '../actions';

export type InventoryAdminPilotItem = {
  id: number;
  name: string;
  unitName: string;
  inventoryGroup: string;
  currentStockUnits: number;
};

export type InventoryAdminPilotMovement = {
  id: number;
  inventoryItemId: number;
  inventoryItemName: string;
  movementType: 'manual_adjustment' | 'stock_count';
  quantityUnits: number;
  reasonCode: string | null;
  notes: string | null;
  operationId: string;
  createdAt: string;
};

const inputClass = 'w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';

const reasonOptions = [
  { value: 'physical_verification', label: 'Verificación física' },
  { value: 'late_entry', label: 'Entrada no registrada a tiempo' },
  { value: 'data_recovery', label: 'Recuperación o corrección de datos' },
  { value: 'pilot_validation', label: 'Prueba controlada del piloto' },
  { value: 'other', label: 'Otro motivo administrativo' },
];

function quantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

export default function InventoryAdminPilotClient({
  items,
  movements,
}: {
  items: InventoryAdminPilotItem[];
  movements: InventoryAdminPilotMovement[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'count' | 'adjustment'>('count');
  const [itemId, setItemId] = useState(items[0]?.id ? String(items[0].id) : '');
  const [targetQuantity, setTargetQuantity] = useState('');
  const [reasonCode, setReasonCode] = useState('physical_verification');
  const [notes, setNotes] = useState('');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedItem = items.find((item) => item.id === Number(itemId)) ?? null;
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('es');
    return normalized
      ? items.filter((item) => `${item.name} ${item.inventoryGroup}`.toLocaleLowerCase('es').includes(normalized))
      : items;
  }, [items, query]);

  function submit() {
    setMessage(null);
    setError(null);
    const parsedQuantity = parseDecimalInput(targetQuantity);
    if (!selectedItem || !Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
      setError('Selecciona un ítem e indica una cantidad física mayor o igual a cero.');
      return;
    }

    startTransition(async () => {
      try {
        if (mode === 'count') {
          const result = await submitInventoryAdministrativeCountAction({
            operationId: crypto.randomUUID(),
            lines: [{
              inventoryItemId: selectedItem.id,
              countedQuantityUnits: parsedQuantity,
              note: notes,
            }],
            notes: notes || 'Conteo físico puntual registrado desde el piloto administrativo.',
          });
          setMessage(`Conteo #${result.countId} registrado. El saldo ya refleja ${quantity(parsedQuantity)} ${selectedItem.unitName}.`);
        } else {
          await adjustInventoryStockAction({
            operationId: crypto.randomUUID(),
            inventoryItemId: selectedItem.id,
            targetQuantityUnits: parsedQuantity,
            reasonCode,
            notes,
          });
          setMessage(`Ajuste aplicado. El saldo de ${selectedItem.name} ahora refleja ${quantity(parsedQuantity)} ${selectedItem.unitName}.`);
        }
        setTargetQuantity('');
        setNotes('');
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo registrar la operación.');
      }
    });
  }

  return (
    <section>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Ajustes y conteos de prueba</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#9696A3]">
            Herramienta administrativa para mantener saldos reales durante el piloto. Ambas opciones escriben
            trazabilidad canónica y actualizan alertas; ninguna bloquea órdenes.
          </p>
        </div>
        <Link href="/app/inventory/reports" prefetch={false} className="rounded-xl border border-[#343442] px-4 py-2 text-sm font-semibold text-[#D5D5DE]">
          Ver trazabilidad completa
        </Link>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode('count')} className={mode === 'count' ? 'rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-bold text-black' : 'rounded-xl border border-[#343442] px-3 py-2 text-sm font-semibold'}>
              Conteo físico
            </button>
            <button type="button" onClick={() => setMode('adjustment')} className={mode === 'adjustment' ? 'rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-bold text-black' : 'rounded-xl border border-[#343442] px-3 py-2 text-sm font-semibold'}>
              Ajuste administrativo
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-sky-400/25 bg-sky-400/5 px-3 py-3 text-xs leading-5 text-sky-100">
            {mode === 'count'
              ? 'Recomendado cuando alguien verificó físicamente la cantidad. Crea un reporte de conteo y alinea el saldo de inmediato.'
              : 'Úsalo para corregir un dato conocido sin presentarlo como conteo físico. El motivo queda en el movimiento.'}
          </div>

          <label className="mt-4 block text-xs text-[#A6A6B2]">
            Buscar ítem
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej. tequeños, salsa o Pepsi" className={`${inputClass} mt-1`} />
          </label>
          <label className="mt-3 block text-xs text-[#A6A6B2]">
            Ítem inventariable
            <select value={itemId} onChange={(event) => setItemId(event.target.value)} className={`${inputClass} mt-1`}>
              {visibleItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          {selectedItem ? (
            <div className="mt-3 rounded-xl border border-[#292938] bg-[#15151D] p-4">
              <div className="text-xs uppercase tracking-wide text-[#858591]">Saldo del sistema</div>
              <div className={`mt-2 text-2xl font-semibold ${selectedItem.currentStockUnits < 0 ? 'text-red-300' : 'text-white'}`}>
                {quantity(selectedItem.currentStockUnits)} {selectedItem.unitName}
              </div>
            </div>
          ) : null}

          <label className="mt-3 block text-xs text-[#A6A6B2]">
            {mode === 'count' ? 'Cantidad física contada' : 'Existencia objetivo'}
            <input value={targetQuantity} onChange={(event) => setTargetQuantity(event.target.value)} inputMode="decimal" placeholder="0" disabled={isPending} className={`${inputClass} mt-1 text-right font-semibold`} />
          </label>

          {mode === 'adjustment' ? (
            <label className="mt-3 block text-xs text-[#A6A6B2]">
              Motivo obligatorio
              <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} disabled={isPending} className={`${inputClass} mt-1`}>
                {reasonOptions.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
              </select>
            </label>
          ) : null}

          <label className="mt-3 block text-xs text-[#A6A6B2]">
            Nota o evidencia textual (opcional)
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} disabled={isPending} className={`${inputClass} mt-1`} />
          </label>

          {message ? <div className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">{message}</div> : null}
          {error ? <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">{error}</div> : null}

          <button type="button" onClick={submit} disabled={isPending || !selectedItem || !targetQuantity.trim()} className="mt-4 w-full rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40">
            {isPending ? 'Registrando…' : mode === 'count' ? 'Registrar conteo y actualizar saldo' : 'Aplicar ajuste trazable'}
          </button>
        </article>

        <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
          <h3 className="font-semibold">Actividad administrativa reciente</h3>
          <p className="mt-1 text-xs leading-5 text-[#858591]">Los conteos muestran su diferencia aplicada; los ajustes conservan motivo y operación idempotente.</p>
          <div className="mt-4 space-y-3">
            {movements.length ? movements.map((movement) => (
              <div key={movement.id} className="rounded-xl border border-[#292938] bg-[#15151D] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{movement.inventoryItemName}</div>
                    <div className="mt-1 text-xs text-[#92929F]">{dateTime(movement.createdAt)} · {movement.movementType === 'stock_count' ? 'Conteo físico' : 'Ajuste administrativo'}</div>
                  </div>
                  <div className={`font-semibold ${movement.quantityUnits < 0 ? 'text-red-300' : movement.quantityUnits > 0 ? 'text-emerald-300' : 'text-[#A6A6B2]'}`}>
                    {movement.quantityUnits > 0 ? '+' : ''}{quantity(movement.quantityUnits)}
                  </div>
                </div>
                <div className="mt-2 text-xs text-[#A6A6B2]">{movement.notes || movement.reasonCode || 'Sin nota adicional'}</div>
                <div className="mt-2 font-mono text-[11px] text-[#71717E]">{movement.operationId.slice(0, 8)}</div>
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-[#343444] px-4 py-10 text-center text-sm text-[#858591]">No hay ajustes ni conteos recientes.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
