'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import {
  dispatchInventoryForEventAction,
  reconcileInventoryEventAction,
} from '../actions';

export type InventoryEventItem = {
  id: number;
  name: string;
  unitName: string;
  currentStockUnits: number;
};

export type InventoryEventOrder = {
  id: number;
  orderNumber: string;
  status: string;
};

export type InventoryEventDispatchLine = {
  inventoryItemId: number;
  inventoryItemName: string;
  unitName: string;
  dispatchedQuantityUnits: number;
  committedQuantityUnits: number;
  reservedExcessUnits: number;
};

export type InventoryEventDispatch = {
  eventId: number;
  orderId: number;
  orderNumber: string;
  dispatchOperationId: string;
  createdAt: string;
  notes: string | null;
  reconciled: boolean;
  lines: InventoryEventDispatchLine[];
};

type DispatchDraftLine = { key: string; inventoryItemId: string; quantityUnits: string };
type Section = 'dispatch' | 'reconcile' | 'history';

const INPUT_CLASS = 'w-full rounded-xl border border-[#343444] bg-[#0B0B10] px-3 py-2.5 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';
const PRIMARY_BUTTON = 'rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40';
const SECONDARY_BUTTON = 'rounded-xl border border-[#383847] bg-[#17171F] px-4 py-2.5 text-sm font-semibold text-[#D7D7DF] disabled:opacity-40';

function newLine(): DispatchDraftLine {
  return { key: crypto.randomUUID(), inventoryItemId: '', quantityUnits: '' };
}

function quantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

export default function InventoryEventWorkspaceClient({
  items,
  orders,
  dispatches,
}: {
  items: InventoryEventItem[];
  orders: InventoryEventOrder[];
  dispatches: InventoryEventDispatch[];
}) {
  const [section, setSection] = useState<Section>('dispatch');
  const pendingDispatches = dispatches.filter((dispatch) => !dispatch.reconciled);

  return (
    <section className="mt-6 rounded-2xl border border-[#2D2940] bg-[#111019] p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-200">Eventos</div>
          <h2 className="mt-1 text-lg font-semibold">Despacho y regreso de mercancía</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
            El despacho reserva únicamente el excedente llevado sobre lo ya comprometido por la orden.
            Al regresar se registran devoluciones y pérdidas; la venta se descuenta una sola vez al entregar.
          </p>
        </div>
        <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-100">
          No bloquea órdenes · no duplica consumo
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Operaciones de eventos">
        <Tab active={section === 'dispatch'} onClick={() => setSection('dispatch')}>Registrar despacho</Tab>
        <Tab active={section === 'reconcile'} onClick={() => setSection('reconcile')}>Conciliar regreso ({pendingDispatches.length})</Tab>
        <Tab active={section === 'history'} onClick={() => setSection('history')}>Historial</Tab>
      </div>

      {section === 'dispatch' ? <DispatchForm items={items} orders={orders} /> : null}
      {section === 'reconcile' ? <ReconciliationSelector dispatches={pendingDispatches} /> : null}
      {section === 'history' ? <DispatchHistory dispatches={dispatches} /> : null}
    </section>
  );
}

