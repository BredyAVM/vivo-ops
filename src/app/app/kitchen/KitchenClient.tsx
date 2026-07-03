'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ModulePreference } from '../ModulePreference';
import { kitchenTakeAction, markReadyAction, updateKitchenEtaAction } from '../master/dashboard/actions';

export type KitchenOrderItem = {
  id: number;
  qty: number;
  name: string;
  notes: string | null;
};

export type KitchenOrder = {
  id: number;
  orderNumber: string;
  displayNumber: string;
  status: 'confirmed' | 'in_kitchen' | 'ready';
  clientName: string;
  clientPhone: string | null;
  fulfillment: 'pickup' | 'delivery';
  deliveryAddress: string | null;
  createdAt: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  sentToKitchenAt: string | null;
  kitchenStartedAt: string | null;
  readyAt: string | null;
  etaMinutes: number | null;
  items: KitchenOrderItem[];
};

type KitchenClientProps = {
  fullName: string;
  orders: KitchenOrder[];
};

const STATUS_COLUMNS: Array<{
  key: KitchenOrder['status'];
  title: string;
  empty: string;
}> = [
  { key: 'confirmed', title: 'Cola', empty: 'Sin pedidos pendientes.' },
  { key: 'in_kitchen', title: 'Preparando', empty: 'Sin pedidos en preparacion.' },
  { key: 'ready', title: 'Listos', empty: 'Sin pedidos listos.' },
];

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';

  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function scheduleLabel(order: KitchenOrder) {
  if (order.scheduledDate && order.scheduledTime) return `${order.scheduledDate} ${order.scheduledTime}`;
  if (order.scheduledDate) return order.scheduledDate;
  return formatDateTime(order.createdAt);
}

function statusTone(status: KitchenOrder['status']) {
  if (status === 'confirmed') return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
  if (status === 'in_kitchen') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function toNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatQty(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
}

function extractUnitsPerService(name: string) {
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*(?:und|uds|unidad(?:es)?|pzs?|piezas?)/i);
  if (!match) return 0;
  return toNumber(match[1].replace(',', '.'), 0);
}

function isNonKitchenLine(name: string) {
  return /\b(delivery|entrega|envio|envío)\b/i.test(name);
}

function getItemUnits(item: KitchenOrderItem) {
  if (isNonKitchenLine(item.name)) return 0;
  const unitsPerService = extractUnitsPerService(item.name);
  if (unitsPerService <= 0) return item.qty;
  return item.qty * unitsPerService;
}

