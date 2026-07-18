"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
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
  getPaymentMethodLabel,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";
import {
  buildWhatsAppOrderSummaryText,
  cleanWhatsAppUnitsFromName,
  formatWhatsAppQuantity,
  getWhatsAppLineUnits,
} from "@/lib/orders/whatsapp-summary";
import {
  approveOrderAction,
  markDeliveredAction,
  markReadyAction,
  sendToKitchenAction,
} from "../dashboard/actions";

export type PaymentVerify = "none" | "pending" | "confirmed" | "rejected";

export type MasterOpsOrderLine = {
  name: string;
  qty: number;
  unitsPerService: number;
  priceBs: number;
  lineTotalUsd: number;
  productType?: string | null;
  isDelivery?: boolean;
  editableDetailLines?: string[];
};

export type MasterOpsPaymentReport = {
  id: number;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string | null;
  reporterName: string;
  currencyCode: string;
  amount: number;
  exchangeRate: number | null;
  usdEquivalent: number;
  moneyAccountName: string;
  referenceCode: string | null;
  payerName: string | null;
  notes: string | null;
};

export type MasterOpsOrderEvent = {
  id: string;
  title: string;
  message: string | null;
  severity: "info" | "warning" | "critical";
  actorName: string;
  createdAt: string;
};

export type MasterOpsAdminAdjustment = {
  id: number;
  adjustmentType: string;
  reason: string;
  notes: string | null;
  createdAt: string;
  createdByName: string;
};

export type MasterOpsOrder = {
  id: number;
  orderNumber: string;
  status: OrderStatus;
  fulfillment: FulfillmentType;
  advisorName: string;
  clientName: string;
  clientPhone: string | null;
  clientCreatedAtISO: string | null;
  clientOrderCount: number;
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
  address: string | null;
  notes: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryGpsUrl: string | null;
  deliveryDistanceKm: number | null;
  deliveryCostUsd: number | null;
  paymentMethod: string | null;
  paymentCurrency: "USD" | "VES" | null;
  paymentRequiresChange: boolean;
  paymentChangeFor: string | null;
  paymentChangeCurrency: "USD" | "VES" | null;
  paymentNote: string | null;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string | null;
  invoiceSnapshot: {
    companyName: string | null;
    taxId: string | null;
    address: string | null;
    phone: string | null;
  } | null;
  deliveryNoteSnapshot: {
    name: string | null;
    documentId: string | null;
    address: string | null;
    phone: string | null;
  } | null;
  fxRate: number | null;
  discountPct: number | null;
  discountAmountUsd: number;
  discountAmountBs: number;
  invoiceTaxPct: number | null;
  invoiceTaxAmountUsd: number;
  invoiceTaxAmountBs: number;
  subtotalUsd: number | null;
  subtotalBs: number | null;
  subtotalAfterDiscountUsd: number | null;
  subtotalAfterDiscountBs: number | null;
  lines: MasterOpsOrderLine[];
  paymentReports: MasterOpsPaymentReport[];
  events: MasterOpsOrderEvent[];
  adminAdjustments: MasterOpsAdminAdjustment[];
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
type DetailTab = "detalle" | "entrega" | "pagos" | "eventos" | "notas" | "ajustes";
type DirectActionKey = "approve" | "send-kitchen" | "mark-ready" | "complete";

const trayItems: Array<{ key: MasterTray; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "pending_created", label: "Pendientes" },
  { key: "reapproval", label: "Re-aprobacion" },
  { key: "queued", label: "En cola" },
  { key: "kitchen", label: "Cocina" },
  { key: "delivery", label: "Delivery" },
  { key: "finalized", label: "Finalizadas" },
];

const detailTabs: Array<{ key: DetailTab; label: string }> = [
  { key: "detalle", label: "Pedido" },
  { key: "entrega", label: "Entrega" },
  { key: "pagos", label: "Pagos" },
  { key: "eventos", label: "Eventos" },
  { key: "notas", label: "Notas" },
  { key: "ajustes", label: "Ajustes" },
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

const detailDateFormatter = new Intl.DateTimeFormat("es-VE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  timeZone: "America/Caracas",
});