function DispatchForm({ items, orders }: { items: InventoryEventItem[]; orders: InventoryEventOrder[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [orderId, setOrderId] = useState('');
  const [lines, setLines] = useState<DispatchDraftLine[]>([newLine()]);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setMessage(null);
    setError(null);
    if (!orderId) return setError('Selecciona la orden del evento.');
    startTransition(async () => {
      try {
        await dispatchInventoryForEventAction({
          operationId: crypto.randomUUID(),
          orderId: Number(orderId),
          lines: lines.map((line) => ({
            inventoryItemId: Number(line.inventoryItemId),
            quantityUnits: parseDecimalInput(line.quantityUnits),
          })),
          notes,
        });
        setMessage('Despacho registrado. El excedente quedó reservado hasta la conciliación.');
        setOrderId('');
        setLines([newLine()]);
        setNotes('');
        router.refresh();
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : 'No se pudo registrar el despacho.');
      }
    });
  }

  return (
    <div className="mt-5 rounded-xl border border-[#302D3F] bg-[#15131D] p-4">
      <label className="text-sm text-[#C4C4CE]">
        <span className="mb-2 block">Orden del evento</span>
        <select value={orderId} onChange={(event) => setOrderId(event.target.value)} disabled={isPending} className={INPUT_CLASS}>
          <option value="">Seleccionar orden…</option>
          {orders.map((order) => <option key={order.id} value={order.id}>{order.orderNumber} · {order.status}</option>)}
        </select>
      </label>

      <div className="mt-4 space-y-3">
        {lines.map((line) => {
          const selectedItem = items.find((item) => item.id === Number(line.inventoryItemId));
          return (
            <div key={line.key} className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
              <select value={line.inventoryItemId} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, inventoryItemId: event.target.value } : candidate))} disabled={isPending} className={INPUT_CLASS}>
                <option value="">Ítem físico…</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.name} · disponible {quantity(item.currentStockUnits)} {item.unitName}</option>)}
              </select>
              <input value={line.quantityUnits} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, quantityUnits: event.target.value } : candidate))} inputMode="decimal" placeholder={selectedItem ? `Cantidad (${selectedItem.unitName})` : 'Cantidad'} disabled={isPending} className={INPUT_CLASS} />
              <button type="button" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))} disabled={isPending || lines.length === 1} className={SECONDARY_BUTTON}>Quitar</button>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => setLines((current) => [...current, newLine()])} disabled={isPending} className={`mt-3 ${SECONDARY_BUTTON}`}>Agregar ítem</button>

      <label className="mt-4 block text-sm text-[#C4C4CE]">
        <span className="mb-2 block">Nota opcional</span>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={1000} disabled={isPending} className={INPUT_CLASS} />
      </label>
      <Feedback message={message} error={error} />
      <div className="mt-4 flex justify-end"><button type="button" onClick={submit} disabled={isPending} className={PRIMARY_BUTTON}>{isPending ? 'Registrando…' : 'Confirmar despacho'}</button></div>
    </div>
  );
}

function ReconciliationSelector({ dispatches }: { dispatches: InventoryEventDispatch[] }) {
  const [dispatchId, setDispatchId] = useState('');
  const dispatch = dispatches.find((candidate) => candidate.eventId === Number(dispatchId));
  return (
    <div className="mt-5">
      <label className="text-sm text-[#C4C4CE]">
        <span className="mb-2 block">Despacho pendiente</span>
        <select value={dispatchId} onChange={(event) => setDispatchId(event.target.value)} className={INPUT_CLASS}>
          <option value="">Seleccionar despacho…</option>
          {dispatches.map((candidate) => <option key={candidate.eventId} value={candidate.eventId}>{candidate.orderNumber} · {dateTime(candidate.createdAt)}</option>)}
        </select>
      </label>
      {dispatch ? <ReconciliationForm key={dispatch.eventId} dispatch={dispatch} /> : (
        <div className="mt-4 rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">
          {dispatches.length ? 'Selecciona un despacho.' : 'No hay despachos pendientes por conciliar.'}
        </div>
      )}
    </div>
  );
}

