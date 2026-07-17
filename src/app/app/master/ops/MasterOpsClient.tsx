"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  canCompleteOrder,
  canKitchenTakeOrder,
  canManageOrderDeliveryAssignment,
  canMarkOrderReady,
  canSendOrderToKitchen,
  canStartOrderDelivery,
  isRecognizedBillingOrder,
  isScheduledClosingOrder,
} from "@/lib/domain/order-domain";
import {
  ORDER_STATUS_LABELS,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";

export type PaymentVerify = "none" | "pending" | "confirmed" | "rejected";

export type MasterOpsOrder = {
  id: number;
  status: OrderStatus;
  fulfillment: FulfillmentType;
  advisorName: string;
  clientName: string;
  totalUsd: number;
  totalBs: number | null;
  balanceUsd: number;
  confirmedPaidUsd: number;
  paymentVerify: PaymentVerify;
  deliveryAtISO: string;
  createdAtISO: string;
  sentToKitchenAtISO: string | null;
  kitchenStartedAtISO: string | null;
  readyAtISO: string | null;
  queuedNeedsReapproval: boolean;
  returnedToAdvisor: boolean;
  isAsap: boolean;
  isNewClient: boolean;
  riderName: string | null;
  externalPartner: string | null;
};

export type OperationStatsSummary = {
  cierres: number;
  fact: number;
  abonadoConfirmado: number;
  pendiente: number;
};

export type MasterOpsStats = {
  day: OperationStatsSummary;
  week: OperationStatsSummary;
  payments: {
    porConfirmar: number;
    confirmados: number;
    rechazados: number;
  };
  deliveries: {
    internos: number;
    externos: number;
  };
  kitchen: {
    totalEnCocina: number;
    pendientesToma: number;
    enPreparacion: number;
    preparados: number;
  };
  urgentTasks: {
    approve: number;
    reapprove: number;
    kitchen: number;
    driver: number;
  };
  actions: number;
  updates: number;
};

type Props = {
  currentUserName: string;
  roles: string[];
  focusDate: string;
  previousDate: string;
  nextDate: string;
  weekLabel: string;
  activeRate: number | null;
  orders: MasterOpsOrder[];
  stats: MasterOpsStats;
};

type MasterTray = "all" | "pending_created" | "reapproval" | "queued" | "kitchen" | "delivery" | "finalized";
type DetailTab = "detalle" | "entrega" | "pagos";

const trayItems: Array<{ key: MasterTray; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "pending_created", label: "Pendientes" },
  { key: "reapproval", label: "Re-aprobacion" },
  { key: "queued", label: "En cola" },
  { key: "kitchen", label: "Cocina" },
  { key: "delivery", label: "Delivery" },
  { key: "finalized", label: "Finalizadas" },
];

const timeFormatter = new Intl.DateTimeFormat("es-VE", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "America/Caracas",
});

const dayFormatter = new Intl.DateTimeFormat("es-VE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Caracas",
});

function fmtUSD(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function fmtRateBs(value: number) {
  return `Bs ${Number(value || 0).toFixed(2)}`;
}

function fmtTimeAMPM(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return timeFormatter.format(date);
}

function fmtDayLabel(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00-04:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return dayFormatter.format(date);
}

function splitTwoWordsCompact(value: string) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { line1: parts[0] || "--", line2: "" };
  return { line1: parts.slice(0, 2).join(" "), line2: parts.slice(2).join(" ") };
}

function pillLabel(value: string) {
  if (value === "pickup") return "Pickup";
  if (value === "delivery") return "Delivery";
  return value || "--";
}

function paymentToneClass(balanceUsd: number) {
  if (balanceUsd <= 0.005) return "text-[#7FE7C4]";
  return "text-[#FEEF00]";
}

function processCurrentKey(order: MasterOpsOrder) {
  if (order.status === "created") return "created";
  if (order.status === "queued") return "queued";
  if (order.status === "confirmed" || order.status === "in_kitchen") return "confirmed";
  if (order.fulfillment === "pickup" && order.status === "ready") return "pickup_ready";
  if (order.status === "ready") return "ready";
  if (order.status === "out_for_delivery") return "out_for_delivery";
  if (order.status === "delivered") return "delivered";
  if (order.status === "cancelled") return "cancelled";
  return "created";
}

