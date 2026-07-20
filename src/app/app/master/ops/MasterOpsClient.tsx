"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import {
  canCompleteOrder,
  canKitchenTakeOrder,
  canManageOrderDeliveryAssignment,
  canMarkOrderReady,
  canReturnOrderToAdvisor,
  canSendOrderToKitchen,
  canStartOrderDelivery,
  isRecognizedBillingOrder,
  isScheduledClosingOrder,
} from "@/lib/domain/order-domain";
import {
  ORDER_STATUS_LABELS,
  formatOrderDisplayNumber,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";
import {
  approveOrderAction,
  assignExternalPartnerAction,
  assignInternalDriverAction,
  clearDeliveryAssignmentAction,
  confirmPaymentReportAction,
  markDeliveredAction,
  markReadyAction,
  outForDeliveryAction,
  reapproveQueuedOrderAction,
  rejectPaymentReportAction,
  returnToCreatedAction,
  sendToKitchenAction,
} from "../dashboard/actions";
import {
  MASTER_ORDER_DETAIL_TABS,
  MasterOrderDetailBody,
  MasterOrderDetailMetric,
  buildMasterOrderWhatsAppSummary,
  formatMasterOrderDateTime,
  formatMasterOrderRateBs,
  formatMasterOrderTime,
  formatMasterOrderUSD,
  masterOrderPaymentTone,
  type MasterOrderDetailOrder,
  type MasterOrderDetailTab,
  type MasterOrderPaymentReport,
  type MasterOrderPaymentVerify,
} from "../_components/MasterOrderDetailCore";

export type PaymentVerify = MasterOrderPaymentVerify;
export type MasterOpsOrder = MasterOrderDetailOrder;
export type DriverOption = {
  id: string;
  fullName: string;
};
export type DeliveryPartnerOption = {
  id: number;
  name: string;
  partnerType: string;
  whatsappPhone: string | null;
  isActive: boolean;
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
  drivers: DriverOption[];
  deliveryPartners: DeliveryPartnerOption[];
};

type MasterTray = "all" | "pending_created" | "reapproval" | "queued" | "kitchen" | "delivery" | "finalized";
type DetailTab = MasterOrderDetailTab;
type DirectActionKey =
  | "approve"
  | "reapprove"
  | "send-kitchen"
  | "mark-ready"
  | "out-delivery"
  | "complete"
  | "assign-internal"
  | "assign-external"
  | "return-created"
  | "clear-delivery"
  | "confirm-payment"
  | "reject-payment";
type DirectActionPayload = {
  reason?: string;
  recalculatePricing?: boolean;
  etaMinutes?: number | null;
  notes?: string;
  driverUserId?: string;
  partnerId?: number | null;
  reference?: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
  reportId?: number;
  moneyAccountId?: number | null;
  currencyCode?: string | null;
  amount?: number | null;
  movementDate?: string | null;
  exchangeRate?: number | null;
  payerName?: string | null;
  description?: string | null;
  isRetention?: boolean;
};

const trayItems: Array<{ key: MasterTray; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "pending_created", label: "Pendientes" },
  { key: "reapproval", label: "Re-aprobacion" },
  { key: "queued", label: "En cola" },
  { key: "kitchen", label: "Cocina" },
  { key: "delivery", label: "Delivery" },
  { key: "finalized", label: "Finalizadas" },
];

const dayFormatter = new Intl.DateTimeFormat("es-VE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Caracas",
});

function fmtUSD(value: number) {
  return formatMasterOrderUSD(value);
}

function fmtRateBs(value: number) {
  return formatMasterOrderRateBs(value);
}

function fmtTimeAMPM(iso: string) {
  return formatMasterOrderTime(iso);
}

function fmtDayLabel(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00-04:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return dayFormatter.format(date);
}

