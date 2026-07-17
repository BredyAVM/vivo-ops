"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  getOperationalStatusLabel,
  getPaymentMethodLabel,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";

export type MasterOpsOrder = {
  id: number;
  orderNumber: string;
  status: OrderStatus;
  fulfillment: FulfillmentType;
  clientName: string;
  advisorName: string;
  totalUsd: number;
  totalBs: number | null;
  createdAt: string;
  operationalDate: string | null;
  scheduleLabel: string;
  paymentMethod: string | null;
  queuedNeedsReapproval: boolean;
  hasPendingPayment: boolean;
  isAttentionOrder: boolean;
};

type MasterOpsStats = {
  total: number;
  actions: number;
  created: number;
  queued: number;
  kitchen: number;
  ready: number;
  delivery: number;
  pendingPayments: number;
};

type Props = {
  currentUserName: string;
  roles: string[];
  focusDate: string;
  previousDate: string;
  nextDate: string;
  activeRate: number | null;
  generatedAt: string;
  orders: MasterOpsOrder[];
  stats: MasterOpsStats;
};

type FilterKey = "all" | "actions" | "created" | "queued" | "kitchen" | "ready" | "delivery";

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "Todo" },
  { key: "actions", label: "Acciones" },
  { key: "created", label: "Por aprobar" },
  { key: "queued", label: "Cola" },
  { key: "kitchen", label: "Cocina" },
  { key: "ready", label: "Listas" },
  { key: "delivery", label: "Delivery" },
];

const dateFormatter = new Intl.DateTimeFormat("es-VE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("es-VE", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "America/Caracas",
});

function moneyUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function moneyBs(value: number | null) {
  if (value == null) return "Bs -";
  return `Bs ${Math.round(value).toLocaleString("es-VE")}`;
}

function formatDateKey(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00-04:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return dateFormatter.format(date);
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return timeFormatter.format(date);
}

function matchesFilter(order: MasterOpsOrder, filter: FilterKey) {
  if (filter === "all") return true;
  if (filter === "actions") return order.isAttentionOrder || order.hasPendingPayment;
  if (filter === "created") return order.status === "created";
  if (filter === "queued") return order.status === "queued";
  if (filter === "kitchen") return order.status === "confirmed" || order.status === "in_kitchen";
  if (filter === "ready") return order.status === "ready";
  if (filter === "delivery") return order.status === "out_for_delivery";
  return true;
}

