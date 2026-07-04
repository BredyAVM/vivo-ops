'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { ModulePreference } from '../ModulePreference';

export type CounterOrderItem = {
  id: number;
  qty: number;
  name: string;
  lineTotalUsd: number;
  lineTotalBs: number;
  notes: string | null;
};

export type CounterOrder = {
  id: number;
  orderNumber: string;
  displayNumber: string;
  status: 'ready';
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  createdAt: string;
  readyAt: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  paymentMethod: string;
  paymentCurrency: string | null;
  paymentRequiresChange: boolean;
  paymentChangeFor: string | null;
  paymentChangeCurrency: string | null;
  paymentNote: string | null;
  totalUsd: number;
  totalBs: number;
  fxRate: number;
  confirmedPaidUsd: number;
  balanceUsd: number;
  reports: {
    pending: number;
    confirmed: number;
    rejected: number;
  };
  items: CounterOrderItem[];
};

type CounterClientProps = {
  fullName: string;
  orders: CounterOrder[];
};

type CounterFilter = 'all' | 'pickup' | 'delivery' | 'pending' | 'paid';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'pending', label: 'Por cobrar' },
  { key: 'paid', label: 'Pagados' },
];

function moneyUsd(value: number) {
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyBs(value: number) {
  return `Bs ${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function qtyLabel(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
}

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';

  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function paymentLabel(order: CounterOrder) {
  if (order.balanceUsd <= 0.005) return 'Pagado';
  if (order.confirmedPaidUsd > 0.005) return 'Abonado';
  if (order.reports.pending > 0) return 'Pago por revisar';
  return 'Pendiente';
}

function paymentClass(order: CounterOrder) {
  if (order.balanceUsd <= 0.005) return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.reports.pending > 0) return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
  if (order.confirmedPaidUsd > 0.005) return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
}

function fulfillmentLabel(value: CounterOrder['fulfillment']) {
  return value === 'delivery' ? 'Delivery' : 'Pickup';
}

function scheduleLabel(order: CounterOrder) {
  if (order.scheduledDate && order.scheduledTime) return `${order.scheduledDate} - ${order.scheduledTime}`;
  if (order.scheduledDate) return order.scheduledDate;
  return formatDateTime(order.createdAt);
}

export default function CounterClient({ fullName, orders }: CounterClientProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<CounterFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(orders[0]?.id ?? null);

  const stats = useMemo(() => {
    const pickup = orders.filter((order) => order.fulfillment === 'pickup').length;
    const delivery = orders.filter((order) => order.fulfillment === 'delivery').length;
    const pendingUsd = orders.reduce((sum, order) => sum + Math.max(0, order.balanceUsd), 0);
    const paid = orders.filter((order) => order.balanceUsd <= 0.005).length;

    return {
      total: orders.length,
      pickup,
      delivery,
      pendingUsd,
      paid,
    };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return orders.filter((order) => {
      if (filter === 'pickup' && order.fulfillment !== 'pickup') return false;
      if (filter === 'delivery' && order.fulfillment !== 'delivery') return false;
      if (filter === 'pending' && order.balanceUsd <= 0.005) return false;
      if (filter === 'paid' && order.balanceUsd > 0.005) return false;

      if (!term) return true;

      return [
        order.displayNumber,
        order.orderNumber,
        order.clientName,
        order.clientPhone,
        order.deliveryAddress,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term));
    });
  }, [filter, orders, search]);

  const selectedOrder =
    orders.find((order) => order.id === selectedOrderId) ?? filteredOrders[0] ?? orders[0] ?? null;

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <ModulePreference moduleKey="counter" />
      <header className="sticky top-0 z-20 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <div className="text-xl font-semibold tracking-tight">VIVO OPS - Counter</div>
            <div className="text-sm text-[#9FA0AA]">{fullName} - Mostrador y entregas listas</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.refresh()}
              className="rounded-full border border-[#303044] bg-[#111118] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
            >
              Actualizar
            </button>
            <Link
              href="/app"
              className="rounded-full border border-[#303044] bg-[#111118] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
            >
              Modulos
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-5">
        <div className="grid gap-3 lg:grid-cols-5">
          <Summary label="Listos" value={String(stats.total)} />
          <Summary label="Pickup" value={String(stats.pickup)} />
          <Summary label="Delivery" value={String(stats.delivery)} />
          <Summary label="Pagados" value={String(stats.paid)} tone="good" />
          <Summary label="Por cobrar" value={moneyUsd(stats.pendingUsd)} tone={stats.pendingUsd > 0 ? 'warn' : 'good'} />
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(360px,0.92fr)_minmax(520px,1.08fr)]">
          <section className="rounded-[8px] border border-[#242433] bg-[#111118]">
            <div className="border-b border-[#242433] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-semibold">Pedidos listos</h1>
                  <p className="text-sm text-[#9FA0AA]">
                    Cocina ya los marco listos. Mostrador decide entrega y cobro.
                  </p>
                </div>
                <span className="rounded-full border border-[#303044] px-3 py-1 text-xs text-[#C7C8D1]">
                  {filteredOrders.length} visibles
                </span>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setFilter(item.key)}
                    className={[
                      'rounded-full border px-3 py-1.5 text-sm font-semibold transition',
                      filter === item.key
                        ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                        : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1] hover:border-[#FEEF00]/50',
                    ].join(' ')}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar orden, cliente, telefono o direccion"
                className="mt-4 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </div>

            <div className="max-h-[calc(100vh-330px)] overflow-y-auto p-2">
              {filteredOrders.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[#303044] p-6 text-sm text-[#9FA0AA]">
                  No hay pedidos listos con este filtro.
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredOrders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => setSelectedOrderId(order.id)}
                      className={[
                        'w-full rounded-[8px] border p-3 text-left transition',
                        selectedOrder?.id === order.id
                          ? 'border-[#FEEF00] bg-[#FEEF00]/8'
                          : 'border-[#242433] bg-[#0B0B0D] hover:border-[#3D3D52]',
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold">#{order.displayNumber}</span>
                            <span className="rounded-full border border-[#303044] px-2 py-0.5 text-xs text-[#C7C8D1]">
                              {fulfillmentLabel(order.fulfillment)}
                            </span>
                            <span className={['rounded-full border px-2 py-0.5 text-xs font-semibold', paymentClass(order)].join(' ')}>
                              {paymentLabel(order)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-sm font-semibold text-[#F5F5F7]">{order.clientName}</div>
                          <div className="mt-1 text-xs text-[#9FA0AA]">{scheduleLabel(order)}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold">{moneyUsd(order.totalUsd)}</div>
                          {order.balanceUsd > 0.005 ? (
                            <div className="text-xs font-semibold text-orange-300">Debe {moneyUsd(order.balanceUsd)}</div>
                          ) : (
                            <div className="text-xs font-semibold text-emerald-300">OK</div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[8px] border border-[#242433] bg-[#111118]">
            {selectedOrder ? (
              <OrderDetail order={selectedOrder} />
            ) : (
              <div className="p-8 text-sm text-[#9FA0AA]">Selecciona un pedido listo para operar.</div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function Summary({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'warn' }) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-orange-300' : 'text-[#F5F5F7]';

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#111118] p-4">
      <div className="text-sm text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-xl font-semibold', toneClass].join(' ')}>{value}</div>
    </div>
  );
}

function OrderDetail({ order }: { order: CounterOrder }) {
  const paid = order.balanceUsd <= 0.005;

  return (
    <div>
      <div className="border-b border-[#242433] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold">Orden #{order.displayNumber}</h2>
              <span className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1 text-sm font-semibold text-[#FEEF00]">
                Lista
              </span>
              <span className="rounded-full border border-[#303044] px-3 py-1 text-sm text-[#C7C8D1]">
                {fulfillmentLabel(order.fulfillment)}
              </span>
            </div>
            <div className="mt-2 text-sm text-[#9FA0AA]">
              {order.clientName}
              {order.clientPhone ? ` · ${order.clientPhone}` : ''}
            </div>
            <div className="mt-1 text-sm text-[#9FA0AA]">Lista: {formatDateTime(order.readyAt)}</div>
          </div>
          <span className={['rounded-full border px-3 py-1 text-sm font-semibold', paymentClass(order)].join(' ')}>
            {paymentLabel(order)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Total" value={moneyUsd(order.totalUsd)} note={moneyBs(order.totalBs)} />
            <Metric label="Confirmado" value={moneyUsd(order.confirmedPaidUsd)} tone="good" />
            <Metric label="Pendiente" value={moneyUsd(order.balanceUsd)} tone={paid ? 'good' : 'warn'} />
          </div>

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pago esperado</h3>
              <span className="text-sm font-semibold text-[#F5F5F7]">{getPaymentMethodLabel(order.paymentMethod)}</span>
            </div>
            <div className="mt-2 grid gap-2 text-sm text-[#9FA0AA] sm:grid-cols-2">
              <div>Moneda: {order.paymentCurrency || 'Sin definir'}</div>
              <div>Tasa orden: {order.fxRate > 0 ? moneyBs(order.fxRate) : 'Sin tasa'}</div>
              {order.paymentRequiresChange ? (
                <div className="sm:col-span-2">
                  Cambio para: {order.paymentChangeFor || '-'} {order.paymentChangeCurrency || ''}
                </div>
              ) : null}
              {order.paymentNote ? <div className="sm:col-span-2">Nota: {order.paymentNote}</div> : null}
            </div>
          </div>

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
            <h3 className="font-semibold">Pedido</h3>
            <div className="mt-3 divide-y divide-[#242433]">
              {order.items.length === 0 ? (
                <div className="py-3 text-sm text-[#9FA0AA]">Sin items cargados.</div>
              ) : (
                order.items.map((item) => (
                  <div key={item.id} className="grid gap-2 py-3 sm:grid-cols-[70px_1fr_100px]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(item.qty)}</div>
                    <div>
                      <div className="text-sm font-semibold">{item.name}</div>
                      {item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{item.notes}</div> : null}
                    </div>
                    <div className="text-left text-sm font-semibold sm:text-right">{moneyUsd(item.lineTotalUsd)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {order.fulfillment === 'delivery' || order.deliveryAddress ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
              <h3 className="font-semibold">Entrega</h3>
              <div className="mt-2 text-sm text-[#C7C8D1]">{order.deliveryAddress || 'Sin direccion'}</div>
            </div>
          ) : null}

          {order.notes ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
              <h3 className="font-semibold">Notas</h3>
              <div className="mt-2 text-sm text-[#C7C8D1]">{order.notes}</div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-3">
          <ActionButton label={order.fulfillment === 'delivery' ? 'Entregar a motorizado' : 'Entregar pickup'} />
          <ActionButton label="Registrar pago" />
          <ActionButton label="Dar cambio" />
          <ActionButton label="Agregar producto" />
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs leading-relaxed text-[#9FA0AA]">
            Siguiente bloque: estas acciones conectan caja, puntos, cambios y modificacion rapida sin pasar por aprobacion master.
          </div>
        </aside>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-orange-300' : 'text-[#F5F5F7]';

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
      <div className="text-sm text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-lg font-semibold', toneClass].join(' ')}>{value}</div>
      {note ? <div className="mt-1 text-xs text-[#9FA0AA]">{note}</div> : null}
    </div>
  );
}

function ActionButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm font-semibold text-[#777987]"
    >
      {label}
    </button>
  );
}
