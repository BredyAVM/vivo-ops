"use client";

import type { ReactNode } from "react";
import {
  getPaymentMethodLabel,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";
import {
  buildWhatsAppOrderSummaryText,
  cleanWhatsAppUnitsFromName,
  formatWhatsAppDateVE,
  formatWhatsAppQuantity,
  formatWhatsAppTimeAmPm,
  getWhatsAppLineUnits,
} from "@/lib/orders/whatsapp-summary";

export type MasterOrderPaymentVerify = "none" | "pending" | "confirmed" | "rejected";

export type MasterOrderDetailTab = "detalle" | "entrega" | "pagos" | "eventos" | "notas" | "ajustes";

export type MasterOrderDetailLine = {
  name: string;
  qty: number;
  unitsPerService: number;
  priceBs: number;
  lineTotalUsd: number;
  productType?: string | null;
  isDelivery?: boolean;
  editableDetailLines?: string[];
};

export type MasterOrderPaymentReport = {
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

export type MasterOrderEvent = {
  id: string;
  title: string;
  message: string | null;
  severity: "info" | "warning" | "critical";
  actorName: string;
  createdAt: string;
};

export type MasterOrderAdminAdjustment = {
  id: number;
  adjustmentType: string;
  reason: string;
  notes: string | null;
  createdAt: string;
  createdByName: string;
};

export type MasterOrderDetailOrder = {
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
  paymentVerify: MasterOrderPaymentVerify;
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
  lines: MasterOrderDetailLine[];
  paymentReports: MasterOrderPaymentReport[];
  events: MasterOrderEvent[];
  adminAdjustments: MasterOrderAdminAdjustment[];
  riderName: string | null;
  externalPartner: string | null;
};

export const MASTER_ORDER_DETAIL_TABS: Array<{ key: MasterOrderDetailTab; label: string }> = [
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

const detailDateFormatter = new Intl.DateTimeFormat("es-VE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  timeZone: "America/Caracas",
});

export function formatMasterOrderUSD(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export function formatMasterOrderBs(value: number | null | undefined) {
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

export function formatMasterOrderRateBs(value: number) {
  return `Bs ${Number(value || 0).toFixed(2)}`;
}

export function formatMasterOrderTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return timeFormatter.format(date);
}

export function formatMasterOrderDate(iso: string | null) {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return detailDateFormatter.format(date);
}

export function formatMasterOrderDateTime(iso: string | null) {
  if (!iso) return "--";
  return `${formatMasterOrderDate(iso)} - ${formatMasterOrderTime(iso)}`;
}

export function masterOrderPaymentLabel(order: Pick<MasterOrderDetailOrder, "balanceUsd" | "paymentVerify">) {
  if (order.balanceUsd <= 0.005) return "Pagado";
  if (order.paymentVerify === "pending") return "Pago por revisar";
  if (order.paymentVerify === "rejected") return "Pago rechazado";
  if (order.paymentVerify === "confirmed") return "Pago parcial";
  return "Pendiente";
}

export function masterOrderPaymentTone(order: Pick<MasterOrderDetailOrder, "balanceUsd">) {
  return order.balanceUsd <= 0.005 ? "green" : "orange";
}

export function masterOrderAssignmentText(order: Pick<MasterOrderDetailOrder, "fulfillment" | "riderName" | "externalPartner">) {
  if (order.fulfillment !== "delivery") return "Retiro en local";
  if (order.riderName) return `Interno: ${order.riderName}`;
  if (order.externalPartner) return `Externo: ${order.externalPartner}`;
  return "Sin driver";
}

export function masterOrderPaymentChangeText(
  order: Pick<MasterOrderDetailOrder, "paymentRequiresChange" | "paymentChangeFor" | "paymentChangeCurrency">
) {
  if (!order.paymentRequiresChange) return null;
  if (!order.paymentChangeFor) return "Si";
  return `${order.paymentChangeFor} ${order.paymentChangeCurrency || ""}`.trim();
}

export function masterOrderMainLines(lines: MasterOrderDetailLine[]) {
  const services: MasterOrderDetailLine[] = [];
  const extras: MasterOrderDetailLine[] = [];
  const delivery: MasterOrderDetailLine[] = [];

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

export function masterOrderLineText(line: MasterOrderDetailLine) {
  const units = getWhatsAppLineUnits({
    qty: line.qty,
    name: line.name,
    unitsPerService: line.unitsPerService,
  });
  const isDelivery = Boolean(line.isDelivery) || line.name.toLowerCase().startsWith("delivery");
  const bs = formatMasterOrderBs(line.qty * line.priceBs);

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

export function buildMasterOrderWhatsAppSummary(order: MasterOrderDetailOrder) {
  const deliveryDateText = formatWhatsAppDateVE(order.deliveryAtISO);
  const deliveryTimeText = order.isAsap ? "Lo antes posible" : formatWhatsAppTimeAmPm(order.deliveryAtISO);
  const subtotalBs = order.subtotalBs ?? order.totalBs ?? 0;
  const subtotalUsd = order.subtotalUsd ?? order.totalUsd;

  return buildWhatsAppOrderSummaryText({
    title: "Resumen de Pedido",
    orderLabel: order.orderNumber || String(order.id),
    advisorName: order.advisorName,
    clientName: order.clientName,
    clientPhone: order.clientPhone,
    receiverName: order.receiverName,
    receiverPhone: order.receiverPhone,
    lines: masterOrderMainLines(order.lines).map((line) => ({
      text: masterOrderLineText(line),
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
    paymentChangeText: masterOrderPaymentChangeText(order),
    paymentNote: order.paymentNote,
    paymentStatus: masterOrderPaymentLabel(order),
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

function processCurrentKey(order: MasterOrderDetailOrder) {
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

function processSteps(order: MasterOrderDetailOrder) {
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

function hasDeliveryAssignment(order: Pick<MasterOrderDetailOrder, "riderName" | "externalPartner">) {
  return Boolean(order.riderName?.trim() || order.externalPartner?.trim());
}

export function MasterOrderProcessTimeline({ order }: { order: MasterOrderDetailOrder }) {
  const steps = processSteps(order);
  const currentKey = processCurrentKey(order);
  const orderedKeys = steps.map((step) => step.key);
  const cancelled = order.status === "cancelled";
  const needsDriverUrgent =
    order.fulfillment === "delivery" &&
    !hasDeliveryAssignment(order) &&
    ["confirmed", "in_kitchen", "ready", "out_for_delivery"].includes(order.status);
  const assignmentLabel = masterOrderAssignmentText(order);

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

export function MasterOrderDetailMetric({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: ReactNode;
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

export function MasterOrderDetailBody({
  order,
  activeTab,
  actionLabel,
}: {
  order: MasterOrderDetailOrder;
  activeTab: MasterOrderDetailTab;
  actionLabel: string;
}) {
  const paymentLabel = masterOrderPaymentLabel(order);
  const paidTone = masterOrderPaymentTone(order);
  const deliveryText = order.isAsap
    ? `${formatMasterOrderDate(order.deliveryAtISO)} - Lo antes posible`
    : formatMasterOrderDateTime(order.deliveryAtISO);

  if (activeTab === "detalle") {
    const lines = masterOrderMainLines(order.lines);
    return (
      <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
        <div className="text-sm font-semibold text-[#F5F5F7]">Pedido</div>

        <div className="mt-3 space-y-2 text-sm">
          {lines.length === 0 ? (
            <div className="text-[#B7B7C2]">
              Sin items cargados.
            </div>
          ) : (
            lines.map((line, index) => (
              <div key={`${line.name}-${index}`} className="leading-5">
                <div className="text-[#F5F5F7]">{masterOrderLineText(line)}</div>
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
            <span>{order.fxRate != null && order.fxRate > 0 ? formatMasterOrderRateBs(order.fxRate) : "--"}</span>
          </div>
          <div className="flex items-center justify-between text-[#B7B7C2]">
            <span>Subtotal</span>
            <span>{formatMasterOrderBs(order.subtotalBs ?? order.totalBs ?? 0)} / {formatMasterOrderUSD(order.subtotalUsd ?? order.totalUsd)}</span>
          </div>
          {order.discountAmountUsd > 0.005 || order.discountAmountBs > 0.5 ? (
            <div className="flex items-center justify-between text-orange-300">
              <span>Descuento{order.discountPct != null ? ` (${order.discountPct}%)` : ""}</span>
              <span>-{formatMasterOrderBs(order.discountAmountBs)} / -{formatMasterOrderUSD(order.discountAmountUsd)}</span>
            </div>
          ) : null}
          {order.invoiceTaxAmountUsd > 0.005 || order.invoiceTaxAmountBs > 0.5 ? (
            <div className="flex items-center justify-between text-sky-300">
              <span>IVA{order.invoiceTaxPct != null ? ` (${order.invoiceTaxPct}%)` : ""}</span>
              <span>+{formatMasterOrderBs(order.invoiceTaxAmountBs)} / +{formatMasterOrderUSD(order.invoiceTaxAmountUsd)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between text-sm font-semibold text-[#F5F5F7]">
            <span>Total</span>
            <span>{formatMasterOrderBs(order.totalBs ?? 0)} / {formatMasterOrderUSD(order.totalUsd)}</span>
          </div>
        </div>

        {order.notes?.trim() ? (
          <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
            <span className="text-[#F5F5F7]">Nota del pedido:</span> {order.notes.trim()}
          </div>
        ) : null}
      </div>
    );
  }

  if (activeTab === "entrega") {
    return (
      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
          <MasterOrderProcessTimeline order={order} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <MasterOrderDetailMetric label="Asignacion" value={masterOrderAssignmentText(order)} />
          <MasterOrderDetailMetric label="Tipo" value={order.fulfillment === "delivery" ? "Delivery" : "Pickup"} />
          <MasterOrderDetailMetric label="Entrega" value={deliveryText} />
          <MasterOrderDetailMetric label="Enviado a cocina" value={formatMasterOrderDateTime(order.sentToKitchenAtISO)} />
          <MasterOrderDetailMetric label="Tomado por cocina" value={formatMasterOrderDateTime(order.kitchenStartedAtISO)} />
          <MasterOrderDetailMetric label="Listo" value={formatMasterOrderDateTime(order.readyAtISO)} />
          <MasterOrderDetailMetric label="Accion actual" value={actionLabel} tone="yellow" />
        </div>
        {order.fulfillment === "delivery" ? (
          <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
            <div className="text-sm font-semibold text-[#F5F5F7]">Datos de entrega</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <MasterOrderDetailMetric label="Direccion" value={order.address || "--"} />
              <MasterOrderDetailMetric
                label="GPS"
                value={
                  order.deliveryGpsUrl ? (
                    <a className="break-all text-sky-300 hover:underline" href={order.deliveryGpsUrl} target="_blank" rel="noreferrer">
                      {order.deliveryGpsUrl}
                    </a>
                  ) : (
                    "--"
                  )
                }
              />
              <MasterOrderDetailMetric label="Recibe" value={order.receiverName || "--"} />
              <MasterOrderDetailMetric label="Telefono recibe" value={order.receiverPhone || "--"} />
              <MasterOrderDetailMetric label="Distancia" value={order.deliveryDistanceKm != null ? `${order.deliveryDistanceKm} km` : "--"} />
              <MasterOrderDetailMetric label="Costo delivery" value={order.deliveryCostUsd != null ? formatMasterOrderUSD(order.deliveryCostUsd) : "--"} />
            </div>
          </div>
        ) : null}
        {order.hasInvoice || order.hasDeliveryNote ? (
          <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
            <div className="text-sm font-semibold text-[#F5F5F7]">Documentos</div>
            <div className="mt-3 grid gap-3">
              {order.hasInvoice ? (
                <MasterOrderDetailMetric
                  label="Factura"
                  value={
                    [
                      order.invoiceSnapshot?.companyName,
                      order.invoiceSnapshot?.taxId,
                      order.invoiceSnapshot?.address,
                      order.invoiceSnapshot?.phone,
                    ].filter(Boolean).join(" | ") ||
                    order.invoiceDataNote ||
                    "Solicitada sin datos guardados"
                  }
                />
              ) : null}
              {order.hasDeliveryNote ? (
                <MasterOrderDetailMetric
                  label="Nota de entrega"
                  value={
                    [
                      order.deliveryNoteSnapshot?.name,
                      order.deliveryNoteSnapshot?.documentId,
                      order.deliveryNoteSnapshot?.address,
                      order.deliveryNoteSnapshot?.phone,
                    ].filter(Boolean).join(" | ") || "Solicitada sin datos guardados"
                  }
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (activeTab === "pagos") {
    return (
      <div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <MasterOrderDetailMetric label="Estado de pago" value={paymentLabel} tone={paidTone} />
          <MasterOrderDetailMetric label="Forma de pago" value={getPaymentMethodLabel(order.paymentMethod || "") || "--"} />
          <MasterOrderDetailMetric label="Cambio" value={masterOrderPaymentChangeText(order) || "No"} />
          <MasterOrderDetailMetric label="Nota de pago" value={order.paymentNote || "--"} />
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
                        {report.currencyCode} {report.amount.toFixed(2)} - {formatMasterOrderUSD(report.usdEquivalent)}
                      </div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        {report.moneyAccountName} - {report.createdAt ? formatMasterOrderDateTime(report.createdAt) : "--"}
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
    );
  }

  if (activeTab === "eventos") {
    return (
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
                      {event.actorName} - {formatMasterOrderDateTime(event.createdAt)}
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
    );
  }

  if (activeTab === "notas") {
    return (
      <div className="mt-4 rounded-xl border border-[#242433] bg-[#121218] p-3">
        <div className="text-sm font-semibold text-[#F5F5F7]">Notas</div>
        <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
          {order.notes?.trim() || "--"}
        </div>
      </div>
    );
  }

  return (
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
                    {adjustment.createdByName} - {formatMasterOrderDateTime(adjustment.createdAt)}
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
  );
}