function caracasDateKeyFromISO(iso: string | null | undefined) {
  if (!iso) return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  return date.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function paymentReportMovementDate(report: MasterOrderPaymentReport) {
  return report.operationDate || caracasDateKeyFromISO(report.createdAt);
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-VE")
    .trim();
}

function orderDisplayNumber(order: Pick<MasterOpsOrder, "id" | "orderNumber">) {
  const value = String(order.orderNumber || "").trim();
  return value || formatOrderDisplayNumber(order.id);
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
  if (order.status === "queued" && order.queuedNeedsReapproval) return "Re-aprobar orden";
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

function directActionsForOrder(order: MasterOpsOrder): Array<{
  key: DirectActionKey;
  label: string;
  tone: "primary" | "green" | "neutral";
}> {
  const actions: Array<{ key: DirectActionKey; label: string; tone: "primary" | "green" | "neutral" }> = [];

  if (order.status === "created" && !order.returnedToAdvisor) {
    actions.push({ key: "approve", label: "Aprobar", tone: "primary" });
  }

  if (order.status === "queued" && order.queuedNeedsReapproval) {
    actions.push({ key: "reapprove", label: "Re-aprobar", tone: "primary" });
  }

  if (canSendOrderToKitchen(order)) {
    actions.push({ key: "send-kitchen", label: "Enviar a cocina", tone: "primary" });
  }

  if (canMarkOrderReady(order)) {
    actions.push({ key: "mark-ready", label: "Marcar lista", tone: "green" });
  }

  if (canCompleteOrder(order)) {
    actions.push({
      key: "complete",
      label: order.fulfillment === "pickup" ? "Marcar retirada" : "Marcar entregada",
      tone: "green",
    });
  }

  return actions;
}

function advancedOperationalLinks(order: MasterOpsOrder): Array<{ label: string; tab: DetailTab; tone: "neutral" | "danger" }> {
  const links: Array<{ label: string; tab: DetailTab; tone: "neutral" | "danger" }> = [];

  if (!["delivered", "cancelled"].includes(order.status)) {
    links.push({ label: "Modificar", tab: "detalle", tone: "neutral" });
  }

  if (order.fulfillment === "delivery") {
    links.push({
      label: hasDeliveryAssignment(order) || order.status === "delivered" ? "Corregir delivery" : "Asignar delivery",
      tab: "entrega",
      tone: "neutral",
    });
  }

  links.push({ label: "Reportar pago", tab: "pagos", tone: "neutral" });
  links.push({ label: "Cambio / fondo", tab: "pagos", tone: "neutral" });

  if (order.status !== "cancelled") {
    links.push({ label: "Cancelar", tab: "ajustes", tone: "danger" });
  }

  return links;
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

function OrderDetailPanel({
  order,
  focusDate,
  activeTab,
  actionError,
  runningAction,
  onTabChange,
  onClose,
  onDirectAction,
  drivers,
  deliveryPartners,
}: {
  order: MasterOpsOrder;
  focusDate: string;
  activeTab: DetailTab;
  actionError: string | null;
  runningAction: string | null;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
  onDirectAction: (order: MasterOpsOrder, action: DirectActionKey, payload?: DirectActionPayload) => Promise<boolean>;
  drivers: DriverOption[];
  deliveryPartners: DeliveryPartnerOption[];
}) {
  const actionLabel = getNextPrimaryActionLabel(order);
  const paidTone = masterOrderPaymentTone(order);
  const directActions = directActionsForOrder(order);
  const advancedLinks = advancedOperationalLinks(order);
  const [returnBoxOpen, setReturnBoxOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnRecalculate, setReturnRecalculate] = useState(false);
  const [deliveryEtaBoxOpen, setDeliveryEtaBoxOpen] = useState(false);
  const [deliveryEtaMinutes, setDeliveryEtaMinutes] = useState("25");
  const [deliveryAssignMode, setDeliveryAssignMode] = useState<null | "internal" | "external">(null);
  const [deliveryAssignDriverId, setDeliveryAssignDriverId] = useState("");
  const [deliveryAssignPartnerId, setDeliveryAssignPartnerId] = useState("");
  const [deliveryAssignDistanceKm, setDeliveryAssignDistanceKm] = useState("");
  const [deliveryAssignCostUsd, setDeliveryAssignCostUsd] = useState("");
  const [deliveryAssignReference, setDeliveryAssignReference] = useState("");
  const [clearDeliveryBoxOpen, setClearDeliveryBoxOpen] = useState(false);
  const [clearDeliveryNotes, setClearDeliveryNotes] = useState("");
  const [paymentRejectReportId, setPaymentRejectReportId] = useState<number | null>(null);
  const [paymentRejectNotes, setPaymentRejectNotes] = useState("");
  const canReturn = canReturnOrderToAdvisor(order);
  const canAssign = canAssignDelivery(order);
  const canOutForDelivery = canStartOrderDelivery(order);
  const canClearDelivery =
    order.fulfillment === "delivery" &&
    canManageOrderDeliveryAssignment(order) &&
    hasDeliveryAssignment(order) &&
    !["delivered", "cancelled"].includes(order.status);
  const busy = Boolean(runningAction);
  const activeDeliveryPartners = deliveryPartners.filter((partner) => partner.isActive);
  const pendingPaymentReports = order.paymentReports.filter((report) => report.status === "pending");

  async function handleCopyWhatsApp() {
    try {
      await navigator.clipboard.writeText(buildMasterOrderWhatsAppSummary(order));
    } catch {
      // Keep the operation panel usable even if clipboard permission is unavailable.
    }
  }

  async function handleReturnSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "return-created", {
      reason: returnReason,
      recalculatePricing: returnRecalculate,
    });
    if (ok) setReturnBoxOpen(false);
  }

  async function handleOutForDeliverySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const etaMinutes = Number(String(deliveryEtaMinutes || "").replace(",", "."));
    const ok = await onDirectAction(order, "out-delivery", {
      etaMinutes: Number.isFinite(etaMinutes) && etaMinutes > 0 ? etaMinutes : null,
    });
    if (ok) setDeliveryEtaBoxOpen(false);
  }

  async function handleClearDeliverySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "clear-delivery", {
      notes: clearDeliveryNotes,
    });
    if (ok) setClearDeliveryBoxOpen(false);
  }

  async function handleAssignInternalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const costUsd = Number(String(deliveryAssignCostUsd || "").replace(",", "."));
    const ok = await onDirectAction(order, "assign-internal", {
      driverUserId: deliveryAssignDriverId,
      costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
    });
    if (ok) setDeliveryAssignMode(null);
  }

  async function handleAssignExternalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const distanceKm = Number(String(deliveryAssignDistanceKm || "").replace(",", "."));
    const costUsd = Number(String(deliveryAssignCostUsd || "").replace(",", "."));
    const ok = await onDirectAction(order, "assign-external", {
      partnerId: Number(deliveryAssignPartnerId || 0),
      reference: deliveryAssignReference.trim() || null,
      distanceKm,
      costUsd,
    });
    if (ok) setDeliveryAssignMode(null);
  }

  async function handleConfirmPayment(report: MasterOrderPaymentReport) {
    const ok = await onDirectAction(order, "confirm-payment", {
      reportId: report.id,
      moneyAccountId: report.moneyAccountId,
      currencyCode: report.currencyCode,
      amount: report.amount,
      movementDate: paymentReportMovementDate(report),
      exchangeRate: report.exchangeRate,
      reference: report.referenceCode,
      payerName: report.payerName,
      description: `Pago confirmado desde Master Ops - orden ${order.id} - reporte ${report.id}`,
      isRetention: Boolean(report.isRetention),
    });
    if (ok) setPaymentRejectReportId(null);
  }

  async function handleRejectPaymentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paymentRejectReportId) return;
    const ok = await onDirectAction(order, "reject-payment", {
      reportId: paymentRejectReportId,
      notes: paymentRejectNotes,
    });
    if (ok) {
      setPaymentRejectReportId(null);
      setPaymentRejectNotes("");
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/55">
      <button className="absolute inset-0 cursor-default" type="button" aria-label="Cerrar detalle" onClick={onClose} />
      <section className="absolute right-0 top-0 flex h-full w-full max-w-[900px] flex-col border-l border-[#242433] bg-[#0B0B0D] shadow-2xl">
        <div className="border-b border-[#242433] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-[#F5F5F7]">Orden #{orderDisplayNumber(order)}</h2>
                <span className="rounded-full border border-[#242433] bg-[#121218] px-2 py-1 text-[11px] text-[#B7B7C2]">
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
                {order.isNewClient ? (
                  <span className="rounded-full bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]">
                    CLIENTE NUEVO
                  </span>
                ) : null}
              </div>
              <div className="mt-1 truncate text-[13px] text-[#B7B7C2]">
                {order.clientName} - {order.advisorName}
              </div>
              <div className="mt-1 text-[11px] text-[#8A8A96]">
                Cliente registrado: {order.clientCreatedAtISO ? formatMasterOrderDateTime(order.clientCreatedAtISO) : "sin fecha"} - Ordenes validas: {order.clientOrderCount}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7] hover:border-[#FEEF00]/50"
                type="button"
                onClick={handleCopyWhatsApp}
              >
                Copiar WS
              </button>
              <button
                className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7] hover:border-[#FEEF00]/50"
                type="button"
                onClick={onClose}
              >
                x
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {MASTER_ORDER_DETAIL_TABS.map((tab) => (
              <button
                key={tab.key}
                className={[
                  "rounded-full border px-3 py-1.5 text-[13px] transition",
                  activeTab === tab.key
                    ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                    : "border-[#242433] bg-[#121218] text-[#B7B7C2] hover:text-[#F5F5F7]",
                ].join(" ")}
                type="button"
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <MasterOrderDetailMetric label="Total" value={formatMasterOrderUSD(order.totalUsd)} />
            <MasterOrderDetailMetric label="Confirmado" value={formatMasterOrderUSD(order.confirmedPaidUsd)} tone="green" />
            <MasterOrderDetailMetric label="Pendiente" value={formatMasterOrderUSD(order.balanceUsd)} tone={paidTone} />
          </div>

          <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[13px] font-semibold text-[#F5F5F7]">Accion operativa</div>
                <div className="mt-1 text-[12px] text-[#B7B7C2]">{actionLabel}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {directActions.length > 0 ? (
                  directActions.map((action) => {
                    const isRunning = runningAction === `${action.key}:${order.id}`;
                    const className =
                      action.tone === "green"
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                        : action.tone === "primary"
                          ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                          : "border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]";

                    return (
                      <button
                        key={action.key}
                        className={`rounded-xl border px-3 py-2 text-sm font-semibold disabled:cursor-wait disabled:opacity-60 ${className}`}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void onDirectAction(order, action.key);
                        }}
                      >
                        {isRunning ? "Procesando..." : action.label}
                      </button>
                    );
                  })
                ) : (
                  <Link
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
                    href={dashboardUrl(order, focusDate, activeTab)}
                  >
                    Resolver en detalle
                  </Link>
                )}
                <Link
                  className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm font-semibold text-[#B7B7C2] hover:border-[#FEEF00]/50 hover:text-[#F5F5F7]"
                  href={dashboardUrl(order, focusDate, activeTab)}
                >
                  Detalle actual
                </Link>
              </div>
            </div>
            {(canReturn || canAssign || canOutForDelivery || canClearDelivery) ? (
              <div className="mt-3 border-t border-[#242433] pt-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8A8A96]">
                  Acciones rapidas
                </div>
                <div className="flex flex-wrap gap-2">
                  {canOutForDelivery ? (
                    <button
                      className="rounded-xl border border-sky-500/45 bg-sky-500/10 px-3 py-1.5 text-[12px] font-semibold text-sky-200 transition hover:border-sky-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setDeliveryEtaBoxOpen((value) => !value)}
                    >
                      Enviar a delivery
                    </button>
                  ) : null}
                  {canAssign ? (
                    <>
                      <button
                        className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FEEF00] transition hover:border-[#FEEF00] disabled:cursor-wait disabled:opacity-60"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeliveryAssignMode((value) => value === "internal" ? null : "internal")}
                      >
                        Asignar interno
                      </button>
                      <button
                        className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FEEF00] transition hover:border-[#FEEF00] disabled:cursor-wait disabled:opacity-60"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeliveryAssignMode((value) => value === "external" ? null : "external")}
                      >
                        Asignar externo
                      </button>
                    </>
                  ) : null}
                  {canReturn ? (
                    <button
                      className="rounded-xl border border-orange-500/45 bg-orange-500/10 px-3 py-1.5 text-[12px] font-semibold text-orange-200 transition hover:border-orange-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setReturnBoxOpen((value) => !value)}
                    >
                      Devolver al asesor
                    </button>
                  ) : null}
                  {canClearDelivery ? (
                    <button
                      className="rounded-xl border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] font-semibold text-red-200 transition hover:border-red-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setClearDeliveryBoxOpen((value) => !value)}
                    >
                      Quitar asignacion
                    </button>
                  ) : null}
                </div>

                {deliveryEtaBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3" onSubmit={handleOutForDeliverySubmit}>
                    <div className="text-[12px] font-semibold text-sky-100">Salida a delivery</div>
                    <div className="mt-1 text-[11px] text-sky-100/80">Indica el ETA que se le informara al asesor y al cliente.</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {["15", "20", "25", "30"].map((minutes) => (
                        <button
                          key={minutes}
                          className={[
                            "rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition",
                            deliveryEtaMinutes === minutes
                              ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                              : "border-sky-500/30 bg-[#0B0B0D] text-sky-100 hover:border-sky-400",
                          ].join(" ")}
                          type="button"
                          disabled={busy}
                          onClick={() => setDeliveryEtaMinutes(minutes)}
                        >
                          {minutes} min
                        </button>
                      ))}
                      <input
                        className="min-w-[110px] rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[12px] text-[#F5F5F7]"
                        value={deliveryEtaMinutes}
                        onChange={(event) => setDeliveryEtaMinutes(event.target.value)}
                        inputMode="numeric"
                        placeholder="ETA"
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-sky-400 bg-sky-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `out-delivery:${order.id}` ? "Confirmando..." : "Confirmar salida"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {deliveryAssignMode === "internal" ? (
                  <form className="mt-3 rounded-xl border border-[#FEEF00]/30 bg-[#FEEF00]/10 p-3" onSubmit={handleAssignInternalSubmit}>
                    <div className="text-[12px] font-semibold text-[#FEEF00]">Asignar motorizado interno</div>
                    <select
                      className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                      value={deliveryAssignDriverId}
                      onChange={(event) => setDeliveryAssignDriverId(event.target.value)}
                    >
                      <option value="">Seleccionar motorizado</option>
                      {drivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.fullName}
                        </option>
                      ))}
                    </select>
                    <input
                      className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={deliveryAssignCostUsd}
                      onChange={(event) => setDeliveryAssignCostUsd(event.target.value)}
                      inputMode="decimal"
                      placeholder="Pago interno USD opcional"
                    />
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `assign-internal:${order.id}` ? "Asignando..." : "Guardar interno"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {deliveryAssignMode === "external" ? (
                  <form className="mt-3 rounded-xl border border-[#FEEF00]/30 bg-[#FEEF00]/10 p-3" onSubmit={handleAssignExternalSubmit}>
                    <div className="text-[12px] font-semibold text-[#FEEF00]">Asignar partner externo</div>
                    <select
                      className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                      value={deliveryAssignPartnerId}
                      onChange={(event) => setDeliveryAssignPartnerId(event.target.value)}
                    >
                      <option value="">Seleccionar partner</option>
                      {activeDeliveryPartners.map((partner) => (
                        <option key={partner.id} value={partner.id}>
                          {partner.name}
                        </option>
                      ))}
                    </select>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <input
                        className="rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        value={deliveryAssignDistanceKm}
                        onChange={(event) => setDeliveryAssignDistanceKm(event.target.value)}
                        inputMode="decimal"
                        placeholder="Distancia km"
                      />
                      <input
                        className="rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        value={deliveryAssignCostUsd}
                        onChange={(event) => setDeliveryAssignCostUsd(event.target.value)}
                        inputMode="decimal"
                        placeholder="Costo USD"
                      />
                    </div>
                    <input
                      className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={deliveryAssignReference}
                      onChange={(event) => setDeliveryAssignReference(event.target.value)}
                      placeholder="Referencia externa opcional"
                    />
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `assign-external:${order.id}` ? "Asignando..." : "Guardar externo"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {returnBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-orange-500/30 bg-orange-500/10 p-3" onSubmit={handleReturnSubmit}>
                    <div className="text-[12px] font-semibold text-orange-100">Devolver al asesor</div>
                    <textarea
                      className="mt-3 min-h-[86px] w-full rounded-lg border border-orange-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={returnReason}
                      onChange={(event) => setReturnReason(event.target.value)}
                      placeholder="Motivo claro para que el asesor pueda corregir."
                    />
                    <label className="mt-3 flex items-start gap-2 text-[12px] text-orange-100/85">
                      <input
                        className="mt-0.5 accent-[#FEEF00]"
                        type="checkbox"
                        checked={returnRecalculate}
                        onChange={(event) => setReturnRecalculate(event.target.checked)}
                      />
                      <span>Solicitar recalculo de precios y tasa.</span>
                    </label>
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-orange-400 bg-orange-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `return-created:${order.id}` ? "Devolviendo..." : "Confirmar devolucion"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {clearDeliveryBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3" onSubmit={handleClearDeliverySubmit}>
                    <div className="text-[12px] font-semibold text-red-100">Quitar asignacion de delivery</div>
                    <textarea
                      className="mt-3 min-h-[74px] w-full rounded-lg border border-red-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={clearDeliveryNotes}
                      onChange={(event) => setClearDeliveryNotes(event.target.value)}
                      placeholder="Motivo de la correccion."
                    />
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-red-400 bg-red-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `clear-delivery:${order.id}` ? "Quitando..." : "Quitar asignacion"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}
            {activeTab === "pagos" && pendingPaymentReports.length > 0 ? (
              <div className="mt-3 border-t border-[#242433] pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8A8A96]">
                    Pagos por revisar
                  </div>
                  <div className="rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-200">
                    {pendingPaymentReports.length}
                  </div>
                </div>
                <div className="space-y-2">
                  {pendingPaymentReports.map((report) => {
                    const predictedExcessUsd = Number(
                      Math.max(0, order.confirmedPaidUsd + report.usdEquivalent - order.totalUsd).toFixed(2)
                    );
                    const requiresFullDashboard = predictedExcessUsd > 0.005;
                    const isRunningConfirm = runningAction === `confirm-payment:${order.id}`;
                    const isRunningReject = runningAction === `reject-payment:${order.id}`;

                    return (
                      <div key={report.id} className="rounded-xl border border-orange-500/25 bg-orange-500/10 p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-[#F5F5F7]">
                              {report.currencyCode} {report.amount.toFixed(2)} - {formatMasterOrderUSD(report.usdEquivalent)}
                            </div>
                            <div className="mt-1 text-[11px] text-orange-100/80">
                              {report.moneyAccountName} - Operacion {paymentReportMovementDate(report)}
                            </div>
                            <div className="mt-1 text-[11px] text-[#B7B7C2]">
                              Ref. <span className="text-[#F5F5F7]">{report.referenceCode || "--"}</span>
                              {" - "}
                              Reporta <span className="text-[#F5F5F7]">{report.reporterName}</span>
                            </div>
                            {requiresFullDashboard ? (
                              <div className="mt-2 text-[11px] text-[#FEEF00]">
                                Hay excedente de {formatMasterOrderUSD(predictedExcessUsd)}. Resuelve cambio, fondo o diferencia en el detalle completo.
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {requiresFullDashboard ? (
                              <Link
                                className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-1.5 text-[12px] font-semibold text-[#0B0B0D]"
                                href={dashboardUrl(order, focusDate, "pagos")}
                              >
                                Resolver
                              </Link>
                            ) : (
                              <button
                                className="rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 disabled:cursor-wait disabled:opacity-60"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  void handleConfirmPayment(report);
                                }}
                              >
                                {isRunningConfirm ? "Confirmando..." : "Confirmar"}
                              </button>
                            )}
                            <button
                              className="rounded-xl border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] font-semibold text-red-200 disabled:cursor-wait disabled:opacity-60"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setPaymentRejectReportId((current) => (current === report.id ? null : report.id));
                                setPaymentRejectNotes("");
                              }}
                            >
                              Rechazar
                            </button>
                          </div>
                        </div>
                        {paymentRejectReportId === report.id ? (
                          <form className="mt-3 rounded-xl border border-red-500/30 bg-[#0B0B0D] p-3" onSubmit={handleRejectPaymentSubmit}>
                            <textarea
                              className="min-h-[74px] w-full rounded-lg border border-red-500/30 bg-[#121218] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                              value={paymentRejectNotes}
                              onChange={(event) => setPaymentRejectNotes(event.target.value)}
                              placeholder="Motivo obligatorio para que el asesor entienda que corregir."
                            />
                            <div className="mt-2 flex justify-end">
                              <button
                                className="rounded-xl border border-red-400 bg-red-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                                type="submit"
                                disabled={busy}
                              >
                                {isRunningReject ? "Rechazando..." : "Confirmar rechazo"}
                              </button>
                            </div>
                          </form>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {advancedLinks.length > 0 ? (
              <div className="mt-3 border-t border-[#242433] pt-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8A8A96]">
                  Acciones completas
                </div>
                <div className="flex flex-wrap gap-2">
                  {advancedLinks.map((link) => (
                    <Link
                      key={link.label}
                      className={[
                        "rounded-xl border px-3 py-1.5 text-[12px] font-semibold transition",
                        link.tone === "danger"
                          ? "border-red-500/45 bg-red-500/10 text-red-200 hover:border-red-400"
                          : "border-[#242433] bg-[#0B0B0D] text-[#B7B7C2] hover:border-[#FEEF00]/50 hover:text-[#F5F5F7]",
                      ].join(" ")}
                      href={dashboardUrl(order, focusDate, link.tab)}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {actionError ? (
              <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {actionError}
              </div>
            ) : null}
          </div>

          <MasterOrderDetailBody actionLabel={actionLabel} activeTab={activeTab} order={order} />

        </div>
      </section>
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
  drivers,
  deliveryPartners,
}: Props) {
  const router = useRouter();
  const [tray, setTray] = useState<MasterTray>("all");
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = useState<DetailTab>("detalle");
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const normalizedSearch = normalizeSearchText(search);
  const trayCounts = useMemo(() => {
    return new Map(trayItems.map((item) => [item.key, orders.filter((order) => matchesTray(order, item.key)).length]));
  }, [orders]);
  const tableOrders = useMemo(() => {
    return orders
      .filter((order) => matchesTray(order, tray))
      .filter((order) => {
        if (!normalizedSearch) return true;
        const haystack = [
          order.id,
          orderDisplayNumber(order),
          order.clientName,
          order.clientPhone,
          order.receiverName,
          order.receiverPhone,
          order.advisorName,
          order.address,
          order.status,
          ORDER_STATUS_LABELS[order.status],
        ]
          .join(" ")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase("es-VE");
        return haystack.includes(normalizedSearch);
      })
      .slice()
      .sort((a, b) => new Date(b.deliveryAtISO).getTime() - new Date(a.deliveryAtISO).getTime());
  }, [normalizedSearch, orders, tray]);
  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  );

  function openOrder(order: MasterOpsOrder, tab: DetailTab = "detalle") {
    setSelectedOrderId(order.id);
    setSelectedDetailTab(tab);
    setActionError(null);
  }

  async function runDirectOrderAction(order: MasterOpsOrder, action: DirectActionKey, payload: DirectActionPayload = {}) {
    const actionId = `${action}:${order.id}`;
    setRunningAction(actionId);
    setActionError(null);

    try {
      let result: unknown = null;

      if (action === "approve") {
        result = await approveOrderAction({ orderId: order.id });
      } else if (action === "reapprove") {
        result = await reapproveQueuedOrderAction({
          orderId: order.id,
          notes: "Re-aprobado desde modulo operativo.",
        });
      } else if (action === "send-kitchen") {
        result = await sendToKitchenAction({ orderId: order.id });
      } else if (action === "mark-ready") {
        result = await markReadyAction({ orderId: order.id });
      } else if (action === "out-delivery") {
        result = await outForDeliveryAction({
          orderId: order.id,
          etaMinutes: payload.etaMinutes ?? null,
        });
      } else if (action === "complete") {
        result = await markDeliveredAction({ orderId: order.id });
      } else if (action === "assign-internal") {
        const driverUserId = String(payload.driverUserId || "").trim();
        if (!driverUserId) throw new Error("Debes seleccionar un motorizado interno.");
        result = await assignInternalDriverAction({
          orderId: order.id,
          driverUserId,
          costUsd: payload.costUsd != null ? Math.max(0, Number(payload.costUsd || 0)) : null,
        });
      } else if (action === "assign-external") {
        const partnerId = Number(payload.partnerId || 0);
        const distanceKm = Number(payload.distanceKm);
        const costUsd = Number(payload.costUsd);
        if (!Number.isFinite(partnerId) || partnerId <= 0) throw new Error("Debes seleccionar un partner externo.");
        if (!Number.isFinite(distanceKm) || distanceKm <= 0) throw new Error("Debes indicar la distancia en km.");
        if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Debes indicar el costo del delivery.");
        result = await assignExternalPartnerAction({
          orderId: order.id,
          partnerId,
          reference: payload.reference ?? null,
          distanceKm,
          costUsd,
        });
      } else if (action === "return-created") {
        result = await returnToCreatedAction({
          orderId: order.id,
          reason: payload.reason ?? "",
          recalculatePricing: Boolean(payload.recalculatePricing),
        });
      } else if (action === "clear-delivery") {
        result = await clearDeliveryAssignmentAction({
          orderId: order.id,
          notes: payload.notes?.trim() || "Asignacion removida desde modulo operativo.",
        });
      } else if (action === "confirm-payment") {
        const reportId = Number(payload.reportId || 0);
        const moneyAccountId = Number(payload.moneyAccountId || 0);
        const currencyCode = String(payload.currencyCode || "").trim().toUpperCase();
        const amount = Number(payload.amount);
        const movementDate = String(payload.movementDate || "").trim();
        if (!Number.isFinite(reportId) || reportId <= 0) throw new Error("No se pudo identificar el reporte de pago.");
        if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) throw new Error("El reporte no tiene cuenta asociada.");
        if (!currencyCode) throw new Error("El reporte no tiene moneda valida.");
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("El reporte no tiene monto valido.");
        if (!movementDate) throw new Error("El reporte no tiene fecha de operacion.");
        result = await confirmPaymentReportAction({
          reportId,
          orderId: order.id,
          clientId: null,
          confirmedMoneyAccountId: moneyAccountId,
          confirmedCurrency: currencyCode,
          confirmedAmount: amount,
          movementDate,
          confirmedExchangeRateVesPerUsd: payload.exchangeRate ?? null,
          reviewNotes: "Confirmado desde modulo operativo.",
          referenceCode: payload.reference ?? null,
          counterpartyName: payload.payerName ?? null,
          description: payload.description ?? `Pago confirmado desde Master Ops - orden ${order.id} - reporte ${reportId}`,
          paymentKind: payload.isRetention ? "retention" : null,
          overpaymentHandling: null,
        });
      } else if (action === "reject-payment") {
        const reportId = Number(payload.reportId || 0);
        const reviewNotes = String(payload.notes || "").trim();
        if (!Number.isFinite(reportId) || reportId <= 0) throw new Error("No se pudo identificar el reporte de pago.");
        if (!reviewNotes) throw new Error("Debes indicar un motivo de rechazo.");
        result = await rejectPaymentReportAction({
          reportId,
          reviewNotes,
        });
      }

      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const message = "message" in result && typeof result.message === "string" ? result.message : "No se pudo procesar la accion.";
        throw new Error(message);
      }

      startTransition(() => {
        router.refresh();
      });
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo procesar la accion.");
      return false;
    } finally {
      setRunningAction(null);
    }
  }

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
              <span>{item.label}</span>
              <span className="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold">
                {trayCounts.get(item.key) ?? 0}
              </span>
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
                        onClick={() => openOrder(order, focusTab)}
                      >
                        <td className="px-2 py-2">
                          {fmtTimeAMPM(order.deliveryAtISO)}
                        </td>
                        <td className="min-w-[104px] px-2 py-2">
                          <div className="font-semibold text-[#F5F5F7]">{orderDisplayNumber(order)}</div>
                          <div className="mt-0.5 text-[10px] text-[#8A8A96]">{ORDER_STATUS_LABELS[order.status]}</div>
                        </td>
                        <td className="min-w-[122px] px-2 py-2 leading-4">
                          <div>{advisorName.line1}</div>
                          <div className="text-[#B7B7C2]">{advisorName.line2}</div>
                        </td>
                        <td className="min-w-[122px] px-2 py-2 leading-4">
                          <div>{clientName.line1}</div>
                          <div className="text-[#B7B7C2]">{clientName.line2}</div>
                          {order.isNewClient ? (
                            <div className="mt-1 inline-flex rounded-full bg-[#FEEF00] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[#0B0B0D]">
                              CLIENTE NUEVO
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2">
                          <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px]">
                            {pillLabel(order.fulfillment)}
                          </span>
                        </td>
                        <td className="px-2 py-2">{fmtUSD(order.totalUsd)}</td>
                        <td className={["px-2 py-2 font-medium", paymentToneClass(order.balanceUsd)].join(" ")}>
                          {fmtUSD(order.balanceUsd)}
                        </td>
                        <td className="min-w-[132px] px-2 py-2">
                          <button
                            className={[
                              "inline-flex rounded-lg border border-[#242433] bg-[#0B0B0D] px-2 py-1 text-[11px] font-medium transition hover:border-[#FEEF00]/40",
                              focusTab === "pagos"
                                ? "text-orange-200"
                                : focusTab === "entrega"
                                  ? "text-sky-200"
                                  : "text-[#F5F5F7]",
                            ].join(" ")}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openOrder(order, focusTab);
                            }}
                          >
                            {actionLabel}
                          </button>
                        </td>
                        <td className="min-w-[400px] px-2 py-2">
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
      {selectedOrder ? (
        <OrderDetailPanel
          key={selectedOrder.id}
          order={selectedOrder}
          focusDate={focusDate}
          activeTab={selectedDetailTab}
          actionError={actionError}
          runningAction={runningAction}
          onTabChange={setSelectedDetailTab}
          onClose={() => setSelectedOrderId(null)}
          onDirectAction={runDirectOrderAction}
          drivers={drivers}
          deliveryPartners={deliveryPartners}
        />
      ) : null}
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