function ReconciliationForm({ dispatch }: { dispatch: InventoryEventDispatch }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lines, setLines] = useState(() => dispatch.lines.map((line) => ({
    inventoryItemId: line.inventoryItemId,
    returned: '0',
    lost: '0',
    lossKind: 'damage' as 'damage' | 'waste',
  })));
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const result = await reconcileInventoryEventAction({
          operationId: crypto.randomUUID(),
          dispatchOperationId: dispatch.dispatchOperationId,
          orderId: dispatch.orderId,
          lines: lines.map((line) => ({
            inventoryItemId: line.inventoryItemId,
            returnedQuantityUnits: Number(line.returned || 0),
            lossQuantityUnits: Number(line.lost || 0),
            lossKind: line.lossKind,
          })),
          notes,
        });
        setMessage(result?.commitment_mismatch
          ? 'Conciliación guardada con diferencia informativa para revisión de Master.'
          : 'Conciliación guardada. Las devoluciones liberaron la reserva y las pérdidas fueron descontadas.');
        router.refresh();
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : 'No se pudo conciliar el evento.');
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-[#302D3F] bg-[#15131D] p-4">
      <div className="font-semibold">{dispatch.orderNumber}</div>
      <div className="mt-3 space-y-3">
        {dispatch.lines.map((source) => {
          const line = lines.find((candidate) => candidate.inventoryItemId === source.inventoryItemId)!;
          return (
            <div key={source.inventoryItemId} className="rounded-xl border border-[#302D3F] bg-[#101016] p-3">
              <div className="text-sm font-semibold">{source.inventoryItemName}</div>
              <div className="mt-1 text-xs text-[#8E8E9B]">Despachado: {quantity(source.dispatchedQuantityUnits)} {source.unitName} · Comprometido: {quantity(source.committedQuantityUnits)} {source.unitName}</div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <input value={line.returned} onChange={(event) => setLines((current) => current.map((candidate) => candidate.inventoryItemId === source.inventoryItemId ? { ...candidate, returned: event.target.value } : candidate))} inputMode="decimal" placeholder="Devuelto utilizable" className={INPUT_CLASS} />
                <input value={line.lost} onChange={(event) => setLines((current) => current.map((candidate) => candidate.inventoryItemId === source.inventoryItemId ? { ...candidate, lost: event.target.value } : candidate))} inputMode="decimal" placeholder="Pérdida" className={INPUT_CLASS} />
                <select value={line.lossKind} onChange={(event) => setLines((current) => current.map((candidate) => candidate.inventoryItemId === source.inventoryItemId ? { ...candidate, lossKind: event.target.value as 'damage' | 'waste' } : candidate))} className={INPUT_CLASS}>
                  <option value="damage">Avería</option>
                  <option value="waste">Merma</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={1000} placeholder="Nota opcional" className={`mt-3 ${INPUT_CLASS}`} />
      <Feedback message={message} error={error} />
      <div className="mt-4 flex justify-end"><button type="button" onClick={submit} disabled={isPending} className={PRIMARY_BUTTON}>{isPending ? 'Conciliando…' : 'Cerrar conciliación'}</button></div>
    </div>
  );
}

function DispatchHistory({ dispatches }: { dispatches: InventoryEventDispatch[] }) {
  return dispatches.length ? (
    <div className="mt-5 space-y-3">
      {dispatches.map((dispatch) => (
        <article key={dispatch.eventId} className="rounded-xl border border-[#302D3F] bg-[#15131D] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="font-semibold">{dispatch.orderNumber}</div><div className="mt-1 text-xs text-[#858591]">{dateTime(dispatch.createdAt)} · {dispatch.lines.length} ítems</div></div>
            <div className={dispatch.reconciled ? 'text-xs text-emerald-200' : 'text-xs text-amber-200'}>{dispatch.reconciled ? 'Conciliado' : 'Pendiente'}</div>
          </div>
          <Link href={`/app/master/ops?openOrder=${dispatch.orderId}&tab=eventos`} prefetch={false} className="mt-3 inline-block text-xs font-semibold text-[#FEEF00] hover:underline">Ver orden</Link>
        </article>
      ))}
    </div>
  ) : <div className="mt-5 rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">Todavía no hay despachos de eventos.</div>;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={active ? PRIMARY_BUTTON : SECONDARY_BUTTON}>{children}</button>;
}

function Feedback({ message, error }: { message: string | null; error: string | null }) {
  if (!message && !error) return null;
  return <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${error ? 'border-red-400/30 bg-red-400/5 text-red-200' : 'border-emerald-400/30 bg-emerald-400/5 text-emerald-100'}`}>{error ?? message}</div>;
}