function processSteps(order: MasterOpsOrder) {
  const isPickup = order.fulfillment === "pickup";
  return [
    { key: "created", label: "Creada" },
    { key: "queued", label: "En cola" },
    { key: "confirmed", label: "En cocina" },
    { key: "ready", label: "Lista" },
    { key: isPickup ? "pickup_ready" : "out_for_delivery", label: isPickup ? "Lista para retiro" : "En camino" },
    { key: "delivered", label: isPickup ? "Retirada" : "Entregada" },
  ];
}

function stepTone(stepKey: string, currentKey: string, cancelled: boolean, orderedKeys: string[]) {
  if (cancelled) return stepKey === currentKey ? "current-cancelled" : "future";
  const currentIndex = orderedKeys.indexOf(currentKey);
  const stepIndex = orderedKeys.indexOf(stepKey);
  if (stepIndex < currentIndex) return "done";
  if (stepIndex === currentIndex) return "current";
  return "future";
}

function visualClasses(tone: string) {
  return {
    dotClass:
      tone === "done"
        ? "bg-emerald-500 border-emerald-500"
        : tone === "current"
          ? "bg-[#FEEF00] border-[#FEEF00]"
          : tone === "current-cancelled"
            ? "bg-red-500 border-red-500"
            : "bg-[#191926] border-[#2A2A38]",
    textClass:
      tone === "done"
        ? "text-emerald-400"
        : tone === "current"
          ? "text-[#FEEF00]"
          : tone === "current-cancelled"
            ? "text-red-400"
            : "text-[#6F6F7C]",
    lineClass: tone === "done" ? "bg-emerald-500/60" : "bg-[#242433]",
  };
}

function hasDeliveryAssignment(order: MasterOpsOrder) {
  return Boolean(order.riderName?.trim() || order.externalPartner?.trim());
}

function canAssignDelivery(order: MasterOpsOrder) {
  return canManageOrderDeliveryAssignment(order) && !hasDeliveryAssignment(order);
}

function getNextPrimaryActionLabel(order: MasterOpsOrder) {
  if (order.paymentVerify === "pending") return "Confirmar pago";
  if (canAssignDelivery(order)) return "Asignar delivery";
  if (canSendOrderToKitchen(order)) return "Enviar a cocina";
  if (canKitchenTakeOrder(order)) return "Tomar en cocina";
  if (canMarkOrderReady(order)) return "Marcar preparada";
  if (canStartOrderDelivery(order)) return order.fulfillment === "pickup" ? "Lista para retiro" : "En camino";
  if (canCompleteOrder(order)) return order.fulfillment === "pickup" ? "Marcar retirado" : "Marcar entregado";
  if (order.status === "cancelled") return "Orden cancelada";
  if (order.status === "delivered") return "Ciclo completado";
  if (order.status === "created" && order.returnedToAdvisor) return "Devuelta al asesor";
  if (order.status === "created") return "Pendiente de aprobacion";
  if (order.status === "queued" && order.queuedNeedsReapproval) return "Pendiente de re-aprobacion";
  return "Sin accion principal";
}

function getOrderFocusTab(order: MasterOpsOrder): DetailTab {
  if (order.paymentVerify === "pending") return "pagos";
  if (order.fulfillment === "delivery" && (!hasDeliveryAssignment(order) || order.status === "ready" || order.status === "out_for_delivery")) {
    return "entrega";
  }
  return "detalle";
}

function matchesTray(order: MasterOpsOrder, tray: MasterTray) {
  if (tray === "all") return true;
  if (tray === "pending_created") return order.status === "created" && !order.returnedToAdvisor;
  if (tray === "reapproval") return order.status === "queued" && order.queuedNeedsReapproval;
  if (tray === "queued") return order.status === "queued";
  if (tray === "kitchen") return ["confirmed", "in_kitchen", "ready"].includes(order.status);
  if (tray === "delivery") return order.fulfillment === "delivery" && ["out_for_delivery", "delivered"].includes(order.status);
  if (tray === "finalized") return ["delivered", "cancelled"].includes(order.status);
  return true;
}

function dashboardUrl(order: MasterOpsOrder, focusDate: string, tab: DetailTab = "detalle") {
  return `/app/master/dashboard?focusDate=${focusDate}&openOrder=${order.id}&tab=${tab}`;
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-[#242433] bg-[#121218] p-3 ${className}`}>
      <div className="mb-2 text-[13px] font-semibold text-[#F5F5F7]">{title}</div>
      {children}
    </section>
  );
}

