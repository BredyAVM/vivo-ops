'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ModulePreference } from '../ModulePreference';
import { kitchenTakeAction, markReadyAction } from '../master/dashboard/actions';

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
  { key: 'confirmed', title: 'Por tomar', empty: 'Sin pedidos pendientes de tomar.' },
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

export default function KitchenClient({ fullName, orders }: KitchenClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [etaByOrder, setEtaByOrder] = useState<Record<number, string>>({});

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
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-3 py-4 sm:px-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#242433] pb-4">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS</div>
            <h1 className="mt-1 text-2xl font-semibold">Cocina</h1>
            <div className="mt-1 text-sm text-[#B7B7C2]">{fullName || 'Operacion de cocina'}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Metric label="Por tomar" value={totalPending} tone="warn" />
            <Metric label="Preparando" value={totalPreparing} tone="ok" />
            <Metric label="Listos" value={totalReady} tone="brand" />
            <Link
              href="/app"
              className="rounded-xl border border-[#2A2A38] bg-[#121218] px-4 py-3 text-sm font-semibold text-[#F5F5F7]"
            >
              Cambiar modulo
            </Link>
          </div>
        </header>

        {errorMessage ? (
          <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {errorMessage}
          </div>
        ) : null}

        <section className="grid flex-1 gap-4 py-4 lg:grid-cols-3">
          {STATUS_COLUMNS.map((column) => {
            const columnOrders = ordersByStatus.get(column.key) ?? [];

            return (
              <div key={column.key} className="min-h-[280px] rounded-2xl border border-[#242433] bg-[#101018] p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">{column.title}</h2>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(column.key)}`}>
                    {columnOrders.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {columnOrders.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#2A2A38] px-4 py-8 text-sm text-[#8A8A96]">
                      {column.empty}
                    </div>
                  ) : null}

                  {columnOrders.map((order) => {
                    const actionKey = `${order.status}:${order.id}`;
                    const busy = isPending && pendingKey === actionKey;
                    const etaValue = etaByOrder[order.id] ?? String(order.etaMinutes || 15);

                    return (
                      <article key={order.id} className="rounded-xl border border-[#2A2A38] bg-[#0B0B10] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-lg font-semibold">Orden #{order.displayNumber}</div>
                            <div className="mt-1 text-sm text-[#B7B7C2]">{order.clientName}</div>
                            {order.clientPhone ? <div className="text-xs text-[#8A8A96]">{order.clientPhone}</div> : null}
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(order.status)}`}>
                            {column.title}
                          </span>
                        </div>

                        <div className="mt-3 grid gap-2 text-xs text-[#B7B7C2] sm:grid-cols-2">
                          <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                            <div className="text-[#8A8A96]">Hora</div>
                            <div className="mt-1 text-[#F5F5F7]">{scheduleLabel(order)}</div>
                          </div>
                          <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                            <div className="text-[#8A8A96]">Tipo</div>
                            <div className="mt-1 text-[#F5F5F7]">
                              {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}
                            </div>
                          </div>
                        </div>

                        {order.deliveryAddress ? (
                          <div className="mt-2 rounded-lg border border-[#242433] bg-[#121218] px-3 py-2 text-xs text-[#B7B7C2]">
                            {order.deliveryAddress}
                          </div>
                        ) : null}

                        <div className="mt-3 space-y-2">
                          {order.items.map((item) => (
                            <div key={item.id} className="rounded-lg bg-[#15151D] px-3 py-2">
                              <div className="text-sm font-semibold text-[#F5F5F7]">
                                {item.qty} {item.name}
                              </div>
                              {item.notes ? <div className="mt-1 whitespace-pre-line text-xs text-[#A5A5B0]">{item.notes}</div> : null}
                            </div>
                          ))}
                        </div>

                        {order.status === 'confirmed' ? (
                          <div className="mt-3 flex gap-2">
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={etaValue}
                              onChange={(event) =>
                                setEtaByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                              }
                              className="w-24 rounded-xl border border-[#2A2A38] bg-[#101018] px-3 py-2 text-sm text-[#F5F5F7]"
                              aria-label={`Minutos de preparacion orden ${order.displayNumber}`}
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                runAction(actionKey, async () => {
                                  const etaMinutes = Math.max(1, Math.round(Number(etaValue) || 15));
                                  await kitchenTakeAction({ orderId: order.id, etaMinutes });
                                })
                              }
                              className="flex-1 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-60"
                            >
                              {busy ? 'Tomando...' : 'Tomar pedido'}
                            </button>
                          </div>
                        ) : null}

                        {order.status === 'in_kitchen' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              runAction(actionKey, async () => {
                                await markReadyAction({ orderId: order.id });
                              })
                            }
                            className="mt-3 w-full rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
                          >
                            {busy ? 'Marcando...' : 'Marcar lista'}
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
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
    <div className="min-w-[92px] rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-right">
      <div className="text-xs text-[#8A8A96]">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