function fmtUSD(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function fmtBs(value: number | null | undefined) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "Bs --";

  const fixed = Math.abs(n).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  let out = "";
  for (let index = 0; index < intPart.length; index += 1) {
    const indexFromEnd = intPart.length - index;
    out += intPart[index];
    if (indexFromEnd > 1 && indexFromEnd % 3 === 1) out += ".";
  }

  return `Bs ${n < 0 ? "-" : ""}${out},${decPart}`;
}

function fmtRateBs(value: number) {
  return `Bs ${Number(value || 0).toFixed(2)}`;
}

function fmtTimeAMPM(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return timeFormatter.format(date);
}

function fmtDate(iso: string | null) {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return detailDateFormatter.format(date);
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "--";
  return `${fmtDate(iso)} - ${fmtTimeAMPM(iso)}`;
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

function orderMainLinesForPreview(lines: MasterOpsOrderLine[]) {
  const services: MasterOpsOrderLine[] = [];
  const extras: MasterOpsOrderLine[] = [];
  const delivery: MasterOpsOrderLine[] = [];

  for (const line of lines) {
    const lower = line.name.toLowerCase();
    const isDelivery = Boolean(line.isDelivery) || lower.startsWith("delivery");
    if (isDelivery) {
      delivery.push(line);
      continue;
    }

    const isExtra =
      lower.includes("salsa") ||
      lower.includes("aderezo") ||
      lower.includes("crema") ||
      lower.includes("pepsi") ||
      lower.includes("coca") ||
      lower.includes("malta") ||
      lower.includes("jugo") ||
      lower.includes("dondy");

    if (isExtra) extras.push(line);
    else services.push(line);
  }

  return [...services, ...extras, ...delivery];
}

function getLineUnits(line: MasterOpsOrderLine) {
  return getWhatsAppLineUnits({
    qty: line.qty,
    name: line.name,
    unitsPerService: line.unitsPerService,
  });
}

function lineTextWhatsAppStyle(line: MasterOpsOrderLine) {
  const units = getLineUnits(line);
  const isDelivery = Boolean(line.isDelivery) || line.name.toLowerCase().startsWith("delivery");
  const bs = fmtBs(line.qty * line.priceBs);

  if (isDelivery) return `- ${formatWhatsAppQuantity(line.qty)} ${line.name}: ${bs}`;

  if (units !== null) {
    const cleanName = cleanWhatsAppUnitsFromName(line.name);
    if (line.productType === "service") {
      return `- ${formatWhatsAppQuantity(line.qty)} Serv. ${cleanName} (${formatWhatsAppQuantity(units)} und): ${bs}`;
    }
    return `- ${formatWhatsAppQuantity(line.qty)} ${cleanName} (${formatWhatsAppQuantity(units)} und): ${bs}`;
  }

  return `- ${formatWhatsAppQuantity(line.qty)} ${line.name}: ${bs}`;
}

function paymentChangeText(order: MasterOpsOrder) {
  if (!order.paymentRequiresChange) return null;
  if (!order.paymentChangeFor) return "Si";
  return `${order.paymentChangeFor} ${order.paymentChangeCurrency || ""}`.trim();
}

function buildWhatsAppSummary(order: MasterOpsOrder) {
  const deliveryDateText = fmtDate(order.deliveryAtISO);
  const deliveryTimeText = order.isAsap ? "Lo antes posible" : fmtTimeAMPM(order.deliveryAtISO);
  const subtotalBs = order.subtotalBs ?? order.totalBs ?? 0;
  const subtotalUsd = order.subtotalUsd ?? order.totalUsd;

  return buildWhatsAppOrderSummaryText({
    title: "Resumen de Pedido",
    orderLabel: String(order.id),
    advisorName: order.advisorName,
    clientName: order.clientName,
    clientPhone: order.clientPhone,
    receiverName: order.receiverName,
    receiverPhone: order.receiverPhone,
    lines: orderMainLinesForPreview(order.lines).map((line) => ({
      text: lineTextWhatsAppStyle(line).replace(/^- /, ""),
      detailLines: line.editableDetailLines ?? [],
    })),
    price: {
      subtotalBs,
      subtotalUsd,
      discountPct: order.discountPct,
      discountAmountBs: order.discountAmountBs,
      discountAmountUsd: order.discountAmountUsd,
      invoiceTaxPct: order.invoiceTaxPct,
      invoiceTaxAmountBs: order.invoiceTaxAmountBs,
      invoiceTaxAmountUsd: order.invoiceTaxAmountUsd,
      totalBs: order.totalBs ?? 0,
      totalUsd: order.totalUsd,
    },
    fulfillment: order.fulfillment,
    deliveryText: `${deliveryDateText} - ${deliveryTimeText}`,
    deliveryDateText,
    deliveryTimeText,
    address: order.address,
    gpsUrl: order.deliveryGpsUrl,
    paymentMethodLabel: getPaymentMethodLabel(order.paymentMethod || ""),
    paymentChangeText: paymentChangeText(order),
    paymentNote: order.paymentNote,
    paymentStatus: paymentVerifyLabel(order),
    invoice: order.hasInvoice
      ? {
          enabled: true,
          companyName: order.invoiceSnapshot?.companyName,
          taxId: order.invoiceSnapshot?.taxId,
          address: order.invoiceSnapshot?.address,
          phone: order.invoiceSnapshot?.phone,
        }
      : null,
    deliveryNote: order.hasDeliveryNote
      ? {
          enabled: true,
          name: order.deliveryNoteSnapshot?.name,
          documentId: order.deliveryNoteSnapshot?.documentId,
          address: order.deliveryNoteSnapshot?.address,
          phone: order.deliveryNoteSnapshot?.phone,
        }
      : null,
    notes: order.notes,
  });
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

function paymentVerifyLabel(order: MasterOpsOrder) {
  if (order.balanceUsd <= 0.005) return "Pagado";
  if (order.paymentVerify === "pending") return "Pago por revisar";
  if (order.paymentVerify === "rejected") return "Pago rechazado";
  if (order.paymentVerify === "confirmed") return "Pago parcial";
  return "Pendiente";
}

function assignmentText(order: MasterOpsOrder) {
  if (order.fulfillment !== "delivery") return "Retiro en local";
  if (order.riderName) return `Interno: ${order.riderName}`;
  if (order.externalPartner) return `Externo: ${order.externalPartner}`;
  return "Sin driver";
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
    links.push({ label: "Devolver al asesor", tab: "detalle", tone: "neutral" });
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

function DetailMetric({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "normal" | "yellow" | "green" | "orange";
}) {
  const valueClass =
    tone === "yellow"
      ? "text-[#FEEF00]"
      : tone === "green"
        ? "text-[#7FE7C4]"
        : tone === "orange"
          ? "text-orange-300"
          : "text-[#F5F5F7]";

  return (
    <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
      <div className="text-[11px] text-[#8A8A96]">{label}</div>
      <div className={`mt-1 text-[15px] font-semibold ${valueClass}`}>{value}</div>
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
}: {
  order: MasterOpsOrder;
  focusDate: string;
  activeTab: DetailTab;
  actionError: string | null;
  runningAction: string | null;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
  onDirectAction: (order: MasterOpsOrder, action: DirectActionKey) => void;
}) {
  const actionLabel = getNextPrimaryActionLabel(order);
  const paymentLabel = paymentVerifyLabel(order);
  const paidTone = order.balanceUsd <= 0.005 ? "green" : "orange";
  const directActions = directActionsForOrder(order);
  const advancedLinks = advancedOperationalLinks(order);
  const deliveryText = order.isAsap ? `${fmtDate(order.deliveryAtISO)} - Lo antes posible` : fmtDateTime(order.deliveryAtISO);

  async function handleCopyWhatsApp() {
    try {
      await navigator.clipboard.writeText(buildWhatsAppSummary(order));
    } catch {
      // Keep the operation panel usable even if clipboard permission is unavailable.
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
                <h2 className="text-lg font-semibold text-[#F5F5F7]">Orden #{order.id}</h2>
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
                Cliente registrado: {order.clientCreatedAtISO ? fmtDateTime(order.clientCreatedAtISO) : "sin fecha"} - Ordenes validas: {order.clientOrderCount}
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
            {detailTabs.map((tab) => (
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
            <DetailMetric label="Total" value={fmtUSD(order.totalUsd)} />
            <DetailMetric label="Confirmado" value={fmtUSD(order.confirmedPaidUsd)} tone="green" />
            <DetailMetric label="Pendiente" value={fmtUSD(order.balanceUsd)} tone={paidTone} />
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
                        disabled={Boolean(runningAction)}
                        onClick={() => onDirectAction(order, action.key)}
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

          {activeTab === "detalle" ? (
            <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
              <div className="text-sm font-semibold text-[#F5F5F7]">Pedido</div>

              <div className="mt-3 space-y-2 text-sm">
                {orderMainLinesForPreview(order.lines).length === 0 ? (
                  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-[#B7B7C2]">
                    Sin items cargados.
                  </div>
                ) : (
                  orderMainLinesForPreview(order.lines).map((line, index) => (
                    <div key={`${line.name}-${index}`} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                      <div className="font-medium text-[#F5F5F7]">{lineTextWhatsAppStyle(line)}</div>
                      {line.editableDetailLines && line.editableDetailLines.length > 0 ? (
                        <div className="mt-1 space-y-1 pl-4 text-xs text-[#B7B7C2]">
                          {line.editableDetailLines.slice(0, 12).map((text, detailIndex) => (
                            <div key={`${line.name}-${detailIndex}`}>- {text}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              <div className="mt-3 space-y-1 border-t border-[#242433] pt-3 text-xs">
                <div className="flex items-center justify-between text-[#8A8A96]">
                  <span>Tasa snapshot</span>
                  <span>{order.fxRate != null && order.fxRate > 0 ? fmtRateBs(order.fxRate) : "--"}</span>
                </div>
                <div className="flex items-center justify-between text-[#B7B7C2]">
                  <span>Subtotal</span>
                  <span>{fmtBs(order.subtotalBs ?? order.totalBs ?? 0)} / {fmtUSD(order.subtotalUsd ?? order.totalUsd)}</span>
                </div>
                {order.discountAmountUsd > 0.005 || order.discountAmountBs > 0.5 ? (
                  <div className="flex items-center justify-between text-orange-300">
                    <span>Descuento{order.discountPct != null ? ` (${order.discountPct}%)` : ""}</span>
                    <span>-{fmtBs(order.discountAmountBs)} / -{fmtUSD(order.discountAmountUsd)}</span>
                  </div>
                ) : null}
                {order.invoiceTaxAmountUsd > 0.005 || order.invoiceTaxAmountBs > 0.5 ? (
                  <div className="flex items-center justify-between text-sky-300">
                    <span>IVA{order.invoiceTaxPct != null ? ` (${order.invoiceTaxPct}%)` : ""}</span>
                    <span>+{fmtBs(order.invoiceTaxAmountBs)} / +{fmtUSD(order.invoiceTaxAmountUsd)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-sm font-semibold text-[#F5F5F7]">
                  <span>Total</span>
                  <span>{fmtBs(order.totalBs ?? 0)} / {fmtUSD(order.totalUsd)}</span>
                </div>
              </div>

              {order.notes?.trim() ? (
                <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                  <span className="text-[#F5F5F7]">Nota del pedido:</span> {order.notes.trim()}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "entrega" ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                <RowProcessTimeline order={order} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailMetric label="Asignacion" value={assignmentText(order)} />
                <DetailMetric label="Tipo" value={pillLabel(order.fulfillment)} />
                <DetailMetric label="Entrega" value={deliveryText} />
                <DetailMetric label="Enviado a cocina" value={fmtDateTime(order.sentToKitchenAtISO)} />
                <DetailMetric label="Tomado por cocina" value={fmtDateTime(order.kitchenStartedAtISO)} />
                <DetailMetric label="Listo" value={fmtDateTime(order.readyAtISO)} />
                <DetailMetric label="Accion actual" value={actionLabel} tone="yellow" />
              </div>
              {order.fulfillment === "delivery" ? (
                <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Datos de entrega</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <DetailMetric label="Direccion" value={order.address || "--"} />
                    <DetailMetric label="GPS" value={order.deliveryGpsUrl ? (
                      <a className="break-all text-sky-300 hover:underline" href={order.deliveryGpsUrl} target="_blank" rel="noreferrer">
                        {order.deliveryGpsUrl}
                      </a>
                    ) : "--"} />
                    <DetailMetric label="Recibe" value={order.receiverName || "--"} />
                    <DetailMetric label="Telefono recibe" value={order.receiverPhone || "--"} />
                    <DetailMetric label="Distancia" value={order.deliveryDistanceKm != null ? `${order.deliveryDistanceKm} km` : "--"} />
                    <DetailMetric label="Costo delivery" value={order.deliveryCostUsd != null ? fmtUSD(order.deliveryCostUsd) : "--"} />
                  </div>
                </div>
              ) : null}
              {order.hasInvoice || order.hasDeliveryNote ? (
                <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Documentos</div>
                  <div className="mt-3 grid gap-3">
                    {order.hasInvoice ? (
                      <DetailMetric
                        label="Factura"
                        value={[
                          order.invoiceSnapshot?.companyName,
                          order.invoiceSnapshot?.taxId,
                          order.invoiceSnapshot?.address,
                          order.invoiceSnapshot?.phone,
                        ].filter(Boolean).join(" | ") || order.invoiceDataNote || "Solicitada sin datos guardados"}
                      />
                    ) : null}
                    {order.hasDeliveryNote ? (
                      <DetailMetric
                        label="Nota de entrega"
                        value={[
                          order.deliveryNoteSnapshot?.name,
                          order.deliveryNoteSnapshot?.documentId,
                          order.deliveryNoteSnapshot?.address,
                          order.deliveryNoteSnapshot?.phone,
                        ].filter(Boolean).join(" | ") || "Solicitada sin datos guardados"}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "pagos" ? (
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailMetric label="Estado de pago" value={paymentLabel} tone={paidTone} />
                <DetailMetric label="Forma de pago" value={getPaymentMethodLabel(order.paymentMethod || "") || "--"} />
                <DetailMetric label="Cambio" value={paymentChangeText(order) || "No"} />
                <DetailMetric label="Nota de pago" value={order.paymentNote || "--"} />
              </div>
              <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Reportes</div>
                  <div className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px] text-[#B7B7C2]">
                    {order.paymentReports.length}
                  </div>
                </div>
                {order.paymentReports.length === 0 ? (
                  <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                    Sin reportes de pago.
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {order.paymentReports.map((report) => (
                      <div key={report.id} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-[#F5F5F7]">
                              {report.currencyCode} {report.amount.toFixed(2)} - {fmtUSD(report.usdEquivalent)}
                            </div>
                            <div className="mt-1 text-[11px] text-[#8A8A96]">
                              {report.moneyAccountName} - {report.createdAt ? fmtDateTime(report.createdAt) : "--"}
                            </div>
                          </div>
                          <span
                            className={[
                              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                              report.status === "pending"
                                ? "bg-orange-500 text-[#0B0B0D]"
                                : report.status === "confirmed"
                                  ? "bg-emerald-500 text-[#0B0B0D]"
                                  : "bg-red-500 text-[#0B0B0D]",
                            ].join(" ")}
                          >
                            {report.status === "pending" ? "PENDIENTE" : report.status === "confirmed" ? "CONFIRMADO" : "RECHAZADO"}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-1 text-[11px] text-[#B7B7C2] sm:grid-cols-2">
                          <div>Reportado por: <span className="text-[#F5F5F7]">{report.reporterName}</span></div>
                          <div>Referencia: <span className="text-[#F5F5F7]">{report.referenceCode || "--"}</span></div>
                          <div>Pagador: <span className="text-[#F5F5F7]">{report.payerName || "--"}</span></div>
                          <div>Tasa: <span className="text-[#F5F5F7]">{report.exchangeRate ?? "--"}</span></div>
                        </div>
                        {report.notes ? <div className="mt-2 text-[11px] text-[#B7B7C2]">Notas: <span className="text-[#F5F5F7]">{report.notes}</span></div> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {activeTab === "eventos" ? (
            <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-[#F5F5F7]">Historial</div>
                <div className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px] text-[#B7B7C2]">
                  {order.events.length} evento{order.events.length === 1 ? "" : "s"}
                </div>
              </div>
              {order.events.length === 0 ? (
                <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                  Sin historial registrado.
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  {order.events.map((event) => (
                    <div key={event.id} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[#F5F5F7]">{event.title}</div>
                          <div className="mt-1 text-[11px] text-[#8A8A96]">
                            {event.actorName} - {fmtDateTime(event.createdAt)}
                          </div>
                        </div>
                        <span className={["rounded-full px-2 py-0.5 text-[10px] font-semibold", event.severity === "critical" || event.severity === "warning" ? "bg-orange-500 text-[#0B0B0D]" : "bg-emerald-500 text-[#0B0B0D]"].join(" ")}>
                          {event.severity === "critical" ? "CRITICA" : event.severity === "warning" ? "ATENCION" : "INFO"}
                        </span>
                      </div>
                      {event.message ? <div className="mt-2 text-[12px] text-[#B7B7C2]">{event.message}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {activeTab === "notas" ? (
            <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
              <div className="text-sm font-semibold text-[#F5F5F7]">Notas</div>
              <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                {order.notes?.trim() || "--"}
              </div>
            </div>
          ) : null}

          {activeTab === "ajustes" ? (
            <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-[#F5F5F7]">Ajustes</div>
                <div className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px] text-[#B7B7C2]">
                  {order.adminAdjustments.length}
                </div>
              </div>
              {order.adminAdjustments.length === 0 ? (
                <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                  Sin ajustes administrativos registrados.
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  {order.adminAdjustments.map((adjustment) => (
                    <div key={adjustment.id} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[#F5F5F7]">{adjustment.adjustmentType || "Ajuste"}</div>
                          <div className="mt-1 text-[11px] text-[#8A8A96]">
                            {adjustment.createdByName} - {fmtDateTime(adjustment.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 text-[12px] text-[#B7B7C2]">
                        Motivo: <span className="text-[#F5F5F7]">{adjustment.reason || "--"}</span>
                      </div>
                      {adjustment.notes ? <div className="mt-1 text-[12px] text-[#B7B7C2]">Notas: <span className="text-[#F5F5F7]">{adjustment.notes}</span></div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
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
}: Props) {
  const router = useRouter();
  const [tray, setTray] = useState<MasterTray>("all");
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = useState<DetailTab>("detalle");
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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
  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  );

  function openOrder(order: MasterOpsOrder, tab: DetailTab = "detalle") {
    setSelectedOrderId(order.id);
    setSelectedDetailTab(tab);
    setActionError(null);
  }

  async function runDirectOrderAction(order: MasterOpsOrder, action: DirectActionKey) {
    const actionId = `${action}:${order.id}`;
    setRunningAction(actionId);
    setActionError(null);

    try {
      let result: unknown = null;

      if (action === "approve") {
        result = await approveOrderAction({ orderId: order.id });
      } else if (action === "send-kitchen") {
        result = await sendToKitchenAction({ orderId: order.id });
      } else if (action === "mark-ready") {
        result = await markReadyAction({ orderId: order.id });
      } else if (action === "complete") {
        result = await markDeliveredAction({ orderId: order.id });
      }

      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const message = "message" in result && typeof result.message === "string" ? result.message : "No se pudo procesar la accion.";
        throw new Error(message);
      }

      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo procesar la accion.");
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
                        onClick={() => openOrder(order, focusTab)}
                      >
                        <td className="px-2 py-2">
                          {fmtTimeAMPM(order.deliveryAtISO)}
                        </td>
                        <td className="min-w-[104px] px-2 py-2">
                          <div className="font-semibold text-[#F5F5F7]">{order.id}</div>
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
          order={selectedOrder}
          focusDate={focusDate}
          activeTab={selectedDetailTab}
          actionError={actionError}
          runningAction={runningAction}
          onTabChange={setSelectedDetailTab}
          onClose={() => setSelectedOrderId(null)}
          onDirectAction={runDirectOrderAction}
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