function TopNavButton({
  label,
  active = false,
  href,
  count,
}: {
  label: string;
  active?: boolean;
  href?: string;
  count?: number;
}) {
  const className = [
    "inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-[13px] font-semibold transition",
    active
      ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
      : "border-[#242433] bg-[#121218] text-[#B7B7C2] hover:text-[#F5F5F7]",
  ].join(" ");

  const content = (
    <>
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/15">=</span>
      <span>{label}</span>
      {count != null && count > 0 ? (
        <span className="rounded-full bg-[#242433] px-2 py-0.5 text-[11px] text-[#F5F5F7]">{count}</span>
      ) : null}
    </>
  );

  if (href) return <Link className={className} href={href}>{content}</Link>;
  return <button className={className} type="button">{content}</button>;
}

function StatRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-[#B7B7C2]">{label}</span>
      <span className={highlight ? "font-semibold text-[#FEEF00]" : "font-semibold text-[#F5F5F7]"}>{value}</span>
    </div>
  );
}

function RowProcessTimeline({ order }: { order: MasterOpsOrder }) {
  const steps = processSteps(order);
  const currentKey = processCurrentKey(order);
  const orderedKeys = steps.map((step) => step.key);
  const cancelled = order.status === "cancelled";
  const needsDriverUrgent =
    order.fulfillment === "delivery" &&
    !hasDeliveryAssignment(order) &&
    ["confirmed", "in_kitchen", "ready", "out_for_delivery"].includes(order.status);
  const assignmentLabel =
    order.fulfillment !== "delivery"
      ? "Retiro en local"
      : order.riderName
        ? `Interno: ${order.riderName}`
        : order.externalPartner
          ? `Externo: ${order.externalPartner}`
          : "Sin driver";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        {steps.map((step, idx) => {
          const visual = visualClasses(stepTone(step.key, currentKey, cancelled, orderedKeys));
          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-1">
                <div className={`h-1.5 w-1.5 shrink-0 rounded-full border ${visual.dotClass}`} />
                <div className={`truncate text-[10px] leading-none ${visual.textClass}`}>{step.label}</div>
              </div>
              {idx < steps.length - 1 ? <div className={`mx-1 h-[1px] flex-1 rounded-full ${visual.lineClass}`} /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-start justify-between gap-2 text-[10px]">
        <div className={`flex items-center gap-1.5 ${needsDriverUrgent ? "font-semibold text-red-400" : "text-[#8A8A96]"}`}>
          {order.isAsap ? (
            <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-red-300">
              Urgente
            </span>
          ) : null}
          <span>{assignmentLabel}</span>
        </div>
      </div>
    </div>
  );
}

export default function MasterOpsClient({
  currentUserName,
  roles,
  focusDate,
  previousDate,
  nextDate,
  weekLabel,
  activeRate,
  orders,
  stats,
}: Props) {
  const [tray, setTray] = useState<MasterTray>("all");
  const [search, setSearch] = useState("");

  const normalizedSearch = search.trim().toLocaleLowerCase("es-VE");
  const tableOrders = useMemo(() => {
    return orders
      .filter((order) => matchesTray(order, tray))
      .filter((order) => {
        if (!normalizedSearch) return true;
        const haystack = [order.id, order.clientName, order.advisorName, order.status]
          .join(" ")
          .toLocaleLowerCase("es-VE");
        return haystack.includes(normalizedSearch);
      })
      .slice()
      .sort((a, b) => new Date(b.deliveryAtISO).getTime() - new Date(a.deliveryAtISO).getTime());
  }, [normalizedSearch, orders, tray]);

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-5 py-2.5">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5">
                <h1 className="text-base font-semibold leading-none">B. Master 3.0</h1>

                <div className="flex overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
                  <Link className="px-2.5 py-1.5 text-[#B7B7C2] hover:text-[#F5F5F7]" href={`/app/master/ops?focusDate=${previousDate}`}>
                    {"<"}
                  </Link>
                  <div className="min-w-[190px] border-x border-[#242433] px-2.5 py-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Hoy</div>
                        <div className="mt-0.5 text-[12px] font-medium leading-none">{fmtDayLabel(focusDate)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Semana</div>
                        <div className="mt-0.5 text-[10px] leading-tight text-[#B7B7C2]">{weekLabel}</div>
                      </div>
                    </div>
                  </div>
                  <Link className="px-2.5 py-1.5 text-[#B7B7C2] hover:text-[#F5F5F7]" href={`/app/master/ops?focusDate=${nextDate}`}>
                    {">"}
                  </Link>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-left">
                  <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Tasa</div>
                  <div className="mt-0.5 text-[13px] font-medium leading-none text-[#F5F5F7]">
                    {activeRate ? fmtRateBs(activeRate) : "--"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1.5 rounded-2xl border border-[#242433] bg-[#0F0F14] p-1">
                  <TopNavButton label="Operacion" active />
                  <TopNavButton label="Dashboard actual" href="/app/master/dashboard" />
                  <TopNavButton label="Acciones" count={stats.actions} />
                  <TopNavButton label="Seguimiento" count={stats.updates} />
                </div>

                <div className="w-[240px] rounded-2xl border border-[#242433] bg-[#121218] px-3 py-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold leading-none text-[#F5F5F7]">
                        {currentUserName || "Usuario"}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-[#B7B7C2]">
                        {roles.length > 0 ? roles.map((role) => role.toUpperCase()).join(" / ") : "Sin roles"}
                      </div>
                    </div>
                    <Link
                      href="/app"
                      className="shrink-0 rounded-xl border border-[#242433] bg-[#0B0B0D] px-2 py-2 text-[11px] text-[#B7B7C2] hover:text-[#F5F5F7]"
                    >
                      Modulos
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1400px] px-5 py-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1.35fr_0.9fr_0.9fr_0.9fr_0.9fr]">
          <Card title="Estado">
            <div className="grid grid-cols-[1fr_0.55fr_0.55fr] gap-x-2 gap-y-1 text-[11px]">
              <div />
              <div className="text-center text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Hoy</div>
              <div className="text-center text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Semana</div>

              <div className="text-[#B7B7C2]">Cierres</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{stats.day.cierres}</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{stats.week.cierres}</div>

              <div className="text-[#B7B7C2]">Fact. neta</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(stats.day.fact)}</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(stats.week.fact)}</div>

              <div className="text-[#B7B7C2]">Abonado</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(stats.day.abonadoConfirmado)}</div>
              <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(stats.week.abonadoConfirmado)}</div>

              <div className="text-[#B7B7C2]">Pendiente</div>
              <div className="text-center font-semibold text-[#FEEF00]">{fmtUSD(stats.day.pendiente)}</div>
              <div className="text-center font-semibold text-[#FEEF00]">{fmtUSD(stats.week.pendiente)}</div>
            </div>
          </Card>

          <Card title="Pagos por revisar">
            <div className="space-y-1">
              <StatRow label="Por confirmar" value={stats.payments.porConfirmar} highlight />
              <StatRow label="Confirmados" value={stats.payments.confirmados} />
              <StatRow label="Rechazados" value={stats.payments.rechazados} />
            </div>
          </Card>

          <Card title="Deliveries">
            <div className="space-y-1">
              <StatRow label="Internos" value={stats.deliveries.internos} />
              <StatRow label="Externos" value={stats.deliveries.externos} />
            </div>
          </Card>

          <Card title="Cocina">
            <div className="space-y-1">
              <StatRow label="En cocina" value={stats.kitchen.totalEnCocina} />
              <StatRow label="Por tomar" value={stats.kitchen.pendientesToma} highlight />
              <StatRow label="Preparando" value={stats.kitchen.enPreparacion} />
              <StatRow label="Preparados" value={stats.kitchen.preparados} />
            </div>
          </Card>

          <Card title="Tareas urgentes">
            <div className="space-y-1">
              <StatRow label="Por aprobar" value={stats.urgentTasks.approve} highlight />
              <StatRow label="Reaprobar" value={stats.urgentTasks.reapprove} />
              <StatRow label="Enviar a cocina" value={stats.urgentTasks.kitchen} />
              <StatRow label="Asignar driver" value={stats.urgentTasks.driver} />
            </div>
          </Card>
        </div>

        <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-[#242433] bg-[#121218] p-2.5 md:flex-row md:items-center md:justify-between">
          <form
            className="relative w-full md:max-w-md"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar orden o cliente"
              aria-label="Buscar orden o cliente"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] py-1.5 pl-3.5 pr-3 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />
          </form>

          <div className="flex flex-wrap gap-2">
            <Link
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/40"
              href="/app/master/dashboard"
            >
              Nuevo pedido
            </Link>
            <Link
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/40"
              href="/app/master/dashboard"
            >
              Ingreso / Egreso
            </Link>
          </div>
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {trayItems.map((item) => (
            <button
              key={item.key}
              className={[
                "rounded-full border px-3 py-1.5 text-[13px] transition",
                tray === item.key
                  ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                  : "border-[#242433] bg-[#0B0B0D] text-[#B7B7C2] hover:text-[#F5F5F7]",
              ].join(" ")}
              onClick={() => setTray(item.key)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Hora</th>
                  <th className="px-2 py-2 text-left font-medium">Orden</th>
                  <th className="px-2 py-2 text-left font-medium">Asesor</th>
                  <th className="px-2 py-2 text-left font-medium">Cliente</th>
                  <th className="px-2 py-2 text-left font-medium">Tipo</th>
                  <th className="px-2 py-2 text-left font-medium">Total</th>
                  <th className="px-2 py-2 text-left font-medium">Pendiente</th>
                  <th className="px-2 py-2 text-left font-medium">Accion</th>
                  <th className="px-2 py-2 text-left font-medium">Ruta</th>
                </tr>
              </thead>

              <tbody>
                {tableOrders.length === 0 ? (
                  <tr>
                    <td className="px-2 py-6 text-center text-[#B7B7C2]" colSpan={9}>
                      Sin pedidos para este filtro.
                    </td>
                  </tr>
                ) : (
                  tableOrders.map((order, index) => {
                    const zebra = index % 2 === 0 ? "bg-[#121218]" : "bg-[#151522]";
                    const advisorName = splitTwoWordsCompact(order.advisorName);
                    const clientName = splitTwoWordsCompact(order.clientName);
                    const focusTab = getOrderFocusTab(order);
                    const actionLabel = getNextPrimaryActionLabel(order);

                    return (
                      <tr
                        key={order.id}
                        className={`${zebra} cursor-pointer border-b border-[#242433] hover:bg-[#191926]`}
                      >
                        <td className="px-2 py-2" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          {fmtTimeAMPM(order.deliveryAtISO)}
                        </td>
                        <td className="min-w-[104px] px-2 py-2" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          <div className="font-semibold text-[#F5F5F7]">{order.id}</div>
                          <div className="mt-0.5 text-[10px] text-[#8A8A96]">{ORDER_STATUS_LABELS[order.status]}</div>
                        </td>
                        <td className="min-w-[122px] px-2 py-2 leading-4" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          <div>{advisorName.line1}</div>
                          <div className="text-[#B7B7C2]">{advisorName.line2}</div>
                        </td>
                        <td className="min-w-[122px] px-2 py-2 leading-4" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          <div>{clientName.line1}</div>
                          <div className="text-[#B7B7C2]">{clientName.line2}</div>
                          {order.isNewClient ? (
                            <div className="mt-1 inline-flex rounded-full bg-[#FEEF00] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[#0B0B0D]">
                              CLIENTE NUEVO
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px]">
                            {pillLabel(order.fulfillment)}
                          </span>
                        </td>
                        <td className="px-2 py-2" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>{fmtUSD(order.totalUsd)}</td>
                        <td className={["px-2 py-2 font-medium", paymentToneClass(order.balanceUsd)].join(" ")} onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          {fmtUSD(order.balanceUsd)}
                        </td>
                        <td className="min-w-[132px] px-2 py-2">
                          <Link
                            className={[
                              "inline-flex rounded-lg border border-[#242433] bg-[#0B0B0D] px-2 py-1 text-[11px] font-medium transition hover:border-[#FEEF00]/40",
                              focusTab === "pagos"
                                ? "text-orange-200"
                                : focusTab === "entrega"
                                  ? "text-sky-200"
                                  : "text-[#F5F5F7]",
                            ].join(" ")}
                            href={dashboardUrl(order, focusDate, focusTab)}
                          >
                            {actionLabel}
                          </Link>
                        </td>
                        <td className="min-w-[400px] px-2 py-2" onClick={() => window.location.assign(dashboardUrl(order, focusDate))}>
                          <RowProcessTimeline order={order} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}

export function buildOperationStats(orders: MasterOpsOrder[]): OperationStatsSummary {
  const scheduledOrders = orders.filter((order) => isScheduledClosingOrder(order));
  const billingOrders = orders.filter((order) => isRecognizedBillingOrder(order));
  return {
    cierres: scheduledOrders.length,
    fact: billingOrders.reduce((sum, order) => sum + order.totalUsd, 0),
    abonadoConfirmado: billingOrders.reduce((sum, order) => sum + order.confirmedPaidUsd, 0),
    pendiente: billingOrders.reduce((sum, order) => sum + order.balanceUsd, 0),
  };
}