export default function MasterOpsClient({
  currentUserName,
  roles,
  focusDate,
  previousDate,
  nextDate,
  activeRate,
  generatedAt,
  orders,
  stats,
}: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const normalizedSearch = search.trim().toLocaleLowerCase("es-VE");
  const visibleOrders = useMemo(() => {
    return orders.filter((order) => {
      if (!matchesFilter(order, filter)) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        order.orderNumber,
        order.clientName,
        order.advisorName,
        getOperationalStatusLabel(order),
      ]
        .join(" ")
        .toLocaleLowerCase("es-VE");

      return haystack.includes(normalizedSearch);
    });
  }, [filter, normalizedSearch, orders]);

  const filterCount = (key: FilterKey) => {
    if (key === "all") return stats.total;
    if (key === "actions") return stats.actions;
    if (key === "created") return stats.created;
    if (key === "queued") return stats.queued;
    if (key === "kitchen") return stats.kitchen;
    if (key === "ready") return stats.ready;
    if (key === "delivery") return stats.delivery;
    return 0;
  };

  return (
    <main className="min-h-screen bg-[#08080b] text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#08080b]/95 px-5 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-yellow-300">
              Paralelo de prueba
            </p>
            <h1 className="text-2xl font-bold">B. Master Operativo</h1>
            <p className="text-sm text-slate-400">
              {currentUserName} - {roles.join(" / ")} - generado {generatedAt}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-yellow-300"
              href="/app/master/dashboard"
            >
              Dashboard actual
            </Link>
            <Link
              className="rounded-full border border-yellow-300 bg-yellow-300 px-4 py-2 text-sm font-bold text-black"
              href={`/app/master/ops?focusDate=${focusDate}`}
            >
              Recargar
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-[1500px] gap-4 px-5 py-5">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <div className="rounded-2xl border border-slate-800 bg-[#111119] p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                className="rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-200 hover:border-yellow-300"
                href={`/app/master/ops?focusDate=${previousDate}`}
              >
                Anterior
              </Link>
              <div className="min-w-[180px] rounded-xl border border-slate-700 bg-black/30 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Dia operativo</p>
                <p className="text-lg font-bold">{formatDateKey(focusDate)}</p>
              </div>
              <Link
                className="rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-200 hover:border-yellow-300"
                href={`/app/master/ops?focusDate=${nextDate}`}
              >
                Siguiente
              </Link>
              <div className="rounded-xl border border-slate-700 bg-black/30 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Tasa</p>
                <p className="text-lg font-bold">{activeRate ? `Bs ${activeRate.toFixed(2)}` : "Sin tasa"}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[520px]">
            <Metric label="Acciones" value={stats.actions} tone="yellow" />
            <Metric label="Cola" value={stats.queued} />
            <Metric label="Cocina" value={stats.kitchen} />
            <Metric label="Pagos" value={stats.pendingPayments} tone="cyan" />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <section className="rounded-2xl border border-slate-800 bg-[#111119] p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold">Operacion del dia</h2>
                <p className="text-sm text-slate-400">
                  Vista ligera para probar el futuro modulo del master sin afectar la dashboard actual.
                </p>
              </div>
              <input
                className="min-w-[260px] rounded-xl border border-slate-700 bg-black/40 px-4 py-3 text-base outline-none focus:border-yellow-300"
                placeholder="Buscar orden, cliente o asesor"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {filters.map((item) => (
                <button
                  key={item.key}
                  className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    filter === item.key
                      ? "border-yellow-300 bg-yellow-300 text-black"
                      : "border-slate-700 bg-black/30 text-slate-300 hover:border-slate-500"
                  }`}
                  type="button"
                  onClick={() => setFilter(item.key)}
                >
                  {item.label} <span className="ml-1 opacity-70">{filterCount(item.key)}</span>
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-3">
              {visibleOrders.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-700 p-8 text-center text-slate-400">
                  No hay ordenes para este filtro.
                </div>
              ) : (
                visibleOrders.map((order) => (
                  <OrderCard key={order.id} focusDate={focusDate} order={order} />
                ))
              )}
            </div>
          </section>

          <aside className="grid content-start gap-4">
            <section className="rounded-2xl border border-slate-800 bg-[#111119] p-4">
              <h2 className="text-lg font-bold">Alcance de esta prueba</h2>
              <ul className="mt-3 grid gap-2 text-sm text-slate-300">
                <li>Lee solo datos operativos esenciales.</li>
                <li>No reemplaza la ruta actual de los master.</li>
                <li>Los detalles siguen abriendo en la dashboard vieja.</li>
                <li>La siguiente capa sera mover acciones reales aqui.</li>
              </ul>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-[#111119] p-4">
              <h2 className="text-lg font-bold">Siguiente capa</h2>
              <div className="mt-3 grid gap-2 text-sm text-slate-300">
                <p>1. Aprobar/devolver orden.</p>
                <p>2. Confirmar/rechazar pagos.</p>
                <p>3. Enviar a cocina y asignar delivery.</p>
                <p>4. Separar admin en su ruta propia.</p>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: number;
  tone?: "slate" | "yellow" | "cyan";
}) {
  const toneClass =
    tone === "yellow"
      ? "border-yellow-300/40 text-yellow-200"
      : tone === "cyan"
        ? "border-cyan-300/30 text-cyan-200"
        : "border-slate-800 text-slate-100";

  return (
    <div className={`rounded-2xl border bg-[#111119] p-4 ${toneClass}`}>
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function OrderCard({ order, focusDate }: { order: MasterOpsOrder; focusDate: string }) {
  const statusLabel = getOperationalStatusLabel(order);
  const dashboardDate = order.operationalDate || focusDate;
  const dashboardUrl = `/app/master/dashboard?focusDate=${dashboardDate}&openOrder=${order.id}`;

  return (
    <article className="rounded-2xl border border-slate-800 bg-black/25 p-4 transition hover:border-slate-600">
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold">Orden #{order.orderNumber}</h3>
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200">
              {statusLabel}
            </span>
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200">
              {order.fulfillment === "delivery" ? "Delivery" : "Pickup"}
            </span>
            {order.queuedNeedsReapproval ? (
              <span className="rounded-full bg-orange-500/15 px-3 py-1 text-xs font-semibold text-orange-200">
                Re-aprobacion
              </span>
            ) : null}
            {order.hasPendingPayment ? (
              <span className="rounded-full bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-200">
                Pago pendiente
              </span>
            ) : null}
          </div>
          <p className="mt-2 truncate text-base font-semibold text-slate-100">{order.clientName}</p>
          <p className="text-sm text-slate-400">{order.advisorName}</p>
        </div>

        <div className="grid gap-2 text-right md:min-w-[220px]">
          <p className="text-lg font-bold">{moneyUsd(order.totalUsd)}</p>
          <p className="text-sm text-slate-400">{moneyBs(order.totalBs)}</p>
          <Link
            className="rounded-xl border border-yellow-300 px-4 py-2 text-center text-sm font-bold text-yellow-200 hover:bg-yellow-300 hover:text-black"
            href={dashboardUrl}
          >
            Abrir detalle
          </Link>
        </div>
      </div>

      <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3 text-sm text-slate-400 md:grid-cols-4">
        <p>
          <span className="text-slate-500">Entrega: </span>
          {order.scheduleLabel}
        </p>
        <p>
          <span className="text-slate-500">Creada: </span>
          {formatTime(order.createdAt)}
        </p>
        <p>
          <span className="text-slate-500">Pago: </span>
          {getPaymentMethodLabel(order.paymentMethod)}
        </p>
        <p>
          <span className="text-slate-500">Fecha: </span>
          {formatDateKey(order.operationalDate || focusDate)}
        </p>
      </div>
    </article>
  );
}