function splitDetailLines(notes: string | null) {
  return String(notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function elapsedMinutes(value: string | null) {
  if (!value) return null;
  const startedAt = new Date(value).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
}

function etaClockLabel(order: KitchenOrder) {
  if (order.status !== 'in_kitchen' || !order.kitchenStartedAt || !order.etaMinutes) return null;
  const startedAt = new Date(order.kitchenStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const dueAt = new Date(startedAt + order.etaMinutes * 60000);
  return dueAt.toLocaleTimeString('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Caracas',
  });
}

export default function KitchenClient({ fullName, orders }: KitchenClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [etaByOrder, setEtaByOrder] = useState<Record<number, string>>({});
  const [activeStatus, setActiveStatus] = useState<KitchenOrder['status']>('confirmed');

  const ordersByStatus = useMemo(() => {
    return new Map(
      STATUS_COLUMNS.map((column) => [
        column.key,
        orders.filter((order) => order.status === column.key),
      ])
    );
  }, [orders]);

  const totalPreparing = ordersByStatus.get('in_kitchen')?.length ?? 0;
  const totalPending = ordersByStatus.get('confirmed')?.length ?? 0;
  const totalReady = ordersByStatus.get('ready')?.length ?? 0;
  const activeColumn = STATUS_COLUMNS.find((column) => column.key === activeStatus) ?? STATUS_COLUMNS[0];
  const activeOrders = ordersByStatus.get(activeColumn.key) ?? [];

  const runAction = (key: string, action: () => Promise<void>) => {
    setPendingKey(key);
    setErrorMessage(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'No se pudo completar la accion.');
      } finally {
        setPendingKey(null);
      }
    });
  };

  return (
    <main className="min-h-screen bg-[#08090D] text-[#F5F5F7]">
      <ModulePreference moduleKey="kitchen" />
      <div className="mx-auto flex min-h-screen w-full max-w-[720px] flex-col px-3 py-3 sm:px-4">
        <header className="sticky top-0 z-30 -mx-3 border-b border-[#242433] bg-[#08090D]/95 px-3 pb-3 pt-3 backdrop-blur sm:-mx-4 sm:px-4">
          <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS</div>
              <h1 className="mt-1 text-[22px] font-semibold leading-tight">Cocina</h1>
              <div className="mt-0.5 text-xs text-[#B7B7C2]">{fullName || 'Operacion de cocina'}</div>
          </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => router.refresh()}
                className="h-10 rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#F5F5F7] active:scale-[0.98]"
              >
                Actualizar
              </button>
            <Link
              href="/app"
                className="flex h-10 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#F5F5F7]"
            >
                Módulo
            </Link>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Metric label="Cola" value={totalPending} tone="warn" />
            <Metric label="Prep." value={totalPreparing} tone="ok" />
            <Metric label="Listas" value={totalReady} tone="brand" />
          </div>

          <nav className="mt-3 grid grid-cols-3 gap-2">
            {STATUS_COLUMNS.map((column) => {
              const count = ordersByStatus.get(column.key)?.length ?? 0;
              const active = activeStatus === column.key;
              return (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => setActiveStatus(column.key)}
                  className={[
                    'h-11 rounded-xl border px-2 text-sm font-semibold transition active:scale-[0.98]',
                    active
                      ? 'border-[#FEEF00] bg-[#FEEF00] text-black'
                      : 'border-[#242433] bg-[#101018] text-[#D9D9E3]',
                  ].join(' ')}
                >
                  {column.title} <span className="ml-1 opacity-70">{count}</span>
                </button>
              );
            })}
          </nav>
        </header>

        {errorMessage ? (
          <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {errorMessage}
          </div>
        ) : null}

        <section className="flex-1 py-3">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <h2 className="text-base font-semibold">{activeColumn.title}</h2>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(activeColumn.key)}`}>
              {activeOrders.length}
            </span>
          </div>

          <div className="space-y-3">
            {activeOrders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#2A2A38] bg-[#101018] px-4 py-10 text-center text-sm text-[#8A8A96]">
                {activeColumn.empty}
              </div>
            ) : null}

            {activeOrders.map((order) => {
                    const takeActionKey = `take:${order.id}`;
                    const etaActionKey = `eta:${order.id}`;
              const delayActionKey = `delay:${order.id}`;
                    const readyActionKey = `ready:${order.id}`;
                    const etaValue = etaByOrder[order.id] ?? String(order.etaMinutes || 15);
              const totalUnits = order.items.reduce((sum, item) => sum + getItemUnits(item), 0);
              const elapsed =
                order.status === 'confirmed'
                  ? elapsedMinutes(order.sentToKitchenAt || order.createdAt)
                  : order.status === 'in_kitchen'
                    ? elapsedMinutes(order.kitchenStartedAt)
                    : elapsedMinutes(order.readyAt);
              const readyTime = etaClockLabel(order);

                    return (
                <article key={order.id} className="rounded-2xl border border-[#2A2A38] bg-[#101018] p-3 shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
                        <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[28px] font-black leading-none tracking-tight text-[#FEEF00]">
                        Orden #{order.displayNumber}
                      </div>
                      <div className="mt-1 truncate text-base font-semibold text-[#F5F5F7]">{order.clientName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#B7B7C2]">
                        <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                          {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}
                        </span>
                        <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                          {scheduleLabel(order)}
                        </span>
                        {elapsed != null ? (
                          <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                            {elapsed} min
                          </span>
                        ) : null}
                          </div>
                    </div>
                    <div className="text-right">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(order.status)}`}>
                        {activeColumn.title}
                          </span>
                      <div className="mt-2 text-xl font-black text-[#F5F5F7]">{formatQty(totalUnits)}</div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-[#8A8A96]">und</div>
                        </div>
                  </div>

                  {readyTime ? (
                    <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-200">
                      Lista aprox. {readyTime}
                          </div>
                  ) : null}

                        {order.deliveryAddress ? (
                    <div className="mt-3 rounded-xl border border-[#242433] bg-[#0B0B10] px-3 py-2 text-xs text-[#B7B7C2]">
                            {order.deliveryAddress}
                          </div>
                        ) : null}

                        <div className="mt-3 space-y-2">
                    {order.items.map((item) => {
                      const itemUnits = getItemUnits(item);
                      const detailLines = splitDetailLines(item.notes);
                      return (
                        <div key={item.id} className="rounded-xl border border-[#242433] bg-[#0B0B10] px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-base font-black text-[#F5F5F7]">
                                {formatQty(item.qty)} {item.name}
                              </div>
                            </div>
                            {itemUnits > 0 ? (
                              <div className="shrink-0 rounded-xl border border-[#343449] bg-[#15151D] px-2.5 py-1.5 text-right">
                                <div className="text-lg font-black text-[#FEEF00]">{formatQty(itemUnits)}</div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-[#8A8A96]">und</div>
                              </div>
                            ) : null}
                          </div>
                          {detailLines.length > 0 ? (
                            <div className="mt-2 space-y-1 border-l-2 border-[#FEEF00]/40 pl-3">
                              {detailLines.map((line, idx) => (
                                <div key={`${item.id}-detail-${idx}`} className="text-sm leading-snug text-[#C9C9D4]">
                                  {line}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                        </div>

                        {order.status === 'confirmed' ? (
                  <div className="mt-3 grid grid-cols-[94px_1fr] gap-2">
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={etaValue}
                              onChange={(event) =>
                                setEtaByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                              }
                        className="h-12 w-full rounded-xl border border-[#2A2A38] bg-[#0B0B10] px-3 text-center text-lg font-semibold text-[#F5F5F7]"
                              aria-label={`Minutos de preparacion orden ${order.displayNumber}`}
                            />
                            <button
                              type="button"
                              disabled={isPending && pendingKey === takeActionKey}
                              onClick={() =>
                                runAction(takeActionKey, async () => {
                                  const etaMinutes = Math.max(1, Math.round(Number(etaValue) || 15));
                                  await kitchenTakeAction({ orderId: order.id, etaMinutes });
                                })
                              }
                        className="h-12 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 text-base font-black text-emerald-200 active:scale-[0.98] disabled:opacity-60"
                            >
                              {isPending && pendingKey === takeActionKey ? 'Tomando...' : 'Tomar pedido'}
                            </button>
                          </div>
                        ) : null}

                        {order.status === 'in_kitchen' ? (
                          <div className="mt-3 space-y-2">
                      <div className="grid grid-cols-[44px_94px_44px_1fr] gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setEtaByOrder((current) => ({
                              ...current,
                              [order.id]: String(Math.max(1, Math.round(Number(etaValue) || 15) - 5)),
                            }))
                          }
                          className="h-12 rounded-xl border border-[#2A2A38] bg-[#0B0B10] text-lg font-black text-[#F5F5F7] active:scale-[0.98]"
                        >
                          -5
                        </button>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={etaValue}
                                onChange={(event) =>
                                  setEtaByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                                }
                          className="h-12 w-full rounded-xl border border-[#2A2A38] bg-[#0B0B10] px-3 text-center text-lg font-semibold text-[#F5F5F7]"
                                aria-label={`Nuevo tiempo estimado orden ${order.displayNumber}`}
                              />
                        <button
                          type="button"
                          onClick={() =>
                            setEtaByOrder((current) => ({
                              ...current,
                              [order.id]: String(Math.max(1, Math.round(Number(etaValue) || 15) + 5)),
                            }))
                          }
                          className="h-12 rounded-xl border border-[#2A2A38] bg-[#0B0B10] text-lg font-black text-[#F5F5F7] active:scale-[0.98]"
                        >
                          +5
                        </button>
                              <button
                                type="button"
                                disabled={isPending && pendingKey === etaActionKey}
                                onClick={() =>
                                  runAction(etaActionKey, async () => {
                                    const etaMinutes = Math.max(1, Math.round(Number(etaValue) || 15));
                                    await updateKitchenEtaAction({ orderId: order.id, etaMinutes });
                                  })
                                }
                          className="h-12 rounded-xl border border-[#2A2A38] bg-[#171720] px-3 text-sm font-bold text-[#F5F5F7] active:scale-[0.98] disabled:opacity-60"
                              >
                          {isPending && pendingKey === etaActionKey ? 'Guardando...' : 'Guardar'}
                              </button>
                            </div>
                      <button
                        type="button"
                        disabled={isPending && pendingKey === delayActionKey}
                        onClick={() =>
                          runAction(delayActionKey, async () => {
                            const etaMinutes = Math.max(1, Math.round(Number(etaValue) || 15) + 5);
                            await updateKitchenEtaAction({ orderId: order.id, etaMinutes });
                            setEtaByOrder((current) => ({ ...current, [order.id]: String(etaMinutes) }));
                          })
                        }
                        className="h-11 w-full rounded-xl border border-orange-400/40 bg-orange-400/10 px-3 text-sm font-bold text-orange-200 active:scale-[0.98] disabled:opacity-60"
                      >
                        {isPending && pendingKey === delayActionKey ? 'Reportando...' : 'Reportar retraso +5 min'}
                      </button>
                            <button
                              type="button"
                              disabled={isPending && pendingKey === readyActionKey}
                              onClick={() =>
                                runAction(readyActionKey, async () => {
                                  await markReadyAction({ orderId: order.id });
                                })
                              }
                        className="h-12 w-full rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00] px-3 text-base font-black text-black active:scale-[0.98] disabled:opacity-60"
                            >
                              {isPending && pendingKey === readyActionKey ? 'Marcando...' : 'Marcar lista'}
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'warn' | 'ok' | 'brand' }) {
  const toneClass =
    tone === 'warn'
      ? 'text-orange-200'
      : tone === 'ok'
        ? 'text-emerald-200'
        : 'text-[#FEEF00]';

  return (
    <div className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-center">
      <div className="text-[11px] text-[#8A8A96]">{label}</div>
      <div className={`mt-0.5 text-xl font-black ${toneClass}`}>{value}</div>
    </div>
  );
}
