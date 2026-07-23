"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import {
  canCompleteOrder,
  canKitchenTakeOrder,
  canMarkOrderReady,
  canReturnOrderFromKitchenToQueue,
  canSendOrderToKitchen,
  isOrderPriceProtected,
  isRecognizedBillingOrder,
  isScheduledClosingOrder,
} from "@/lib/domain/order-domain";
import {
  ORDER_STATUS_LABELS,
  formatOrderDisplayNumber,
  getPaymentMethodLabel,
  type OrderStatus,
} from "@/lib/orders/order-labels";
import {
  getPaymentReportRequirements,
  validatePaymentReportDetails,
} from "@/lib/payments/payment-report-rules";
import {
  approveOrderAction,
  applyClientFundPaymentAction,
  assignExternalPartnerAction,
  assignInternalDriverAction,
  clearDeliveryAssignmentAction,
  correctDeliveredDeliveryAssignmentAction,
  createPaymentReportAction,
  kitchenTakeAction,
  markDeliveredAction,
  markReadyAction,
  outForDeliveryAction,
  protectOrderPriceAction,
  reapproveQueuedOrderAction,
  rejectPaymentReportAction,
  returnFromKitchenToQueueAction,
  returnToCreatedAction,
  sendToKitchenAction,
} from "../dashboard/actions";
import {
  MASTER_ORDER_DETAIL_TABS,
  MasterOrderDetailBody,
  buildMasterOrderWhatsAppSummary,
  formatMasterOrderBs,
  formatMasterOrderDateTime,
  formatMasterOrderRateBs,
  formatMasterOrderTime,
  formatMasterOrderUSD,
  masterOrderPaymentLabel,
  masterOrderPaymentTone,
  type MasterOrderDetailOrder,
  type MasterOrderDetailTab,
  type MasterOrderPaymentReport,
  type MasterOrderPaymentVerify,
} from "../_components/MasterOrderDetailCore";
import {
  addMasterOpsOrderNoteAction,
  cancelMasterOpsOrderAction,
  closeMasterOpsRoundingBalanceAction,
  confirmMasterOpsPaymentReportAction,
  loadMasterOpsOrderDetailAction,
  loadMasterOpsPaymentSuggestionAction,
  settleMasterOpsClientFundPayoutAction,
  searchMasterOpsOrdersAction,
  type MasterOpsOrderDetailPayload,
  type MasterOpsPaymentSuggestion,
  type MasterOpsOrderSearchResult,
  updateMasterOpsExchangeRateAction,
} from "./actions";
import type { MasterOpsInboxItem, MasterOpsInboxKind } from "./inbox-actions";
import MasterOpsAlerts from "./MasterOpsAlerts";
import MasterOpsOrderEditor from "./MasterOpsOrderEditor";
import {
  canAssignMasterOpsDelivery,
  canClearMasterOpsDeliveryAssignment,
  canReturnMasterOpsOrderToAdvisor,
  canStartMasterOpsDelivery,
  hasMasterOpsDeliveryAssignment,
} from "./operational-rules";

const MasterOpsInboxDrawer = dynamic(() => import("./MasterOpsInboxDrawer"), { ssr: false });

export type PaymentVerify = MasterOrderPaymentVerify;
export type MasterOpsOrder = MasterOrderDetailOrder & {
  clientFundUsedUsd: number;
  pendingBs: number | null;
  paymentCollectionMode: string | null;
  paymentStateOperationDate: string | null;
};
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
export type MasterOpsPaymentAccountOption = {
  key: string;
  accountId: number;
  accountName: string;
  currencyCode: "USD" | "VES";
  paymentMethodCode: string;
};
type MasterOpsMergedSearchResult = {
  id: number;
  matchPriority: number;
  label: string;
  sub: string;
  operationalDate: string;
  source: "local" | "remote";
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
  publicVapidKey: string;
  focusDate: string;
  snapshotAt: string;
  activeRate: number | null;
  orders: MasterOpsOrder[];
  openedOrder: MasterOpsOrder | null;
  stats: MasterOpsStats;
  drivers: DriverOption[];
  deliveryPartners: DeliveryPartnerOption[];
  paymentAccounts: MasterOpsPaymentAccountOption[];
};

type MasterTray = "all" | "pending_created" | "reapproval" | "queued" | "kitchen" | "delivery" | "finalized";
type DetailTab = MasterOrderDetailTab;
type DirectActionKey =
  | "approve"
  | "reapprove"
  | "send-kitchen"
  | "kitchen-take"
  | "mark-ready"
  | "out-delivery"
  | "complete"
  | "assign-internal"
  | "assign-external"
  | "correct-delivered-internal"
  | "correct-delivered-external"
  | "return-created"
  | "return-queue"
  | "clear-delivery"
  | "confirm-payment"
  | "reject-payment"
  | "protect-price"
  | "apply-fund"
  | "deliver-fund-change"
  | "close-rounding"
  | "add-note"
  | "cancel-order";
type MoneyLinePayload = {
  moneyAccountId: number;
  currencyCode: string;
  amount: number;
  exchangeRate?: number | null;
  notes?: string | null;
};
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
  correctionNotes?: string | null;
  reportId?: number;
  moneyAccountId?: number | null;
  currencyCode?: string | null;
  amount?: number | null;
  movementDate?: string | null;
  exchangeRate?: number | null;
  payerName?: string | null;
  description?: string | null;
  isRetention?: boolean;
  fundAmountUsd?: number | null;
  paidHandling?: "store_fund" | "refund" | null;
  overpaymentHandling?: "change_given" | "store_fund" | "close_difference" | null;
  overpaymentNotes?: string | null;
  moneyLines?: MoneyLinePayload[];
  changeLines?: MoneyLinePayload[];
};
type PaymentReportDraft = {
  accountKey: string;
  amount: string;
  exchangeRate: string;
  operationDate: string;
  referenceCode: string;
  bankName: string;
  payerName: string;
  notes: string;
  isRetention: boolean;
};
type MoneyLineDraft = {
  localId: string;
  accountKey: string;
  amount: string;
  exchangeRate: string;
  notes: string;
};
type PaymentConfirmationDraft = {
  reportId: number;
  accountKey: string;
  amount: string;
  exchangeRate: string;
  movementDate: string;
  reviewNotes: string;
  overpaymentHandling: "" | "change_given" | "store_fund" | "close_difference";
  overpaymentNotes: string;
  changeLines: MoneyLineDraft[];
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

function fmtUSD(value: number) {
  return formatMasterOrderUSD(value);
}

function fmtRateBs(value: number) {
  return formatMasterOrderRateBs(value);
}

function fmtTimeAMPM(iso: string) {
  return formatMasterOrderTime(iso);
}

function fmtDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-");
  return year && month && day ? `${day}/${month}/${year}` : dateKey;
}

function caracasDateKeyFromISO(iso: string | null | undefined) {
  if (!iso) return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  return date.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function getCaracasTodayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
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

function orderDisplayNumber(order: Pick<MasterOpsOrder, "id">) {
  return formatOrderDisplayNumber(order.id);
}

function parseDecimal(value: string) {
  const normalized = String(value || "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compactDecimal(value: number, decimals = 2) {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(decimals)));
}

function isRetentionPaymentAccount(option: MasterOpsPaymentAccountOption) {
  return option.paymentMethodCode === "retention";
}

function getSuggestedPaymentAmount(
  order: MasterOpsOrder,
  option: MasterOpsPaymentAccountOption | null,
  suggestion: MasterOpsPaymentSuggestion
) {
  if (!option || order.balanceUsd <= 0.005) return "";
  if (option.currencyCode === "VES") {
    return suggestion.pendingBs != null && suggestion.pendingBs > 0
      ? compactDecimal(suggestion.pendingBs, 2)
      : "";
  }
  return compactDecimal(suggestion.pendingUsd, 2);
}

function getSuggestedPaymentExchangeRate(
  order: MasterOpsOrder,
  activeRate: number | null,
  suggestion?: MasterOpsPaymentSuggestion | null
) {
  const rate =
    suggestion?.exchangeRate ??
    (order.fxRate && order.fxRate > 0 ? order.fxRate : activeRate);
  return rate && rate > 0 ? compactDecimal(rate, 4) : "";
}

function getLoadedMasterOpsPaymentSuggestion(
  order: MasterOpsOrder,
  activeRate: number | null,
  operationDate: string
): MasterOpsPaymentSuggestion {
  const matchesLoadedOperationDate =
    !order.paymentStateOperationDate || order.paymentStateOperationDate === operationDate;
  const pendingBs = matchesLoadedOperationDate ? order.pendingBs : null;
  const fallbackRate = order.fxRate && order.fxRate > 0 ? order.fxRate : activeRate;
  const resolvedPendingBs =
    pendingBs != null
      ? pendingBs
      : order.confirmedPaidUsd <= 0.005 && order.totalBs != null
        ? order.totalBs
        : fallbackRate && fallbackRate > 0
          ? Number((order.balanceUsd * fallbackRate).toFixed(2))
          : null;
  const exchangeRate =
    resolvedPendingBs != null && resolvedPendingBs > 0.005 && order.balanceUsd > 0.005
      ? Number((resolvedPendingBs / order.balanceUsd).toFixed(4))
      : fallbackRate && fallbackRate > 0
        ? Number(fallbackRate.toFixed(4))
        : null;

  return {
    pendingUsd: order.balanceUsd,
    pendingBs: resolvedPendingBs,
    exchangeRate,
    activeRate,
    collectionMode: matchesLoadedOperationDate ? order.paymentCollectionMode : null,
    operationDate,
  };
}

const ORDER_ROUNDING_SHORTFALL_CLOSE_MAX_USD = 0.09;
const ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD = 1;

function getPaymentAccountLabel(option: MasterOpsPaymentAccountOption) {
  const methodLabel = getPaymentMethodLabel(option.paymentMethodCode);
  return `${option.accountName} - ${methodLabel || option.paymentMethodCode}`;
}

function getSuggestedNativeAmountFromUsd(
  amountUsd: number,
  account: MasterOpsPaymentAccountOption | null,
  activeRate: number | null,
  order?: MasterOpsOrder
) {
  if (!account || !Number.isFinite(amountUsd) || amountUsd <= 0) return "";
  if (account.currencyCode === "VES") {
    const rate = order?.fxRate && order.fxRate > 0 ? order.fxRate : activeRate;
    return rate && rate > 0 ? compactDecimal(amountUsd * rate, 2) : "";
  }
  return compactDecimal(amountUsd, 2);
}

function getMoneyLineUsd(
  line: MoneyLineDraft,
  account: MasterOpsPaymentAccountOption | null
) {
  const amount = parseDecimal(line.amount);
  if (!account || !Number.isFinite(amount) || amount <= 0) return 0;
  if (account.currencyCode === "VES") {
    const exchangeRate = parseDecimal(line.exchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
    return Number((amount / exchangeRate).toFixed(2));
  }
  return Number(amount.toFixed(2));
}

function getPaymentConfirmationUsd(
  draft: Pick<PaymentConfirmationDraft, "amount" | "exchangeRate">,
  account: MasterOpsPaymentAccountOption | null
) {
  const amount = parseDecimal(draft.amount);
  if (!account || !Number.isFinite(amount) || amount <= 0) return 0;
  if (account.currencyCode === "VES") {
    const exchangeRate = parseDecimal(draft.exchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
    return Number((amount / exchangeRate).toFixed(2));
  }
  return Number(amount.toFixed(2));
}

function newMoneyLineDraft(
  account: MasterOpsPaymentAccountOption | null,
  amountUsd: number,
  activeRate: number | null,
  order?: MasterOpsOrder
): MoneyLineDraft {
  const exchangeRate = order?.fxRate && order.fxRate > 0 ? order.fxRate : activeRate;
  return {
    localId: crypto.randomUUID(),
    accountKey: account?.key ?? "",
    amount: getSuggestedNativeAmountFromUsd(amountUsd, account, activeRate, order),
    exchangeRate:
      account?.currencyCode === "VES" && exchangeRate && exchangeRate > 0
        ? compactDecimal(exchangeRate, 4)
        : "",
    notes: "",
  };
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

function getNextPrimaryActionLabel(order: MasterOpsOrder) {
  if (order.paymentVerify === "pending") return "Confirmar pago";
  if (order.status === "queued" && order.queuedNeedsReapproval) return "Re-aprobar orden";
  if (canSendOrderToKitchen(order)) return "Enviar a cocina";
  if (canAssignMasterOpsDelivery(order)) return "Asignar delivery";
  if (canKitchenTakeOrder(order)) return "Tomar en cocina";
  if (canMarkOrderReady(order)) return "Marcar preparada";
  if (canStartMasterOpsDelivery(order)) return "En camino";
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
  if (order.fulfillment === "delivery" && (!hasMasterOpsDeliveryAssignment(order) || order.status === "ready" || order.status === "out_for_delivery")) {
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

function advancedOperationalLinks(order: MasterOpsOrder): Array<{
  label: string;
  tone: "neutral" | "danger";
}> {
  const links: Array<{ label: string; tone: "neutral" | "danger" }> = [];

  if (["created", "queued"].includes(order.status)) {
    links.push({ label: "Modificar orden", tone: "neutral" });
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
  count,
  onClick,
}: {
  label: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
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

  return <button className={className} onClick={onClick} type="button">{content}</button>;
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
  const needsDriverUrgent = canAssignMasterOpsDelivery(order);
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
  activeRate,
  roles,
  activeTab,
  detailLoading,
  detailError,
  actionError,
  runningAction,
  onTabChange,
  onRetryDetail,
  onClose,
  onEditOrder,
  onDirectAction,
  onCreatePaymentReport,
  drivers,
  deliveryPartners,
  paymentAccounts,
}: {
  order: MasterOpsOrder;
  activeRate: number | null;
  roles: string[];
  activeTab: DetailTab;
  detailLoading: boolean;
  detailError: string | null;
  actionError: string | null;
  runningAction: string | null;
  onTabChange: (tab: DetailTab) => void;
  onRetryDetail: () => void;
  onClose: () => void;
  onEditOrder: (order: MasterOpsOrder) => void;
  onDirectAction: (order: MasterOpsOrder, action: DirectActionKey, payload?: DirectActionPayload) => Promise<boolean>;
  onCreatePaymentReport: (order: MasterOpsOrder, payload: PaymentReportDraft) => Promise<boolean>;
  drivers: DriverOption[];
  deliveryPartners: DeliveryPartnerOption[];
  paymentAccounts: MasterOpsPaymentAccountOption[];
}) {
  const isAdmin = roles.includes("admin");
  const actionLabel = getNextPrimaryActionLabel(order);
  const paidTone = masterOrderPaymentTone(order);
  const paymentLabel = masterOrderPaymentLabel(order);
  const paymentToneClass = paidTone === "green" ? "text-emerald-400" : "text-orange-400";
  const directActions = directActionsForOrder(order);
  const advancedLinks = advancedOperationalLinks(order);
  const [returnBoxOpen, setReturnBoxOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnRecalculate, setReturnRecalculate] = useState(false);
  const [deliveryEtaBoxOpen, setDeliveryEtaBoxOpen] = useState(false);
  const [deliveryEtaMinutes, setDeliveryEtaMinutes] = useState("25");
  const [kitchenTakeBoxOpen, setKitchenTakeBoxOpen] = useState(false);
  const [kitchenEtaMinutes, setKitchenEtaMinutes] = useState("15");
  const [deliveryAssignMode, setDeliveryAssignMode] = useState<null | "internal" | "external">(null);
  const [deliveryAssignDriverId, setDeliveryAssignDriverId] = useState("");
  const [deliveryAssignPartnerId, setDeliveryAssignPartnerId] = useState("");
  const [deliveryAssignDistanceKm, setDeliveryAssignDistanceKm] = useState("");
  const [deliveryAssignCostUsd, setDeliveryAssignCostUsd] = useState("");
  const [deliveryAssignReference, setDeliveryAssignReference] = useState("");
  const [deliveryCorrectionNotes, setDeliveryCorrectionNotes] = useState("");
  const [clearDeliveryBoxOpen, setClearDeliveryBoxOpen] = useState(false);
  const [clearDeliveryNotes, setClearDeliveryNotes] = useState("");
  const [paymentRejectReportId, setPaymentRejectReportId] = useState<number | null>(null);
  const [paymentRejectNotes, setPaymentRejectNotes] = useState("");
  const [paymentConfirmationDraft, setPaymentConfirmationDraft] = useState<PaymentConfirmationDraft | null>(null);
  const [paymentReportOpen, setPaymentReportOpen] = useState(false);
  const [paymentReportIsRetention, setPaymentReportIsRetention] = useState(false);
  const [paymentReportAccountKey, setPaymentReportAccountKey] = useState("");
  const [paymentReportAmount, setPaymentReportAmount] = useState("");
  const [paymentReportExchangeRate, setPaymentReportExchangeRate] = useState("");
  const [paymentReportOperationDate, setPaymentReportOperationDate] = useState(getCaracasTodayKey());
  const [paymentReportReferenceCode, setPaymentReportReferenceCode] = useState("");
  const [paymentReportBankName, setPaymentReportBankName] = useState("");
  const [paymentReportPayerName, setPaymentReportPayerName] = useState("");
  const [paymentReportNotes, setPaymentReportNotes] = useState("");
  const [paymentSuggestion, setPaymentSuggestion] = useState<MasterOpsPaymentSuggestion | null>(null);
  const [paymentSuggestionLoading, setPaymentSuggestionLoading] = useState(false);
  const [paymentSuggestionError, setPaymentSuggestionError] = useState<string | null>(null);
  const paymentSuggestionRequestRef = useRef(0);
  const [fundApplyBoxOpen, setFundApplyBoxOpen] = useState(false);
  const [fundApplyAmountUsd, setFundApplyAmountUsd] = useState("");
  const [fundApplyNotes, setFundApplyNotes] = useState("");
  const [fundPayoutBoxOpen, setFundPayoutBoxOpen] = useState(false);
  const [fundPayoutLines, setFundPayoutLines] = useState<MoneyLineDraft[]>([]);
  const [fundPayoutNotes, setFundPayoutNotes] = useState("");
  const [returnQueueBoxOpen, setReturnQueueBoxOpen] = useState(false);
  const [returnQueueReason, setReturnQueueReason] = useState("");
  const [roundingBoxOpen, setRoundingBoxOpen] = useState(false);
  const [roundingNotes, setRoundingNotes] = useState("Ajuste por redondeo");
  const [cancelBoxOpen, setCancelBoxOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelPaidHandling, setCancelPaidHandling] = useState<"store_fund" | "refund">("store_fund");
  const [cancelRefundLines, setCancelRefundLines] = useState<MoneyLineDraft[]>([]);
  const [operationalNote, setOperationalNote] = useState("");
  const [whatsAppCopyStatus, setWhatsAppCopyStatus] = useState<"copied" | "error" | null>(null);
  const canReturn = canReturnMasterOpsOrderToAdvisor(order);
  const canKitchenTake = canKitchenTakeOrder(order);
  const canCorrectDeliveredDelivery =
    isAdmin && order.fulfillment === "delivery" && order.status === "delivered";
  const canAssign = canAssignMasterOpsDelivery(order) || canCorrectDeliveredDelivery;
  const canOutForDelivery = canStartMasterOpsDelivery(order);
  const canClearDelivery = canClearMasterOpsDeliveryAssignment(order);
  const busy = Boolean(runningAction);
  const activeDeliveryPartners = deliveryPartners.filter((partner) => partner.isActive);
  const pendingPaymentReports = order.paymentReports.filter((report) => report.status === "pending");
  const paymentReportOptions = paymentAccounts.filter((option) =>
    paymentReportIsRetention ? isRetentionPaymentAccount(option) : !isRetentionPaymentAccount(option)
  );
  const normalPaymentOptions = paymentAccounts.filter((option) => !isRetentionPaymentAccount(option));
  const retentionPaymentOptions = paymentAccounts.filter(isRetentionPaymentAccount);
  const moneyAccountByKey = useMemo(
    () => new Map(paymentAccounts.map((option) => [option.key, option] as const)),
    [paymentAccounts]
  );
  const moneyPayoutOptions = normalPaymentOptions;
  const defaultPayoutAccount =
    moneyPayoutOptions.find((option) => option.currencyCode === "USD") ?? moneyPayoutOptions[0] ?? null;
  const clientFundAvailableUsd = Math.max(0, Number(order.clientFundBalanceUsd || 0));
  const suggestedFundApplyUsd = Math.min(order.balanceUsd, clientFundAvailableUsd);
  const priceProtected = isOrderPriceProtected(order);
  const canProtectPrice =
    isAdmin && !priceProtected && !["delivered", "cancelled"].includes(order.status);
  const canReturnQueue = canReturnOrderFromKitchenToQueue(order);
  const canApplyClientFund =
    activeTab === "pagos" &&
    order.clientId != null &&
    order.balanceUsd > 0.005 &&
    clientFundAvailableUsd > 0.005;
  const canPayoutClientFund =
    activeTab === "pagos" &&
    order.clientId != null &&
    clientFundAvailableUsd > 0.005 &&
    moneyPayoutOptions.length > 0;
  const canCloseRounding =
    isAdmin &&
    activeTab === "pagos" &&
    order.balanceUsd > 0.005 &&
    order.balanceUsd <= ORDER_ROUNDING_SHORTFALL_CLOSE_MAX_USD;
  const canCancelOrder = order.status !== "cancelled";
  const fundPayoutTotalUsd = useMemo(
    () =>
      Number(
        fundPayoutLines
          .reduce((sum, line) => sum + getMoneyLineUsd(line, moneyAccountByKey.get(line.accountKey) ?? null), 0)
          .toFixed(2)
      ),
    [fundPayoutLines, moneyAccountByKey]
  );
  const fundPayoutExceedsAvailable = fundPayoutTotalUsd > clientFundAvailableUsd + 0.005;
  const cancelRefundTotalUsd = useMemo(
    () =>
      Number(
        cancelRefundLines
          .reduce((sum, line) => sum + getMoneyLineUsd(line, moneyAccountByKey.get(line.accountKey) ?? null), 0)
          .toFixed(2)
      ),
    [cancelRefundLines, moneyAccountByKey]
  );
  const confirmedMoneyPaidUsd = Math.max(
    0,
    Number((order.confirmedPaidUsd - order.clientFundUsedUsd).toFixed(2))
  );
  const cancelRefundMatchesConfirmedMoney =
    Math.abs(cancelRefundTotalUsd - confirmedMoneyPaidUsd) <= 0.01;
  const selectedPaymentAccount = paymentReportOptions.find((option) => option.key === paymentReportAccountKey) ?? null;
  const loadedPaymentSuggestion = getLoadedMasterOpsPaymentSuggestion(
    order,
    activeRate,
    paymentReportOperationDate
  );
  const effectivePaymentSuggestion =
    paymentSuggestion?.operationDate === paymentReportOperationDate
      ? paymentSuggestion
      : loadedPaymentSuggestion;
  const paymentCollectionMode = effectivePaymentSuggestion.collectionMode;
  const paymentReportRequirements = getPaymentReportRequirements(selectedPaymentAccount?.paymentMethodCode ?? "");
  const canOpenPaymentReport = activeTab === "pagos" && order.balanceUsd > 0.005 && normalPaymentOptions.length > 0;
  const canOpenRetentionReport = activeTab === "pagos" && retentionPaymentOptions.length > 0;
  const operationalNotes = order.events.filter((event) => event.title.trim().toLowerCase() === "nota operativa");

  async function handleCopyWhatsApp() {
    try {
      await navigator.clipboard.writeText(buildMasterOrderWhatsAppSummary(order));
      setWhatsAppCopyStatus("copied");
    } catch {
      setWhatsAppCopyStatus("error");
    }
  }

  async function handleOperationalNoteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = operationalNote.trim();
    if (note.length < 3) return;

    const ok = await onDirectAction(order, "add-note", { notes: note });
    if (ok) setOperationalNote("");
  }

  function buildMoneyPayloads(lines: MoneyLineDraft[], fallbackNotes = "") {
    return lines.map((line) => {
      const account = moneyAccountByKey.get(line.accountKey) ?? null;
      const amount = parseDecimal(line.amount);
      const exchangeRate = account?.currencyCode === "VES" ? parseDecimal(line.exchangeRate) : null;

      return {
        moneyAccountId: account?.accountId ?? 0,
        currencyCode: account?.currencyCode ?? "",
        amount,
        exchangeRate: account?.currencyCode === "VES" ? exchangeRate : null,
        notes: line.notes.trim() || fallbackNotes.trim() || null,
      };
    });
  }

  function recalculateLineForAccount(line: MoneyLineDraft, nextAccountKey: string) {
    const previousAccount = moneyAccountByKey.get(line.accountKey) ?? null;
    const nextAccount = moneyAccountByKey.get(nextAccountKey) ?? null;
    const amountUsd = getMoneyLineUsd(line, previousAccount) || 0;
    return {
      ...line,
      accountKey: nextAccountKey,
      amount: getSuggestedNativeAmountFromUsd(amountUsd, nextAccount, activeRate, order),
      exchangeRate: nextAccount?.currencyCode === "VES" ? getSuggestedPaymentExchangeRate(order, activeRate) : "",
    };
  }

  function ensureFundPayoutLine() {
    if (fundPayoutLines.length > 0) return;
    setFundPayoutLines([
      newMoneyLineDraft(defaultPayoutAccount, clientFundAvailableUsd, activeRate, order),
    ]);
  }

  function ensureCancelRefundLine() {
    if (cancelRefundLines.length > 0) return;
    setCancelRefundLines([
      newMoneyLineDraft(defaultPayoutAccount, confirmedMoneyPaidUsd, activeRate, order),
    ]);
  }

  function updateFundPayoutLine(localId: string, patch: Partial<MoneyLineDraft>) {
    setFundPayoutLines((lines) =>
      lines.map((line) => (line.localId === localId ? { ...line, ...patch } : line))
    );
  }

  function updateCancelRefundLine(localId: string, patch: Partial<MoneyLineDraft>) {
    setCancelRefundLines((lines) =>
      lines.map((line) => (line.localId === localId ? { ...line, ...patch } : line))
    );
  }

  function getConfirmationOptions(report: MasterOrderPaymentReport) {
    return report.isRetention ? retentionPaymentOptions : normalPaymentOptions;
  }

  function getConfirmationExcessUsd(
    draft: PaymentConfirmationDraft,
    account: MasterOpsPaymentAccountOption | null
  ) {
    return Number(Math.max(0, getPaymentConfirmationUsd(draft, account) - order.balanceUsd).toFixed(2));
  }

  function openPaymentConfirmation(report: MasterOrderPaymentReport) {
    if (paymentConfirmationDraft?.reportId === report.id) {
      setPaymentConfirmationDraft(null);
      return;
    }

    const options = getConfirmationOptions(report);
    const account =
      options.find((option) => option.accountId === report.moneyAccountId) ?? options[0] ?? null;
    const exchangeRate =
      account?.currencyCode === "VES"
        ? report.exchangeRate && report.exchangeRate > 0
          ? compactDecimal(report.exchangeRate, 4)
          : getSuggestedPaymentExchangeRate(order, activeRate)
        : "";

    setPaymentRejectReportId(null);
    setPaymentConfirmationDraft({
      reportId: report.id,
      accountKey: account?.key ?? "",
      amount: compactDecimal(report.amount, 2),
      exchangeRate,
      movementDate: paymentReportMovementDate(report),
      reviewNotes: "",
      overpaymentHandling: "",
      overpaymentNotes: "",
      changeLines: [],
    });
  }

  function handlePaymentConfirmationAccountChange(
    report: MasterOrderPaymentReport,
    nextAccountKey: string
  ) {
    setPaymentConfirmationDraft((draft) => {
      if (!draft || draft.reportId !== report.id) return draft;
      const previousAccount = moneyAccountByKey.get(draft.accountKey) ?? null;
      const nextAccount = moneyAccountByKey.get(nextAccountKey) ?? null;
      const amountUsd = getPaymentConfirmationUsd(draft, previousAccount) || report.usdEquivalent;
      const exchangeRate =
        nextAccount?.currencyCode === "VES" ? getSuggestedPaymentExchangeRate(order, activeRate) : "";

      return {
        ...draft,
        accountKey: nextAccountKey,
        amount: getSuggestedNativeAmountFromUsd(amountUsd, nextAccount, activeRate, order),
        exchangeRate,
        overpaymentHandling: "",
        changeLines: [],
      };
    });
  }

  function updatePaymentConfirmationDraft(
    reportId: number,
    patch: Partial<PaymentConfirmationDraft>,
    resetOverpayment = false
  ) {
    setPaymentConfirmationDraft((draft) =>
      draft && draft.reportId === reportId
        ? {
            ...draft,
            ...patch,
            ...(resetOverpayment ? { overpaymentHandling: "" as const, changeLines: [] } : {}),
          }
        : draft
    );
  }

  function updatePaymentChangeLine(localId: string, patch: Partial<MoneyLineDraft>) {
    setPaymentConfirmationDraft((draft) =>
      draft
        ? {
            ...draft,
            changeLines: draft.changeLines.map((line) =>
              line.localId === localId ? { ...line, ...patch } : line
            ),
          }
        : draft
    );
  }

  function handlePaymentOverpaymentChange(
    report: MasterOrderPaymentReport,
    handling: PaymentConfirmationDraft["overpaymentHandling"]
  ) {
    setPaymentConfirmationDraft((draft) => {
      if (!draft || draft.reportId !== report.id) return draft;
      const account = moneyAccountByKey.get(draft.accountKey) ?? null;
      const excessUsd = getConfirmationExcessUsd(draft, account);
      return {
        ...draft,
        overpaymentHandling: handling,
        changeLines:
          handling === "change_given"
            ? [newMoneyLineDraft(defaultPayoutAccount, excessUsd, activeRate, order)]
            : [],
      };
    });
  }

  function openFundApplyBox() {
    setFundApplyBoxOpen((value) => {
      const nextValue = !value;
      if (nextValue && !fundApplyAmountUsd) {
        setFundApplyAmountUsd(compactDecimal(suggestedFundApplyUsd, 2));
      }
      return nextValue;
    });
  }

  async function handleProtectPriceClick() {
    await onDirectAction(order, "protect-price");
  }

  async function handleReturnQueueSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "return-queue", {
      reason: returnQueueReason,
    });
    if (ok) {
      setReturnQueueBoxOpen(false);
      setReturnQueueReason("");
    }
  }

  async function handleFundApplySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "apply-fund", {
      fundAmountUsd: parseDecimal(fundApplyAmountUsd),
      notes: fundApplyNotes,
    });
    if (ok) {
      setFundApplyBoxOpen(false);
      setFundApplyAmountUsd("");
      setFundApplyNotes("");
    }
  }

  async function handleFundPayoutSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "deliver-fund-change", {
      notes: fundPayoutNotes,
      moneyLines: buildMoneyPayloads(fundPayoutLines, fundPayoutNotes),
    });
    if (ok) {
      setFundPayoutBoxOpen(false);
      setFundPayoutLines([]);
      setFundPayoutNotes("");
    }
  }

  async function handleCloseRoundingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "close-rounding", {
      notes: roundingNotes,
    });
    if (ok) setRoundingBoxOpen(false);
  }

  async function handleCancelSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await onDirectAction(order, "cancel-order", {
      reason: cancelReason,
      paidHandling: confirmedMoneyPaidUsd > 0.005 ? cancelPaidHandling : null,
      moneyLines: cancelPaidHandling === "refund" ? buildMoneyPayloads(cancelRefundLines, cancelReason) : [],
    });
    if (ok) {
      setCancelBoxOpen(false);
      setCancelReason("");
      setCancelPaidHandling("store_fund");
      setCancelRefundLines([]);
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

  async function handleKitchenTakeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const etaMinutes = Number(String(kitchenEtaMinutes || "").replace(",", "."));
    const ok = await onDirectAction(order, "kitchen-take", {
      etaMinutes: Number.isFinite(etaMinutes) && etaMinutes > 0 ? etaMinutes : null,
    });
    if (ok) setKitchenTakeBoxOpen(false);
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
    const ok = await onDirectAction(order, canCorrectDeliveredDelivery ? "correct-delivered-internal" : "assign-internal", {
      driverUserId: deliveryAssignDriverId,
      costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
      correctionNotes: deliveryCorrectionNotes,
    });
    if (ok) {
      setDeliveryAssignMode(null);
      setDeliveryCorrectionNotes("");
    }
  }

  async function handleAssignExternalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const distanceKm = Number(String(deliveryAssignDistanceKm || "").replace(",", "."));
    const costUsd = Number(String(deliveryAssignCostUsd || "").replace(",", "."));
    const ok = await onDirectAction(order, canCorrectDeliveredDelivery ? "correct-delivered-external" : "assign-external", {
      partnerId: Number(deliveryAssignPartnerId || 0),
      reference: deliveryAssignReference.trim() || null,
      distanceKm,
      costUsd,
      correctionNotes: deliveryCorrectionNotes,
    });
    if (ok) {
      setDeliveryAssignMode(null);
      setDeliveryCorrectionNotes("");
    }
  }

  async function handleConfirmPaymentSubmit(
    event: FormEvent<HTMLFormElement>,
    report: MasterOrderPaymentReport
  ) {
    event.preventDefault();
    const draft = paymentConfirmationDraft;
    if (!draft || draft.reportId !== report.id) return;
    const account = moneyAccountByKey.get(draft.accountKey) ?? null;
    const predictedExcessUsd = getConfirmationExcessUsd(draft, account);
    const ok = await onDirectAction(order, "confirm-payment", {
      reportId: report.id,
      moneyAccountId: account?.accountId ?? null,
      currencyCode: account?.currencyCode ?? null,
      amount: parseDecimal(draft.amount),
      movementDate: draft.movementDate,
      exchangeRate:
        account?.currencyCode === "VES" ? parseDecimal(draft.exchangeRate) : null,
      reference: report.referenceCode,
      payerName: report.payerName,
      description: `Pago confirmado desde Master Ops - orden ${order.id} - reporte ${report.id}`,
      isRetention: Boolean(report.isRetention),
      notes: draft.reviewNotes,
      overpaymentHandling:
        predictedExcessUsd > 0.005 ? draft.overpaymentHandling || null : null,
      overpaymentNotes: draft.overpaymentNotes.trim() || null,
      changeLines:
        predictedExcessUsd > 0.005 && draft.overpaymentHandling === "change_given"
          ? buildMoneyPayloads(draft.changeLines, draft.overpaymentNotes)
          : [],
    });
    if (ok) {
      setPaymentConfirmationDraft(null);
      setPaymentRejectReportId(null);
    }
  }

  async function refreshPaymentSuggestion(
    operationDate: string,
    account: MasterOpsPaymentAccountOption | null,
    isRetention: boolean
  ) {
    const requestId = paymentSuggestionRequestRef.current + 1;
    paymentSuggestionRequestRef.current = requestId;

    if (isRetention || account?.currencyCode !== "VES") {
      setPaymentSuggestionLoading(false);
      setPaymentSuggestionError(null);
      return;
    }

    if (!operationDate) {
      setPaymentSuggestion(null);
      setPaymentSuggestionLoading(false);
      setPaymentSuggestionError("Selecciona la fecha de operacion para calcular el saldo en bolivares.");
      return;
    }

    setPaymentSuggestionLoading(true);
    setPaymentSuggestionError(null);

    const result = await loadMasterOpsPaymentSuggestionAction({
      orderId: order.id,
      operationDate,
    });

    if (paymentSuggestionRequestRef.current !== requestId) return;
    setPaymentSuggestionLoading(false);

    if (!result.ok) {
      setPaymentSuggestionError(result.message);
      return;
    }

    setPaymentSuggestion(result.suggestion);
    setPaymentReportAmount(getSuggestedPaymentAmount(order, account, result.suggestion));
    setPaymentReportExchangeRate(
      getSuggestedPaymentExchangeRate(
        order,
        result.suggestion.activeRate ?? activeRate,
        result.suggestion
      )
    );
  }

  function closePaymentReport() {
    paymentSuggestionRequestRef.current += 1;
    setPaymentReportOpen(false);
    setPaymentSuggestionLoading(false);
    setPaymentSuggestionError(null);
  }

  function openPaymentReport(isRetention: boolean) {
    const nextOptions = paymentAccounts.filter((option) =>
      isRetention ? isRetentionPaymentAccount(option) : !isRetentionPaymentAccount(option)
    );
    const preferred =
      nextOptions.find((option) => option.currencyCode === order.paymentCurrency) ??
      nextOptions.find((option) => option.currencyCode === "VES") ??
      nextOptions[0] ??
      null;
    const operationDate = getCaracasTodayKey();
    const initialSuggestion = getLoadedMasterOpsPaymentSuggestion(order, activeRate, operationDate);

    setPaymentReportIsRetention(isRetention);
    setPaymentReportOpen(true);
    setPaymentReportAccountKey(preferred?.key ?? "");
    setPaymentSuggestion(initialSuggestion);
    setPaymentSuggestionError(null);
    setPaymentReportAmount(
      isRetention ? "" : getSuggestedPaymentAmount(order, preferred, initialSuggestion)
    );
    setPaymentReportExchangeRate(
      preferred?.currencyCode === "VES"
        ? isRetention
          ? activeRate && activeRate > 0
            ? compactDecimal(activeRate, 4)
            : ""
          : getSuggestedPaymentExchangeRate(order, activeRate, initialSuggestion)
        : ""
    );
    setPaymentReportOperationDate(operationDate);
    setPaymentReportReferenceCode("");
    setPaymentReportBankName("");
    setPaymentReportPayerName("");
    setPaymentReportNotes("");

    void refreshPaymentSuggestion(operationDate, preferred, isRetention);
  }

  function handlePaymentAccountChange(accountKey: string) {
    const nextAccount = paymentReportOptions.find((option) => option.key === accountKey) ?? null;
    setPaymentReportAccountKey(accountKey);
    setPaymentReportAmount(
      paymentReportIsRetention
        ? ""
        : getSuggestedPaymentAmount(order, nextAccount, effectivePaymentSuggestion)
    );
    setPaymentReportExchangeRate(
      nextAccount?.currencyCode === "VES"
        ? paymentReportIsRetention
          ? activeRate && activeRate > 0
            ? compactDecimal(activeRate, 4)
            : ""
          : getSuggestedPaymentExchangeRate(order, activeRate, effectivePaymentSuggestion)
        : ""
    );

    void refreshPaymentSuggestion(
      paymentReportOperationDate,
      nextAccount,
      paymentReportIsRetention
    );
  }

  function handlePaymentOperationDateChange(operationDate: string) {
    setPaymentReportOperationDate(operationDate);
    setPaymentSuggestion(null);
    setPaymentSuggestionError(null);

    if (paymentReportIsRetention) {
      setPaymentReportExchangeRate(
        selectedPaymentAccount?.currencyCode === "VES" && activeRate && activeRate > 0
          ? compactDecimal(activeRate, 4)
          : ""
      );
      return;
    }

    const immediateSuggestion = getLoadedMasterOpsPaymentSuggestion(order, activeRate, operationDate);
    setPaymentReportAmount(
      getSuggestedPaymentAmount(order, selectedPaymentAccount, immediateSuggestion)
    );
    setPaymentReportExchangeRate(
      selectedPaymentAccount?.currencyCode === "VES"
        ? getSuggestedPaymentExchangeRate(order, activeRate, immediateSuggestion)
        : ""
    );

    void refreshPaymentSuggestion(operationDate, selectedPaymentAccount, false);
  }

  async function handlePaymentReportSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedPaymentAccount) {
      await onCreatePaymentReport(order, {
        accountKey: "",
        amount: "",
        exchangeRate: "",
        operationDate: "",
        referenceCode: "",
        bankName: "",
        payerName: "",
        notes: "",
        isRetention: paymentReportIsRetention,
      });
      return;
    }

    const ok = await onCreatePaymentReport(order, {
      accountKey: selectedPaymentAccount.key,
      amount: paymentReportAmount,
      exchangeRate: paymentReportExchangeRate,
      operationDate: paymentReportOperationDate,
      referenceCode: paymentReportReferenceCode,
      bankName: paymentReportBankName,
      payerName: paymentReportPayerName,
      notes: paymentReportNotes,
      isRetention: paymentReportIsRetention,
    });

    if (ok) {
      closePaymentReport();
      setPaymentReportAmount("");
      setPaymentSuggestion(null);
      setPaymentReportReferenceCode("");
      setPaymentReportBankName("");
      setPaymentReportPayerName("");
      setPaymentReportNotes("");
    }
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
      <section className="absolute right-0 top-0 flex h-full w-full max-w-[1180px] flex-col border-l border-[#242433] bg-[#0B0B0D] shadow-2xl">
        <div className="border-b border-[#242433] p-3 sm:p-4">
          <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-[#F5F5F7]">
                    Orden #{orderDisplayNumber(order)} - {order.clientName}
                  </h2>
                  <span className="text-sm font-semibold text-[#F5F5F7]">{formatMasterOrderUSD(order.totalUsd)}</span>
                  <span className={`text-sm font-semibold ${paymentToneClass}`}>{paymentLabel}</span>
                  <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-1 text-[11px] font-semibold text-[#B7B7C2]">
                    {ORDER_STATUS_LABELS[order.status]}
                  </span>
                  <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-1 text-[11px] font-semibold text-[#B7B7C2]">
                    {order.fulfillment === "delivery" ? "Delivery" : "Pickup"}
                  </span>
                  {order.isNewClient ? (
                    <span className="rounded-full bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]">
                      CLIENTE NUEVO
                    </span>
                  ) : null}
                  {priceProtected ? (
                    <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-200">
                      {order.isPriceLocked ? "PRECIO PROTEGIDO" : "PRECIO PROTEGIDO 90%"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 truncate text-[13px] text-[#B7B7C2]">
                  {order.advisorName} - {formatMasterOrderDateTime(order.deliveryAtISO)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
                <button
                  className={[
                    "rounded-xl border bg-[#0B0B0D] px-3 py-2 text-sm hover:border-[#FEEF00]/50",
                    whatsAppCopyStatus === "copied"
                      ? "border-emerald-500/50 text-emerald-300"
                      : whatsAppCopyStatus === "error"
                        ? "border-red-500/50 text-red-300"
                        : "border-[#242433] text-[#F5F5F7]",
                  ].join(" ")}
                  type="button"
                  onClick={handleCopyWhatsApp}
                  title={whatsAppCopyStatus === "error" ? "El navegador no permitio copiar el resumen" : undefined}
                >
                  {whatsAppCopyStatus === "copied"
                    ? "WS copiado"
                    : whatsAppCopyStatus === "error"
                      ? "No se copio"
                      : "Copiar WS"}
                </button>
                <button
                  className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] hover:border-[#FEEF00]/50"
                  type="button"
                  onClick={onClose}
                >
                  x
                </button>
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-[#242433] bg-[#121218] px-3 py-2">
            <RowProcessTimeline order={order} />
          </div>

          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {MASTER_ORDER_DETAIL_TABS.map((tab) => (
              <button
                key={tab.key}
                className={[
                  "shrink-0 rounded-full border px-3 py-1.5 text-[13px] transition",
                  activeTab === tab.key
                    ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                    : "border-[#242433] bg-[#121218] text-[#B7B7C2] hover:text-[#F5F5F7]",
                ].join(" ")}
                type="button"
                aria-pressed={activeTab === tab.key}
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {detailLoading ? (
            <div className="grid min-h-64 place-items-center rounded-2xl border border-[#242433] bg-[#121218] p-6 text-center">
              <div>
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#343442] border-t-[#FEEF00]" />
                <div className="mt-4 text-sm font-semibold text-[#F5F5F7]">Cargando detalle de la orden...</div>
                <div className="mt-1 text-xs text-[#8A8A96]">
                  Consultando pedido, pagos, eventos y ajustes.
                </div>
              </div>
            </div>
          ) : detailError ? (
            <div className="grid min-h-64 place-items-center rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
              <div>
                <div className="text-sm font-semibold text-red-200">No se pudo cargar el detalle</div>
                <div className="mt-2 max-w-md text-xs text-[#B7B7C2]">{detailError}</div>
                <button
                  className="mt-4 rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
                  type="button"
                  onClick={onRetryDetail}
                >
                  Reintentar
                </button>
              </div>
            </div>
          ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
            <div className="min-w-0">
              {activeTab === "notas" ? (
                <div className="mt-4 space-y-3">
                  <form
                    className="rounded-xl border border-[#242433] bg-[#121218] p-3"
                    onSubmit={handleOperationalNoteSubmit}
                  >
                    <div className="text-sm font-semibold text-[#F5F5F7]">Agregar nota operativa</div>
                    <div className="mt-1 text-[12px] text-[#8A8A96]">
                      Queda en el historial de la orden sin cambiar la nota comercial ni los montos.
                    </div>
                    <textarea
                      className="mt-3 min-h-24 w-full resize-y rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none transition placeholder:text-[#666672] focus:border-[#FEEF00]/60"
                      maxLength={1200}
                      placeholder="Ej.: Cliente confirma que recibira personalmente."
                      value={operationalNote}
                      onChange={(event) => setOperationalNote(event.target.value)}
                    />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-[11px] text-[#8A8A96]">{operationalNote.length}/1200</span>
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-[#0B0B0D] disabled:cursor-not-allowed disabled:opacity-50"
                        type="submit"
                        disabled={busy || operationalNote.trim().length < 3}
                      >
                        {runningAction === `add-note:${order.id}` ? "Guardando..." : "Guardar nota"}
                      </button>
                    </div>
                  </form>

                  <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Nota original del pedido</div>
                    <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                      {order.notes?.trim() || "Sin nota original."}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-[#F5F5F7]">Seguimiento operativo</div>
                      <div className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px] text-[#B7B7C2]">
                        {operationalNotes.length}
                      </div>
                    </div>
                    {operationalNotes.length === 0 ? (
                      <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
                        Sin notas operativas registradas.
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {operationalNotes.map((event) => (
                          <div key={event.id} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3">
                            <div className="text-sm text-[#F5F5F7]">{event.message || "Nota sin detalle."}</div>
                            <div className="mt-2 text-[11px] text-[#8A8A96]">
                              {event.actorName} - {formatMasterOrderDateTime(event.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <MasterOrderDetailBody
                  actionLabel={actionLabel}
                  activeTab={activeTab}
                  order={order}
                  showDeliveryProcessDetails={false}
                />
              )}
            </div>

            <aside className="min-w-0 space-y-3 xl:sticky xl:top-4">
              <div className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                <div className="flex flex-col gap-3">
              <div>
                <div className="text-[13px] font-semibold text-[#F5F5F7]">Acciones</div>
                <div className="mt-1 text-[12px] text-[#B7B7C2]">{actionLabel}</div>
              </div>
              <div className="grid gap-2">
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
                  <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-center text-sm font-semibold text-[#8A8A96]">
                    Sin accion principal
                  </div>
                )}
              </div>
            </div>
            {(canReturn ||
              canKitchenTake ||
              canAssign ||
              canOutForDelivery ||
              canClearDelivery ||
              canOpenPaymentReport ||
              canOpenRetentionReport ||
              canProtectPrice ||
              canReturnQueue ||
              canApplyClientFund ||
              canPayoutClientFund ||
              canCloseRounding ||
              canCancelOrder) ? (
              <div className="mt-3 border-t border-[#242433] pt-3">
                <div className="flex flex-wrap gap-2">
                  {canProtectPrice ? (
                    <button
                      className="rounded-xl border border-emerald-500/45 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 transition hover:border-emerald-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void handleProtectPriceClick();
                      }}
                    >
                      {runningAction === `protect-price:${order.id}` ? "Protegiendo..." : "Proteger precio"}
                    </button>
                  ) : null}
                  {canOpenPaymentReport ? (
                    <button
                      className="rounded-xl border border-sky-500/45 bg-sky-500/10 px-3 py-1.5 text-[12px] font-semibold text-sky-200 transition hover:border-sky-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => openPaymentReport(false)}
                    >
                      Reportar pago
                    </button>
                  ) : null}
                  {canOpenRetentionReport ? (
                    <button
                      className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FEEF00] transition hover:border-[#FEEF00] disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => openPaymentReport(true)}
                    >
                      Reportar retencion
                    </button>
                  ) : null}
                  {canKitchenTake ? (
                    <button
                      className="rounded-xl border border-emerald-500/45 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 transition hover:border-emerald-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setKitchenTakeBoxOpen((value) => !value)}
                    >
                      Tomar en cocina
                    </button>
                  ) : null}
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
                        {canCorrectDeliveredDelivery ? "Corregir interno" : "Asignar interno"}
                      </button>
                      <button
                        className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FEEF00] transition hover:border-[#FEEF00] disabled:cursor-wait disabled:opacity-60"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeliveryAssignMode((value) => value === "external" ? null : "external")}
                      >
                        {canCorrectDeliveredDelivery ? "Corregir externo" : "Asignar externo"}
                      </button>
                    </>
                  ) : null}
                  {canReturnQueue ? (
                    <button
                      className="rounded-xl border border-orange-500/45 bg-orange-500/10 px-3 py-1.5 text-[12px] font-semibold text-orange-200 transition hover:border-orange-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setReturnQueueBoxOpen((value) => !value)}
                    >
                      Regresar a cola
                    </button>
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
                  {canApplyClientFund ? (
                    <button
                      className="rounded-xl border border-emerald-500/45 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 transition hover:border-emerald-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={openFundApplyBox}
                    >
                      Aplicar fondo
                    </button>
                  ) : null}
                  {canPayoutClientFund ? (
                    <button
                      className="rounded-xl border border-sky-500/45 bg-sky-500/10 px-3 py-1.5 text-[12px] font-semibold text-sky-200 transition hover:border-sky-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const opening = !fundPayoutBoxOpen;
                        setFundPayoutBoxOpen(opening);
                        if (opening) ensureFundPayoutLine();
                      }}
                    >
                      Devolver fondo
                    </button>
                  ) : null}
                  {canCloseRounding ? (
                    <button
                      className="rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-[12px] font-semibold text-[#FEEF00] transition hover:border-[#FEEF00] disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setRoundingBoxOpen((value) => !value)}
                    >
                      Cerrar diferencia
                    </button>
                  ) : null}
                  {canCancelOrder ? (
                    <button
                      className="rounded-xl border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] font-semibold text-red-200 transition hover:border-red-400 disabled:cursor-wait disabled:opacity-60"
                      type="button"
                      disabled={busy}
                      onClick={() => setCancelBoxOpen((value) => !value)}
                    >
                      Cancelar
                    </button>
                  ) : null}
                </div>

                {kitchenTakeBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3" onSubmit={handleKitchenTakeSubmit}>
                    <div className="text-[12px] font-semibold text-emerald-100">Tomar orden en cocina</div>
                    <div className="mt-1 text-[11px] text-emerald-100/80">Indica el tiempo de preparacion que cocina esta comprometiendo.</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {["10", "15", "20", "25", "30"].map((minutes) => (
                        <button
                          key={minutes}
                          className={[
                            "rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition",
                            kitchenEtaMinutes === minutes
                              ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                              : "border-emerald-500/30 bg-[#0B0B0D] text-emerald-100 hover:border-emerald-400",
                          ].join(" ")}
                          type="button"
                          disabled={busy}
                          onClick={() => setKitchenEtaMinutes(minutes)}
                        >
                          {minutes} min
                        </button>
                      ))}
                      <input
                        className="min-w-[110px] rounded-lg border border-emerald-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[12px] text-[#F5F5F7]"
                        value={kitchenEtaMinutes}
                        onChange={(event) => setKitchenEtaMinutes(event.target.value)}
                        inputMode="numeric"
                        placeholder="ETA"
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-emerald-400 bg-emerald-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `kitchen-take:${order.id}` ? "Confirmando..." : "Confirmar cocina"}
                      </button>
                    </div>
                  </form>
                ) : null}

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
                    {canCorrectDeliveredDelivery ? (
                      <textarea
                        className="mt-3 min-h-[70px] w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        value={deliveryCorrectionNotes}
                        onChange={(event) => setDeliveryCorrectionNotes(event.target.value)}
                        placeholder="Motivo de correccion administrativa."
                      />
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `${canCorrectDeliveredDelivery ? "correct-delivered-internal" : "assign-internal"}:${order.id}`
                          ? "Guardando..."
                          : "Guardar interno"}
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
                    {canCorrectDeliveredDelivery ? (
                      <textarea
                        className="mt-3 min-h-[70px] w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        value={deliveryCorrectionNotes}
                        onChange={(event) => setDeliveryCorrectionNotes(event.target.value)}
                        placeholder="Motivo de correccion administrativa."
                      />
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `${canCorrectDeliveredDelivery ? "correct-delivered-external" : "assign-external"}:${order.id}`
                          ? "Guardando..."
                          : "Guardar externo"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {returnQueueBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-orange-500/30 bg-orange-500/10 p-3" onSubmit={handleReturnQueueSubmit}>
                    <div className="text-[12px] font-semibold text-orange-100">Regresar a cola</div>
                    <div className="mt-1 text-[11px] text-orange-100/80">
                      Saca la orden de cocina y la deja esperando una nueva revision operativa.
                    </div>
                    <textarea
                      className="mt-3 min-h-[74px] w-full rounded-lg border border-orange-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={returnQueueReason}
                      onChange={(event) => setReturnQueueReason(event.target.value)}
                      placeholder="Motivo del regreso a cola."
                    />
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-orange-400 bg-orange-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `return-queue:${order.id}` ? "Regresando..." : "Confirmar regreso"}
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

                {paymentReportOpen ? (
                  <form className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3" onSubmit={handlePaymentReportSubmit}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[12px] font-semibold text-sky-100">
                          {paymentReportIsRetention ? "Registrar retencion" : "Registrar pago"}
                        </div>
                        <div className="mt-1 text-[11px] text-sky-100/80">
                          El reporte queda en la misma cadena de pagos de la orden.
                        </div>
                      </div>
                      <button
                        className="rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-2.5 py-1 text-[11px] text-sky-100 hover:border-sky-400"
                        type="button"
                        disabled={busy}
                        onClick={closePaymentReport}
                      >
                        Cerrar
                      </button>
                    </div>

                    {!paymentReportIsRetention ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-lg border border-sky-500/20 bg-[#0B0B0D] px-3 py-2">
                          <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Saldo USD</div>
                          <div className="mt-1 text-[13px] font-semibold text-[#F5F5F7]">
                            {formatMasterOrderUSD(effectivePaymentSuggestion.pendingUsd)}
                          </div>
                        </div>
                        <div className="rounded-lg border border-sky-500/20 bg-[#0B0B0D] px-3 py-2">
                          <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Saldo Bs</div>
                          <div className="mt-1 text-[13px] font-semibold text-[#F5F5F7]">
                            {effectivePaymentSuggestion.pendingBs == null
                              ? "No disponible"
                              : formatMasterOrderBs(effectivePaymentSuggestion.pendingBs)}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {!paymentReportIsRetention && selectedPaymentAccount?.currencyCode === "VES" ? (
                      <div className="mt-2 rounded-lg border border-sky-500/20 bg-[#0B0B0D] px-3 py-2 text-[11px] text-sky-100/80">
                        {paymentSuggestionLoading
                          ? "Actualizando saldo canonico..."
                          : paymentCollectionMode === "snapshot_quote"
                            ? `Presupuesto congelado: se conserva ${formatMasterOrderBs(effectivePaymentSuggestion.pendingBs)} pendiente de la orden.`
                            : paymentCollectionMode === "post_delivery_usd"
                              ? "Cobranza dolarizada: la fecha de operacion es posterior a la entrega y usa la tasa activa."
                              : `Monto sugerido segun el estado financiero de la orden: ${formatMasterOrderBs(effectivePaymentSuggestion.pendingBs)}.`}
                        {paymentSuggestionError ? (
                          <div className="mt-1 text-amber-300">
                            No se pudo refrescar el saldo: {paymentSuggestionError}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-[11px] text-[#B7B7C2]">
                        Cuenta
                        <select
                          className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                          value={paymentReportAccountKey}
                          onChange={(event) => handlePaymentAccountChange(event.target.value)}
                        >
                          {paymentReportOptions.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.accountName} - {getPaymentMethodLabel(option.paymentMethodCode)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="text-[11px] text-[#B7B7C2]">
                        Fecha de operacion
                        <input
                          className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                          type="date"
                          value={paymentReportOperationDate}
                          onChange={(event) => handlePaymentOperationDateChange(event.target.value)}
                        />
                      </label>

                      <label className="text-[11px] text-[#B7B7C2]">
                        Monto {selectedPaymentAccount?.currencyCode ?? ""}
                        <input
                          className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                          value={paymentReportAmount}
                          onChange={(event) => setPaymentReportAmount(event.target.value)}
                          inputMode="decimal"
                          placeholder={paymentReportIsRetention ? "Monto" : `Pendiente ${formatMasterOrderUSD(order.balanceUsd)}`}
                        />
                      </label>

                      {selectedPaymentAccount?.currencyCode === "VES" &&
                      (paymentReportIsRetention || paymentCollectionMode !== "snapshot_quote") ? (
                        <label className="text-[11px] text-[#B7B7C2]">
                          Tasa Bs/USD
                          <input
                            className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                            value={paymentReportExchangeRate}
                            onChange={(event) => setPaymentReportExchangeRate(event.target.value)}
                            inputMode="decimal"
                            placeholder="Tasa"
                          />
                        </label>
                      ) : null}

                      <label className="text-[11px] text-[#B7B7C2]">
                        Referencia{paymentReportRequirements.requiresReference ? "" : " (opcional)"}
                        <input
                          className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                          value={paymentReportReferenceCode}
                          onChange={(event) => setPaymentReportReferenceCode(event.target.value)}
                          placeholder={paymentReportIsRetention ? "Comprobante" : "Referencia"}
                        />
                      </label>

                      {paymentReportRequirements.requiresBank ? (
                        <label className="text-[11px] text-[#B7B7C2]">
                          Banco
                          <input
                            className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                            value={paymentReportBankName}
                            onChange={(event) => setPaymentReportBankName(event.target.value)}
                            placeholder="Banco emisor"
                          />
                        </label>
                      ) : null}

                      {(paymentReportRequirements.requiresHolderName || paymentReportRequirements.requiresInvoiceNumber) ? (
                        <label className="text-[11px] text-[#B7B7C2]">
                          {paymentReportRequirements.requiresInvoiceNumber ? "Factura" : "Titular"}
                          <input
                            className="mt-1 w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                            value={paymentReportPayerName}
                            onChange={(event) => setPaymentReportPayerName(event.target.value)}
                            placeholder={paymentReportRequirements.requiresInvoiceNumber ? "Numero de factura" : "Nombre del titular"}
                          />
                        </label>
                      ) : null}
                    </div>

                    <label className="mt-2 block text-[11px] text-[#B7B7C2]">
                      Notas
                      <textarea
                        className="mt-1 min-h-[64px] w-full rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        value={paymentReportNotes}
                        onChange={(event) => setPaymentReportNotes(event.target.value)}
                        placeholder="Nota opcional"
                      />
                    </label>

                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-sky-400 bg-sky-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={
                          busy ||
                          paymentSuggestionLoading ||
                          (!paymentReportIsRetention &&
                            selectedPaymentAccount?.currencyCode === "VES" &&
                            Boolean(paymentSuggestionError))
                        }
                      >
                        {runningAction === `${paymentReportIsRetention ? "report-retention" : "report-payment"}:${order.id}`
                          ? "Guardando..."
                          : "Guardar reporte"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {fundApplyBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3" onSubmit={handleFundApplySubmit}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[12px] font-semibold text-emerald-100">Aplicar fondo del cliente</div>
                        <div className="mt-1 text-[11px] text-emerald-100/80">
                          Disponible {formatMasterOrderUSD(clientFundAvailableUsd)} · sugerido {formatMasterOrderUSD(suggestedFundApplyUsd)}
                        </div>
                      </div>
                      <button
                        className="rounded-lg border border-emerald-500/30 bg-[#0B0B0D] px-2.5 py-1 text-[11px] text-emerald-100 hover:border-emerald-400"
                        type="button"
                        disabled={busy}
                        onClick={() => setFundApplyBoxOpen(false)}
                      >
                        Cerrar
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-[11px] text-[#B7B7C2]">
                        Monto USD
                        <input
                          className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                          value={fundApplyAmountUsd}
                          onChange={(event) => setFundApplyAmountUsd(event.target.value)}
                          inputMode="decimal"
                          placeholder="Monto a aplicar"
                        />
                      </label>
                      <label className="text-[11px] text-[#B7B7C2]">
                        Nota
                        <input
                          className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                          value={fundApplyNotes}
                          onChange={(event) => setFundApplyNotes(event.target.value)}
                          placeholder="Opcional"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-emerald-400 bg-emerald-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `apply-fund:${order.id}` ? "Aplicando..." : "Aplicar fondo"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {fundPayoutBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3" onSubmit={handleFundPayoutSubmit}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[12px] font-semibold text-sky-100">Devolver fondo al cliente</div>
                        <div className="mt-1 text-[11px] text-sky-100/80">
                          Disponible {formatMasterOrderUSD(clientFundAvailableUsd)} · cargado {formatMasterOrderUSD(fundPayoutTotalUsd)}
                        </div>
                      </div>
                      <button
                        className="rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-2.5 py-1 text-[11px] text-sky-100 hover:border-sky-400"
                        type="button"
                        disabled={busy}
                        onClick={() => setFundPayoutBoxOpen(false)}
                      >
                        Cerrar
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {fundPayoutLines.map((line) => {
                        const account = moneyAccountByKey.get(line.accountKey) ?? null;
                        return (
                          <div key={line.localId} className="rounded-xl border border-sky-500/25 bg-[#0B0B0D] p-2">
                            <div className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr]">
                              <select
                                className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                value={line.accountKey}
                                onChange={(event) =>
                                  setFundPayoutLines((lines) =>
                                    lines.map((row) =>
                                      row.localId === line.localId ? recalculateLineForAccount(row, event.target.value) : row
                                    )
                                  )
                                }
                              >
                                {moneyPayoutOptions.map((option) => (
                                  <option key={option.key} value={option.key}>
                                    {getPaymentAccountLabel(option)}
                                  </option>
                                ))}
                              </select>
                              <input
                                className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                value={line.amount}
                                onChange={(event) => updateFundPayoutLine(line.localId, { amount: event.target.value })}
                                inputMode="decimal"
                                placeholder={`Monto ${account?.currencyCode ?? ""}`}
                              />
                              {account?.currencyCode === "VES" ? (
                                <input
                                  className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                  value={line.exchangeRate}
                                  onChange={(event) => updateFundPayoutLine(line.localId, { exchangeRate: event.target.value })}
                                  inputMode="decimal"
                                  placeholder="Tasa"
                                />
                              ) : null}
                              <input
                                className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                value={line.notes}
                                onChange={(event) => updateFundPayoutLine(line.localId, { notes: event.target.value })}
                                placeholder="Nota opcional"
                              />
                            </div>
                            <div className="mt-2 flex justify-between gap-2 text-[11px] text-sky-100/75">
                              <span>Equiv. {formatMasterOrderUSD(getMoneyLineUsd(line, account))}</span>
                              {fundPayoutLines.length > 1 ? (
                                <button
                                  className="text-red-200 hover:text-red-100"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setFundPayoutLines((lines) => lines.filter((row) => row.localId !== line.localId))}
                                >
                                  Quitar
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <button
                        className="rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[12px] font-semibold text-sky-100 hover:border-sky-400"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setFundPayoutLines((lines) => [
                            ...lines,
                            newMoneyLineDraft(defaultPayoutAccount, 0, activeRate, order),
                          ])
                        }
                      >
                        Agregar linea
                      </button>
                      <input
                        className="min-w-[180px] rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[12px] text-[#F5F5F7]"
                        value={fundPayoutNotes}
                        onChange={(event) => setFundPayoutNotes(event.target.value)}
                        placeholder="Nota general"
                      />
                    </div>
                    {fundPayoutExceedsAvailable ? (
                      <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                        El total cargado supera el fondo disponible por {formatMasterOrderUSD(fundPayoutTotalUsd - clientFundAvailableUsd)}.
                      </div>
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-sky-400 bg-sky-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy || fundPayoutTotalUsd <= 0.005 || fundPayoutExceedsAvailable}
                      >
                        {runningAction === `deliver-fund-change:${order.id}` ? "Devolviendo..." : "Guardar devolucion"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {roundingBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-[#FEEF00]/30 bg-[#FEEF00]/10 p-3" onSubmit={handleCloseRoundingSubmit}>
                    <div className="text-[12px] font-semibold text-[#FEEF00]">
                      Cerrar diferencia de {formatMasterOrderUSD(order.balanceUsd)}
                    </div>
                    <input
                      className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
                      value={roundingNotes}
                      onChange={(event) => setRoundingNotes(event.target.value)}
                      placeholder="Motivo"
                    />
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {runningAction === `close-rounding:${order.id}` ? "Cerrando..." : "Cerrar diferencia"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {cancelBoxOpen ? (
                  <form className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3" onSubmit={handleCancelSubmit}>
                    <div className="text-[12px] font-semibold text-red-100">Cancelar orden</div>
                    <textarea
                      className="mt-3 min-h-[74px] w-full rounded-lg border border-red-500/30 bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                      value={cancelReason}
                      onChange={(event) => setCancelReason(event.target.value)}
                      placeholder="Motivo obligatorio."
                    />
                    {order.clientFundUsedUsd > 0.005 ? (
                      <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-2 text-[11px] text-emerald-100/85">
                        Al cancelar se restauraran {formatMasterOrderUSD(order.clientFundUsedUsd)} de fondo aplicado al cliente.
                      </div>
                    ) : null}
                    {confirmedMoneyPaidUsd > 0.005 ? (
                      <div className="mt-3 rounded-xl border border-red-500/25 bg-[#0B0B0D] p-2">
                        <div className="text-[11px] text-red-100/80">
                          Esta orden tiene {formatMasterOrderUSD(confirmedMoneyPaidUsd)} en pagos confirmados.
                        </div>
                        <div className="mt-2 grid gap-2">
                          <label className="flex items-center gap-2 text-[12px] text-[#F5F5F7]">
                            <input
                              type="radio"
                              className="accent-[#FEEF00]"
                              checked={cancelPaidHandling === "store_fund"}
                              onChange={() => setCancelPaidHandling("store_fund")}
                            />
                            Enviar el pago confirmado al fondo del cliente
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-[#F5F5F7]">
                            <input
                              type="radio"
                              className="accent-[#FEEF00]"
                              checked={cancelPaidHandling === "refund"}
                              onChange={() => {
                                setCancelPaidHandling("refund");
                                ensureCancelRefundLine();
                              }}
                            />
                            Registrar devolucion inmediata
                          </label>
                        </div>
                        {cancelPaidHandling === "refund" ? (
                          <div className="mt-3 space-y-2">
                            <div className="text-[11px] text-red-100/75">
                              Devuelto {formatMasterOrderUSD(cancelRefundTotalUsd)} / {formatMasterOrderUSD(confirmedMoneyPaidUsd)}
                            </div>
                            {cancelRefundLines.map((line) => {
                              const account = moneyAccountByKey.get(line.accountKey) ?? null;
                              return (
                                <div key={line.localId} className="rounded-xl border border-red-500/25 bg-[#121218] p-2">
                                  <div className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr]">
                                    <select
                                      className="rounded-lg border border-red-500/30 bg-[#0B0B0D] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                      value={line.accountKey}
                                      onChange={(event) =>
                                        setCancelRefundLines((lines) =>
                                          lines.map((row) =>
                                            row.localId === line.localId ? recalculateLineForAccount(row, event.target.value) : row
                                          )
                                        )
                                      }
                                    >
                                      {moneyPayoutOptions.map((option) => (
                                        <option key={option.key} value={option.key}>
                                          {getPaymentAccountLabel(option)}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      className="rounded-lg border border-red-500/30 bg-[#0B0B0D] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                      value={line.amount}
                                      onChange={(event) => updateCancelRefundLine(line.localId, { amount: event.target.value })}
                                      inputMode="decimal"
                                      placeholder={`Monto ${account?.currencyCode ?? ""}`}
                                    />
                                    {account?.currencyCode === "VES" ? (
                                      <input
                                        className="rounded-lg border border-red-500/30 bg-[#0B0B0D] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                        value={line.exchangeRate}
                                        onChange={(event) => updateCancelRefundLine(line.localId, { exchangeRate: event.target.value })}
                                        inputMode="decimal"
                                        placeholder="Tasa"
                                      />
                                    ) : null}
                                    <input
                                      className="rounded-lg border border-red-500/30 bg-[#0B0B0D] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                      value={line.notes}
                                      onChange={(event) => updateCancelRefundLine(line.localId, { notes: event.target.value })}
                                      placeholder="Nota opcional"
                                    />
                                  </div>
                                </div>
                              );
                            })}
                            <button
                              className="rounded-lg border border-red-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[12px] font-semibold text-red-100 hover:border-red-400"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setCancelRefundLines((lines) => [
                                  ...lines,
                                  newMoneyLineDraft(defaultPayoutAccount, 0, activeRate, order),
                                ])
                              }
                            >
                              Agregar linea
                            </button>
                            {!cancelRefundMatchesConfirmedMoney ? (
                              <div className="text-[11px] text-red-200">
                                La devolucion debe coincidir exactamente con el pago confirmado.
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-xl border border-red-400 bg-red-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                        type="submit"
                        disabled={
                          busy ||
                          !cancelReason.trim() ||
                          (confirmedMoneyPaidUsd > 0.005 &&
                            cancelPaidHandling === "refund" &&
                            !cancelRefundMatchesConfirmedMoney)
                        }
                      >
                        {runningAction === `cancel-order:${order.id}` ? "Cancelando..." : "Confirmar cancelacion"}
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
                    const confirmationDraft =
                      paymentConfirmationDraft?.reportId === report.id ? paymentConfirmationDraft : null;
                    const confirmationOptions = getConfirmationOptions(report);
                    const confirmationAccount = confirmationDraft
                      ? moneyAccountByKey.get(confirmationDraft.accountKey) ?? null
                      : null;
                    const confirmationUsd = confirmationDraft
                      ? getPaymentConfirmationUsd(confirmationDraft, confirmationAccount)
                      : report.usdEquivalent;
                    const predictedExcessUsd = confirmationDraft
                      ? getConfirmationExcessUsd(confirmationDraft, confirmationAccount)
                      : Number(Math.max(0, report.usdEquivalent - order.balanceUsd).toFixed(2));
                    const confirmationChangeTotalUsd = confirmationDraft
                      ? Number(
                          confirmationDraft.changeLines
                            .reduce(
                              (sum, line) =>
                                sum + getMoneyLineUsd(line, moneyAccountByKey.get(line.accountKey) ?? null),
                              0
                            )
                            .toFixed(2)
                        )
                      : 0;
                    const changeMatchesExcess =
                      Math.abs(confirmationChangeTotalUsd - predictedExcessUsd) <= 0.01;
                    const confirmationAmount = confirmationDraft ? parseDecimal(confirmationDraft.amount) : 0;
                    const confirmationRate = confirmationDraft ? parseDecimal(confirmationDraft.exchangeRate) : 0;
                    const confirmationFieldsValid = Boolean(
                      confirmationDraft &&
                        confirmationAccount &&
                        Number.isFinite(confirmationAmount) &&
                        confirmationAmount > 0 &&
                        confirmationDraft.movementDate &&
                        (confirmationAccount.currencyCode !== "VES" ||
                          (Number.isFinite(confirmationRate) && confirmationRate > 0))
                    );
                    const overpaymentDecisionValid =
                      predictedExcessUsd <= 0.005 ||
                      Boolean(
                        confirmationDraft?.overpaymentHandling &&
                          (confirmationDraft.overpaymentHandling !== "change_given" || changeMatchesExcess) &&
                          (confirmationDraft.overpaymentHandling !== "close_difference" ||
                            (isAdmin && predictedExcessUsd <= ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD))
                      );
                    const isRunningConfirm = runningAction === `confirm-payment:${order.id}`;
                    const isRunningReject = runningAction === `reject-payment:${order.id}`;

                    return (
                      <div key={report.id} className="min-w-0 rounded-xl border border-orange-500/25 bg-orange-500/10 p-3">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-[13px] font-semibold text-[#F5F5F7]">
                              {report.currencyCode} {report.amount.toFixed(2)}
                            </span>
                            <span className="text-[12px] font-semibold text-orange-100">
                              {formatMasterOrderUSD(report.usdEquivalent)}
                            </span>
                          </div>
                          <div className="mt-2 space-y-1.5 rounded-lg border border-orange-500/15 bg-[#0B0B0D]/45 px-2.5 py-2 text-[11px]">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <span className="shrink-0 text-[#8A8A96]">Cuenta</span>
                              <span className="min-w-0 break-words text-right text-orange-100/90">
                                {report.moneyAccountName}
                              </span>
                            </div>
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <span className="shrink-0 text-[#8A8A96]">Operacion</span>
                              <span className="min-w-0 text-right text-[#F5F5F7]">
                                {paymentReportMovementDate(report)}
                              </span>
                            </div>
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <span className="shrink-0 text-[#8A8A96]">Referencia</span>
                              <span className="min-w-0 break-all text-right text-[#F5F5F7]">
                                {report.referenceCode || "--"}
                              </span>
                            </div>
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <span className="shrink-0 text-[#8A8A96]">Reporta</span>
                              <span className="min-w-0 break-words text-right text-[#F5F5F7]">
                                {report.reporterName}
                              </span>
                            </div>
                          </div>
                          <div>
                            {predictedExcessUsd > 0.005 ? (
                              <div className="mt-2 text-[11px] text-[#FEEF00]">
                                Excedente estimado {formatMasterOrderUSD(predictedExcessUsd)}. Requiere una decision explicita antes de confirmar.
                              </div>
                            ) : null}
                          </div>
                          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                            <button
                              className="min-w-0 whitespace-nowrap rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 disabled:cursor-wait disabled:opacity-60"
                              type="button"
                              disabled={busy}
                              onClick={() => openPaymentConfirmation(report)}
                            >
                              {confirmationDraft ? "Cerrar revision" : "Revisar y confirmar"}
                            </button>
                            <button
                              className="whitespace-nowrap rounded-xl border border-red-500/45 bg-red-500/10 px-3 py-1.5 text-[12px] font-semibold text-red-200 disabled:cursor-wait disabled:opacity-60"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setPaymentConfirmationDraft(null);
                                setPaymentRejectReportId((current) => (current === report.id ? null : report.id));
                                setPaymentRejectNotes("");
                              }}
                            >
                              Rechazar
                            </button>
                          </div>
                        </div>
                        {confirmationDraft ? (
                          <form
                            className="mt-3 rounded-xl border border-emerald-500/30 bg-[#0B0B0D] p-3"
                            onSubmit={(event) => handleConfirmPaymentSubmit(event, report)}
                          >
                            <div className="text-[12px] font-semibold text-emerald-100">
                              Datos que se registraran al confirmar
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <label className="text-[11px] text-[#B7B7C2]">
                                Cuenta
                                <select
                                  className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7]"
                                  value={confirmationDraft.accountKey}
                                  onChange={(event) => handlePaymentConfirmationAccountChange(report, event.target.value)}
                                >
                                  {confirmationOptions.length === 0 ? <option value="">Sin cuentas disponibles</option> : null}
                                  {confirmationOptions.map((option) => (
                                    <option key={option.key} value={option.key}>
                                      {getPaymentAccountLabel(option)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="text-[11px] text-[#B7B7C2]">
                                Monto {confirmationAccount?.currencyCode ?? report.currencyCode}
                                <input
                                  className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7]"
                                  value={confirmationDraft.amount}
                                  onChange={(event) =>
                                    updatePaymentConfirmationDraft(
                                      report.id,
                                      { amount: event.target.value },
                                      true
                                    )
                                  }
                                  inputMode="decimal"
                                />
                              </label>
                              {confirmationAccount?.currencyCode === "VES" ? (
                                <label className="text-[11px] text-[#B7B7C2]">
                                  Tasa Bs/USD
                                  <input
                                    className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7]"
                                    value={confirmationDraft.exchangeRate}
                                    onChange={(event) =>
                                      updatePaymentConfirmationDraft(
                                        report.id,
                                        { exchangeRate: event.target.value },
                                        true
                                      )
                                    }
                                    inputMode="decimal"
                                  />
                                </label>
                              ) : null}
                              <label className="text-[11px] text-[#B7B7C2]">
                                Fecha de operacion
                                <input
                                  className="mt-1 w-full rounded-lg border border-emerald-500/30 bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7]"
                                  type="date"
                                  value={confirmationDraft.movementDate}
                                  onChange={(event) =>
                                    updatePaymentConfirmationDraft(report.id, { movementDate: event.target.value })
                                  }
                                />
                              </label>
                            </div>
                            <div className="mt-2 rounded-lg border border-[#242433] bg-[#121218] px-3 py-2 text-[11px] text-[#B7B7C2]">
                              Equivalente confirmado {formatMasterOrderUSD(confirmationUsd)} - saldo actual {formatMasterOrderUSD(order.balanceUsd)}
                            </div>

                            {predictedExcessUsd > 0.005 ? (
                              <div className="mt-3 rounded-xl border border-[#FEEF00]/30 bg-[#FEEF00]/10 p-3">
                                <div className="text-[12px] font-semibold text-[#FEEF00]">
                                  Decide que hacer con {formatMasterOrderUSD(predictedExcessUsd)} de excedente
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <button
                                    className={[
                                      "rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition",
                                      confirmationDraft.overpaymentHandling === "store_fund"
                                        ? "border-emerald-400 bg-emerald-400 text-[#0B0B0D]"
                                        : "border-emerald-500/35 bg-[#0B0B0D] text-emerald-100",
                                    ].join(" ")}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handlePaymentOverpaymentChange(report, "store_fund")}
                                  >
                                    Guardar en fondo
                                  </button>
                                  <button
                                    className={[
                                      "rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition",
                                      confirmationDraft.overpaymentHandling === "change_given"
                                        ? "border-sky-400 bg-sky-400 text-[#0B0B0D]"
                                        : "border-sky-500/35 bg-[#0B0B0D] text-sky-100",
                                    ].join(" ")}
                                    type="button"
                                    disabled={busy || !defaultPayoutAccount}
                                    onClick={() => handlePaymentOverpaymentChange(report, "change_given")}
                                  >
                                    Entregar cambio
                                  </button>
                                  {isAdmin && predictedExcessUsd <= ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD ? (
                                    <button
                                      className={[
                                        "rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition",
                                        confirmationDraft.overpaymentHandling === "close_difference"
                                          ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                                          : "border-[#FEEF00]/35 bg-[#0B0B0D] text-[#FEEF00]",
                                      ].join(" ")}
                                      type="button"
                                      disabled={busy}
                                      onClick={() => handlePaymentOverpaymentChange(report, "close_difference")}
                                    >
                                      Cerrar por redondeo
                                    </button>
                                  ) : null}
                                </div>

                                {confirmationDraft.overpaymentHandling === "change_given" ? (
                                  <div className="mt-3 space-y-2">
                                    {confirmationDraft.changeLines.map((line) => {
                                      const account = moneyAccountByKey.get(line.accountKey) ?? null;
                                      return (
                                        <div key={line.localId} className="rounded-xl border border-sky-500/25 bg-[#0B0B0D] p-2">
                                          <div className="grid gap-2">
                                            <select
                                              className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                              value={line.accountKey}
                                              onChange={(event) =>
                                                updatePaymentChangeLine(
                                                  line.localId,
                                                  recalculateLineForAccount(line, event.target.value)
                                                )
                                              }
                                            >
                                              {moneyPayoutOptions.map((option) => (
                                                <option key={option.key} value={option.key}>
                                                  {getPaymentAccountLabel(option)}
                                                </option>
                                              ))}
                                            </select>
                                            <input
                                              className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                              value={line.amount}
                                              onChange={(event) => updatePaymentChangeLine(line.localId, { amount: event.target.value })}
                                              inputMode="decimal"
                                              placeholder={`Monto ${account?.currencyCode ?? ""}`}
                                            />
                                            {account?.currencyCode === "VES" ? (
                                              <input
                                                className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                                value={line.exchangeRate}
                                                onChange={(event) => updatePaymentChangeLine(line.localId, { exchangeRate: event.target.value })}
                                                inputMode="decimal"
                                                placeholder="Tasa"
                                              />
                                            ) : null}
                                            <input
                                              className="rounded-lg border border-sky-500/30 bg-[#121218] px-2 py-2 text-[12px] text-[#F5F5F7]"
                                              value={line.notes}
                                              onChange={(event) => updatePaymentChangeLine(line.localId, { notes: event.target.value })}
                                              placeholder="Nota opcional"
                                            />
                                          </div>
                                          <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-sky-100/75">
                                            <span>Equiv. {formatMasterOrderUSD(getMoneyLineUsd(line, account))}</span>
                                            {confirmationDraft.changeLines.length > 1 ? (
                                              <button
                                                className="text-red-200 hover:text-red-100"
                                                type="button"
                                                disabled={busy}
                                                onClick={() =>
                                                  updatePaymentConfirmationDraft(report.id, {
                                                    changeLines: confirmationDraft.changeLines.filter(
                                                      (row) => row.localId !== line.localId
                                                    ),
                                                  })
                                                }
                                              >
                                                Quitar
                                              </button>
                                            ) : null}
                                          </div>
                                        </div>
                                      );
                                    })}
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <button
                                        className="rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-1.5 text-[11px] font-semibold text-sky-100 hover:border-sky-400"
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          updatePaymentConfirmationDraft(report.id, {
                                            changeLines: [
                                              ...confirmationDraft.changeLines,
                                              newMoneyLineDraft(defaultPayoutAccount, 0, activeRate, order),
                                            ],
                                          })
                                        }
                                      >
                                        Agregar linea
                                      </button>
                                      <span className={changeMatchesExcess ? "text-[11px] text-emerald-300" : "text-[11px] text-red-200"}>
                                        Cambio {formatMasterOrderUSD(confirmationChangeTotalUsd)} / {formatMasterOrderUSD(predictedExcessUsd)}
                                      </span>
                                    </div>
                                  </div>
                                ) : null}

                                <input
                                  className="mt-3 w-full rounded-lg border border-[#FEEF00]/30 bg-[#0B0B0D] px-3 py-2 text-[12px] text-[#F5F5F7]"
                                  value={confirmationDraft.overpaymentNotes}
                                  onChange={(event) =>
                                    updatePaymentConfirmationDraft(report.id, { overpaymentNotes: event.target.value })
                                  }
                                  placeholder="Nota sobre fondo, cambio o redondeo (opcional)"
                                />
                              </div>
                            ) : null}

                            <textarea
                              className="mt-3 min-h-[64px] w-full rounded-lg border border-emerald-500/30 bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
                              value={confirmationDraft.reviewNotes}
                              onChange={(event) =>
                                updatePaymentConfirmationDraft(report.id, { reviewNotes: event.target.value })
                              }
                              placeholder="Nota de revision (opcional)"
                            />
                            <div className="mt-3 flex justify-end">
                              <button
                                className="rounded-xl border border-emerald-400 bg-emerald-400 px-3 py-2 text-[12px] font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                                type="submit"
                                disabled={busy || !confirmationFieldsValid || !overpaymentDecisionValid}
                              >
                                {isRunningConfirm ? "Confirmando..." : "Confirmar pago revisado"}
                              </button>
                            </div>
                          </form>
                        ) : null}
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
                <div className="flex flex-wrap gap-2">
                  {advancedLinks.map((link) => (
                    <button
                      key={link.label}
                      className={[
                        "rounded-xl border px-3 py-1.5 text-[12px] font-semibold transition",
                        link.tone === "danger"
                          ? "border-red-500/45 bg-red-500/10 text-red-200 hover:border-red-400"
                          : "border-[#242433] bg-[#0B0B0D] text-[#B7B7C2] hover:border-[#FEEF00]/50 hover:text-[#F5F5F7]",
                      ].join(" ")}
                      type="button"
                      disabled={busy}
                      onClick={() => onEditOrder(order)}
                    >
                      {link.label}
                    </button>
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
            </aside>
          </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function MasterOpsClient({
  currentUserName,
  roles,
  publicVapidKey,
  focusDate,
  snapshotAt,
  activeRate,
  orders,
  openedOrder,
  stats,
  drivers,
  deliveryPartners,
  paymentAccounts,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusDateInputRef = useRef<HTMLInputElement>(null);
  const [tray, setTray] = useState<MasterTray>("all");
  const [search, setSearch] = useState("");
  const [submittedOrderSearch, setSubmittedOrderSearch] = useState("");
  const [isOrderSearchSubmitted, setIsOrderSearchSubmitted] = useState(false);
  const [orderSearchSubmissionVersion, setOrderSearchSubmissionVersion] = useState(0);
  const [remoteOrderSearchResults, setRemoteOrderSearchResults] = useState<MasterOpsOrderSearchResult[]>([]);
  const [remoteOrderSearchLoading, setRemoteOrderSearchLoading] = useState(false);
  const [remoteOrderSearchError, setRemoteOrderSearchError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [orderDetails, setOrderDetails] = useState<
    Record<number, { snapshotAt: string; detail: MasterOpsOrderDetailPayload }>
  >({});
  const [detailLoadingOrderId, setDetailLoadingOrderId] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRequestVersion, setDetailRequestVersion] = useState(0);
  const detailRequestTokenRef = useRef(0);
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [rateEditorOpen, setRateEditorOpen] = useState(false);
  const [exchangeRateInput, setExchangeRateInput] = useState(activeRate ? String(activeRate) : "");
  const [exchangeRateSaving, setExchangeRateSaving] = useState(false);
  const [exchangeRateError, setExchangeRateError] = useState<string | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = useState<DetailTab>("detalle");
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inboxMode, setInboxMode] = useState<MasterOpsInboxKind | null>(null);
  const [inboxCounts, setInboxCounts] = useState({ actions: stats.actions, updates: stats.updates });
  const lastRefreshRequestAtRef = useRef(Date.now());
  const [isRefreshing, startTransition] = useTransition();

  useEffect(() => {
    if (!rateEditorOpen) {
      setExchangeRateInput(activeRate ? String(activeRate) : "");
      setExchangeRateError(null);
    }
  }, [activeRate, rateEditorOpen]);

  useEffect(() => {
    setInboxCounts({ actions: stats.actions, updates: stats.updates });
  }, [stats.actions, stats.updates]);

  const requestOpsRefresh = useCallback(() => {
    lastRefreshRequestAtRef.current = Date.now();
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    lastRefreshRequestAtRef.current = Date.now();
  }, [snapshotAt]);

  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState !== "visible") return;
      if (selectedOrderId || editingOrderId || createOrderOpen || rateEditorOpen || inboxMode) return;
      if (Date.now() - lastRefreshRequestAtRef.current < 120_000) return;
      requestOpsRefresh();
    };

    const intervalId = window.setInterval(refreshIfStale, 120_000);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [
    createOrderOpen,
    editingOrderId,
    inboxMode,
    rateEditorOpen,
    requestOpsRefresh,
    selectedOrderId,
  ]);

  useEffect(() => {
    if (!selectedOrderId) {
      detailRequestTokenRef.current += 1;
      setDetailLoadingOrderId(null);
      setDetailError(null);
      return;
    }

    const cached = orderDetails[selectedOrderId];
    if (cached?.snapshotAt === snapshotAt) {
      setDetailLoadingOrderId(null);
      setDetailError(null);
      return;
    }

    const requestToken = detailRequestTokenRef.current + 1;
    detailRequestTokenRef.current = requestToken;
    let cancelled = false;
    setDetailLoadingOrderId(selectedOrderId);
    setDetailError(null);

    loadMasterOpsOrderDetailAction({ orderId: selectedOrderId })
      .then((result) => {
        if (cancelled || detailRequestTokenRef.current !== requestToken) return;
        if (!result.ok) {
          setDetailError(result.message);
          return;
        }
        setOrderDetails((current) => ({
          ...current,
          [selectedOrderId]: {
            snapshotAt,
            detail: result.detail,
          },
        }));
      })
      .catch((error) => {
        if (cancelled || detailRequestTokenRef.current !== requestToken) return;
        setDetailError(error instanceof Error ? error.message : "No se pudo cargar el detalle de la orden.");
      })
      .finally(() => {
        if (cancelled || detailRequestTokenRef.current !== requestToken) return;
        setDetailLoadingOrderId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [detailRequestVersion, orderDetails, selectedOrderId, snapshotAt]);

  const handleInboxCountChange = useCallback((kind: MasterOpsInboxKind, count: number) => {
    setInboxCounts((current) => current[kind] === count ? current : { ...current, [kind]: count });
  }, []);

  const closeInbox = useCallback(() => setInboxMode(null), []);

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
  const emptyOrdersMessage = search.trim()
    ? `No hay pedidos del dia que coincidan con "${search.trim()}". Presiona Buscar para consultar el historial.`
    : tray === "all"
      ? "No hay pedidos para este dia."
      : "No hay pedidos en esta bandeja para el dia seleccionado.";
  const selectedOrder = useMemo(() => {
    const order =
      orders.find((item) => item.id === selectedOrderId) ??
      (openedOrder?.id === selectedOrderId ? openedOrder : null);
    if (!order) return null;
    const cached = orderDetails[order.id];
    return cached?.snapshotAt === snapshotAt
      ? { ...order, ...cached.detail }
      : order;
  }, [openedOrder, orderDetails, orders, selectedOrderId, snapshotAt]);
  const selectedOrderDetailReady = Boolean(
    selectedOrderId && orderDetails[selectedOrderId]?.snapshotAt === snapshotAt
  );
  const shouldSearchOrders =
    isOrderSearchSubmitted &&
    (submittedOrderSearch.trim().length >= 2 || /^\d+$/.test(submittedOrderSearch.trim()));
  const localOrderSearchResults = useMemo<MasterOpsMergedSearchResult[]>(() => {
    const query = normalizeSearchText(submittedOrderSearch);
    if (!query) return [];

    const results: MasterOpsMergedSearchResult[] = [];

    orders.forEach((order) => {
      const values = [
        order.id,
        orderDisplayNumber(order),
        order.clientName,
        order.clientPhone,
        order.receiverName,
        order.receiverPhone,
        order.advisorName,
        order.address,
      ].map(normalizeSearchText);
      const matched = values.some((value) => value.includes(query));
      if (!matched) return;

      results.push({
        id: order.id,
        matchPriority: values[1] === query || String(order.id) === query ? 0 : 5,
        label: `${orderDisplayNumber(order)} - ${order.clientName}`,
        sub: `${ORDER_STATUS_LABELS[order.status]} - ${caracasDateKeyFromISO(order.deliveryAtISO)} - ${fmtUSD(order.totalUsd)}`,
        operationalDate: caracasDateKeyFromISO(order.deliveryAtISO),
        source: "local",
      });
    });

    return results
      .sort((a, b) => a.matchPriority - b.matchPriority || b.id - a.id)
      .slice(0, 10);
  }, [orders, submittedOrderSearch]);
  const mergedOrderSearchResults = useMemo<MasterOpsMergedSearchResult[]>(() => {
    const localIds = new Set(localOrderSearchResults.map((result) => result.id));
    const remote = remoteOrderSearchResults
      .filter((result) => !localIds.has(result.id))
      .map((result) => ({
        id: result.id,
        matchPriority: result.matchPriority,
        label: `${formatOrderDisplayNumber(result.id)} - ${result.clientName}`,
        sub: `${ORDER_STATUS_LABELS[result.status as OrderStatus] ?? result.status} - ${result.operationalDate} - ${fmtUSD(result.totalUsd)}`,
        operationalDate: result.operationalDate,
        source: "remote" as const,
      }));

    return [...localOrderSearchResults, ...remote]
      .sort((a, b) => a.matchPriority - b.matchPriority || b.id - a.id)
      .slice(0, 12);
  }, [localOrderSearchResults, remoteOrderSearchResults]);

  function openOrder(order: MasterOpsOrder, tab: DetailTab = "detalle") {
    setSelectedOrderId(order.id);
    setSelectedDetailTab(tab);
    setActionError(null);
    setDetailError(null);
  }

  function navigateToFocusDate(nextFocusDate: string) {
    if (nextFocusDate === focusDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextFocusDate)) return;

    const params = new URLSearchParams(searchParams.toString());
    params.set("focusDate", nextFocusDate);
    params.delete("openOrder");
    params.delete("tab");
    router.push(`/app/master/ops?${params.toString()}`, { scroll: false });
  }

  function openFocusDatePicker() {
    const input = focusDateInputRef.current;
    if (!input) return;

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        input.focus();
      }
    }

    input.click();
  }

  function openInboxOrder(item: MasterOpsInboxItem) {
    setInboxMode(null);
    const localOrder = orders.find((order) => order.id === item.orderId);
    if (localOrder) {
      openOrder(localOrder, item.openTab);
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    params.set("focusDate", item.operationalDate);
    params.set("openOrder", String(item.orderId));
    params.set("tab", item.openTab);
    router.replace(`/app/master/ops?${params.toString()}`, { scroll: false });
  }

  function openSearchOrderResult(result: MasterOpsMergedSearchResult) {
    setSearch("");
    setSubmittedOrderSearch("");
    setIsOrderSearchSubmitted(false);
    setRemoteOrderSearchResults([]);
    setRemoteOrderSearchError(null);

    const localOrder = orders.find((order) => order.id === result.id);
    if (localOrder) {
      openOrder(localOrder, "detalle");
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    params.set("openOrder", String(result.id));
    params.set("tab", "detalle");
    router.replace(`/app/master/ops?${params.toString()}`, { scroll: false });
  }

  function closeOrderDetail() {
    setSelectedOrderId(null);

    if (!searchParams.has("openOrder")) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("openOrder");
    params.delete("tab");
    const query = params.toString();
    router.replace(query ? `/app/master/ops?${query}` : "/app/master/ops", { scroll: false });
  }

  async function saveExchangeRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rate = Number(exchangeRateInput.replace(",", "."));
    if (!Number.isFinite(rate) || rate <= 0) {
      setExchangeRateError("La tasa debe ser mayor a 0.");
      return;
    }

    setExchangeRateSaving(true);
    setExchangeRateError(null);
    try {
      await updateMasterOpsExchangeRateAction({ rateBsPerUsd: rate });
      setRateEditorOpen(false);
      requestOpsRefresh();
    } catch (error) {
      setExchangeRateError(error instanceof Error ? error.message : "No se pudo guardar la tasa.");
    } finally {
      setExchangeRateSaving(false);
    }
  }

  useEffect(() => {
    const query = submittedOrderSearch.trim();

    if (!shouldSearchOrders) {
      setRemoteOrderSearchResults([]);
      setRemoteOrderSearchLoading(false);
      setRemoteOrderSearchError(null);
      return;
    }

    let cancelled = false;
    setRemoteOrderSearchLoading(true);
    setRemoteOrderSearchError(null);

    const timer = window.setTimeout(() => {
      searchMasterOpsOrdersAction({ query, limit: 10 })
        .then((results) => {
          if (cancelled) return;
          setRemoteOrderSearchResults(results as MasterOpsOrderSearchResult[]);
        })
        .catch((error) => {
          if (cancelled) return;
          setRemoteOrderSearchResults([]);
          setRemoteOrderSearchError(error instanceof Error ? error.message : "No se pudo buscar en el historial.");
        })
        .finally(() => {
          if (cancelled) return;
          setRemoteOrderSearchLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [submittedOrderSearch, orderSearchSubmissionVersion, shouldSearchOrders]);

  useEffect(() => {
    const openOrderValue = searchParams.get("openOrder");
    if (!openOrderValue) return;

    const openOrderId = Number(openOrderValue);
    if (!Number.isFinite(openOrderId) || openOrderId <= 0) return;

    const order =
      orders.find((item) => item.id === openOrderId) ??
      (openedOrder?.id === openOrderId ? openedOrder : null);
    if (!order) return;

    const requestedTab = searchParams.get("tab");
    const openTab = MASTER_ORDER_DETAIL_TABS.some((tab) => tab.key === requestedTab)
      ? requestedTab as DetailTab
      : "detalle";
    if (selectedOrderId !== openOrderId) {
      setSelectedOrderId(order.id);
      setSelectedDetailTab(openTab);
      setActionError(null);
      setDetailError(null);
      return;
    }
    if (selectedDetailTab !== openTab) setSelectedDetailTab(openTab);
  }, [openedOrder, orders, searchParams, selectedDetailTab, selectedOrderId]);

  async function runCreatePaymentReport(order: MasterOpsOrder, payload: PaymentReportDraft) {
    const actionId = `${payload.isRetention ? "report-retention" : "report-payment"}:${order.id}`;
    setRunningAction(actionId);
    setActionError(null);

    try {
      if (!payload.isRetention && order.balanceUsd <= 0.005) {
        throw new Error("Esta orden ya no tiene saldo pendiente.");
      }

      const account = paymentAccounts.find((option) => option.key === payload.accountKey) ?? null;
      if (!account) {
        throw new Error("Debes seleccionar una cuenta.");
      }

      const amount = parseDecimal(payload.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Debes indicar un monto valido.");
      }

      const operationDate = payload.operationDate.trim();
      const referenceCode = payload.referenceCode.trim();
      const bankName = payload.bankName.trim();
      const payerName = payload.payerName.trim();

      if (!operationDate) {
        throw new Error("Debes indicar la fecha de la operacion.");
      }

      const validationError = validatePaymentReportDetails({
        method: account.paymentMethodCode,
        operationDate,
        referenceCode,
        bankName,
        holderName: payerName,
      });
      if (validationError) {
        throw new Error(validationError);
      }

      let exchangeRate: number | null = null;
      if (account.currencyCode === "VES") {
        exchangeRate = parseDecimal(payload.exchangeRate);
        if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
          throw new Error("Debes indicar una tasa valida para pagos en VES.");
        }
      }

      await createPaymentReportAction({
        orderId: order.id,
        reportedMoneyAccountId: account.accountId,
        reportedCurrency: account.currencyCode,
        reportedAmount: amount,
        reportedExchangeRateVesPerUsd: exchangeRate,
        paymentMethod: account.paymentMethodCode,
        operationDate,
        referenceCode: referenceCode || null,
        bankName: bankName || null,
        payerName: payerName || null,
        notes: payload.notes.trim() || null,
      });

      requestOpsRefresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo reportar el pago.");
      return false;
    } finally {
      setRunningAction(null);
    }
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
      } else if (action === "kitchen-take") {
        const etaMinutes = Number(payload.etaMinutes);
        if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) throw new Error("Debes indicar un ETA valido.");
        result = await kitchenTakeAction({
          orderId: order.id,
          etaMinutes,
        });
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
      } else if (action === "correct-delivered-internal") {
        const driverUserId = String(payload.driverUserId || "").trim();
        const notes = String(payload.correctionNotes || "").trim();
        const costUsd = payload.costUsd == null ? null : Number(payload.costUsd);
        if (!driverUserId) throw new Error("Debes seleccionar un motorizado interno.");
        if (notes.length < 6) throw new Error("Debes indicar un motivo claro para la correccion.");
        result = await correctDeliveredDeliveryAssignmentAction({
          orderId: order.id,
          assignmentKind: "internal",
          driverUserId,
          costUsd: costUsd != null && Number.isFinite(costUsd) ? Math.max(0, costUsd) : null,
          notes,
        });
      } else if (action === "correct-delivered-external") {
        const partnerId = Number(payload.partnerId || 0);
        const distanceKm = Number(payload.distanceKm);
        const costUsd = Number(payload.costUsd);
        const notes = String(payload.correctionNotes || "").trim();
        if (!Number.isFinite(partnerId) || partnerId <= 0) throw new Error("Debes seleccionar un partner externo.");
        if (!Number.isFinite(distanceKm) || distanceKm <= 0) throw new Error("Debes indicar la distancia en km.");
        if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Debes indicar el costo del delivery.");
        if (notes.length < 6) throw new Error("Debes indicar un motivo claro para la correccion.");
        result = await correctDeliveredDeliveryAssignmentAction({
          orderId: order.id,
          assignmentKind: "external",
          partnerId,
          reference: payload.reference ?? null,
          distanceKm,
          costUsd,
          notes,
        });
      } else if (action === "return-created") {
        result = await returnToCreatedAction({
          orderId: order.id,
          reason: payload.reason ?? "",
          recalculatePricing: Boolean(payload.recalculatePricing),
        });
      } else if (action === "return-queue") {
        const reason = String(payload.reason || "").trim();
        if (!reason) throw new Error("Debes indicar un motivo.");
        result = await returnFromKitchenToQueueAction({
          orderId: order.id,
          reason,
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
        const exchangeRate =
          payload.exchangeRate == null || !Number.isFinite(Number(payload.exchangeRate))
            ? null
            : Number(payload.exchangeRate);
        const confirmationAccount = paymentAccounts.find(
          (option) =>
            option.accountId === moneyAccountId &&
            option.currencyCode === currencyCode &&
            isRetentionPaymentAccount(option) === Boolean(payload.isRetention)
        );
        if (!Number.isFinite(reportId) || reportId <= 0) throw new Error("No se pudo identificar el reporte de pago.");
        if (!confirmationAccount) throw new Error("Debes seleccionar una cuenta valida para este pago.");
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Debes indicar un monto valido.");
        if (!movementDate) throw new Error("Debes indicar la fecha de operacion.");
        if (currencyCode === "VES" && (!exchangeRate || exchangeRate <= 0)) {
          throw new Error("Debes indicar una tasa valida para el pago en VES.");
        }

        const confirmedUsd = Number((currencyCode === "VES" ? amount / Number(exchangeRate) : amount).toFixed(2));
        const predictedExcessUsd = Number(Math.max(0, confirmedUsd - order.balanceUsd).toFixed(2));
        const overpaymentHandling = payload.overpaymentHandling ?? null;
        if (predictedExcessUsd > 0.005 && !overpaymentHandling) {
          throw new Error("Debes decidir que hacer con el excedente antes de confirmar.");
        }
        if (overpaymentHandling === "close_difference") {
          if (!roles.includes("admin")) throw new Error("Solo admin puede cerrar excedentes por redondeo.");
          if (predictedExcessUsd > ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD) {
            throw new Error(
              `Solo se pueden cerrar excedentes de hasta ${ORDER_ROUNDING_OVERPAYMENT_CLOSE_MAX_USD.toFixed(2)} USD.`
            );
          }
        }

        const changeLines = (payload.changeLines ?? []).map((line) => ({
          moneyAccountId: Number(line.moneyAccountId || 0),
          currencyCode: String(line.currencyCode || "").trim().toUpperCase(),
          amount: Number(line.amount),
          exchangeRateVesPerUsd:
            line.exchangeRate == null || !Number.isFinite(Number(line.exchangeRate))
              ? null
              : Number(line.exchangeRate),
          notes: line.notes ?? null,
        }));
        if (predictedExcessUsd > 0.005 && overpaymentHandling === "change_given") {
          if (changeLines.length === 0) throw new Error("Debes agregar al menos una linea de cambio.");
          const totalChangeUsd = Number(
            changeLines
              .reduce((sum, line) => {
                const account = paymentAccounts.find(
                  (option) => option.accountId === line.moneyAccountId && option.currencyCode === line.currencyCode
                );
                if (!account || !Number.isFinite(line.amount) || line.amount <= 0) {
                  throw new Error("Una linea de cambio tiene cuenta o monto invalido.");
                }
                if (line.currencyCode === "VES" && (!line.exchangeRateVesPerUsd || line.exchangeRateVesPerUsd <= 0)) {
                  throw new Error("Debes indicar una tasa valida para cada linea de cambio en VES.");
                }
                return sum + (line.currencyCode === "VES" ? line.amount / Number(line.exchangeRateVesPerUsd) : line.amount);
              }, 0)
              .toFixed(2)
          );
          if (Math.abs(totalChangeUsd - predictedExcessUsd) > 0.01) {
            throw new Error("El cambio debe coincidir con el excedente calculado.");
          }
        }

        result = await confirmMasterOpsPaymentReportAction({
          reportId,
          orderId: order.id,
          confirmedMoneyAccountId: moneyAccountId,
          confirmedCurrency: currencyCode,
          confirmedAmount: amount,
          movementDate,
          confirmedExchangeRateVesPerUsd: currencyCode === "VES" ? exchangeRate : null,
          reviewNotes: payload.notes?.trim() || "Confirmado desde modulo operativo.",
          referenceCode: payload.reference ?? null,
          counterpartyName: payload.payerName ?? null,
          description: payload.description ?? `Pago confirmado desde Master Ops - orden ${order.id} - reporte ${reportId}`,
          paymentKind: payload.isRetention ? "retention" : null,
          overpaymentHandling: predictedExcessUsd > 0.005 ? overpaymentHandling : null,
          overpaymentNotes: payload.overpaymentNotes?.trim() || null,
          changeLines:
            predictedExcessUsd > 0.005 && overpaymentHandling === "change_given" ? changeLines : [],
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
      } else if (action === "protect-price") {
        result = await protectOrderPriceAction({ orderId: order.id });
      } else if (action === "apply-fund") {
        const amountUsd = Number(payload.fundAmountUsd);
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("Debes indicar un monto valido.");
        result = await applyClientFundPaymentAction({
          orderId: order.id,
          amountUsd,
          notes: payload.notes?.trim() || null,
        });
      } else if (action === "deliver-fund-change") {
        const lines = (payload.moneyLines ?? []).map((line) => ({
          moneyAccountId: Number(line.moneyAccountId || 0),
          currencyCode: String(line.currencyCode || "").trim().toUpperCase(),
          amount: Number(line.amount),
          exchangeRateVesPerUsd:
            line.exchangeRate == null || !Number.isFinite(Number(line.exchangeRate))
              ? null
              : Number(line.exchangeRate),
          notes: line.notes ?? null,
        }));
        if (lines.length === 0) throw new Error("Debes agregar al menos una linea.");
        const payoutTotalUsd = Number(
          lines
            .reduce((sum, line) => {
              const account = paymentAccounts.find(
                (option) => option.accountId === line.moneyAccountId && option.currencyCode === line.currencyCode
              );
              if (!account || !Number.isFinite(line.amount) || line.amount <= 0) {
                throw new Error("Una linea de devolucion tiene cuenta o monto invalido.");
              }
              if (line.currencyCode === "VES" && (!line.exchangeRateVesPerUsd || line.exchangeRateVesPerUsd <= 0)) {
                throw new Error("Debes indicar una tasa valida para cada devolucion en VES.");
              }
              return sum + (line.currencyCode === "VES" ? line.amount / Number(line.exchangeRateVesPerUsd) : line.amount);
            }, 0)
            .toFixed(2)
        );
        if (payoutTotalUsd > Math.max(0, Number(order.clientFundBalanceUsd || 0)) + 0.005) {
          throw new Error("La devolucion no puede superar el fondo disponible del cliente.");
        }
        result = await settleMasterOpsClientFundPayoutAction({
          orderId: order.id,
          lines,
          notes: payload.notes?.trim() || null,
        });
      } else if (action === "close-rounding") {
        result = await closeMasterOpsRoundingBalanceAction({
          orderId: order.id,
          notes: payload.notes?.trim() || null,
        });
      } else if (action === "add-note") {
        const note = String(payload.notes || "").trim();
        if (note.length < 3) throw new Error("La nota debe tener al menos 3 caracteres.");
        result = await addMasterOpsOrderNoteAction({
          orderId: order.id,
          note,
        });
      } else if (action === "cancel-order") {
        const reason = String(payload.reason || "").trim();
        if (!reason) throw new Error("Debes indicar un motivo de cancelacion.");
        const refundLines = (payload.moneyLines ?? []).map((line) => ({
          moneyAccountId: Number(line.moneyAccountId || 0),
          currencyCode: String(line.currencyCode || "").trim().toUpperCase(),
          amount: Number(line.amount),
          exchangeRateVesPerUsd:
            line.exchangeRate == null || !Number.isFinite(Number(line.exchangeRate))
              ? null
              : Number(line.exchangeRate),
          notes: line.notes ?? null,
        }));
        result = await cancelMasterOpsOrderAction({
          orderId: order.id,
          reason,
          paidHandling: payload.paidHandling ?? null,
          refundLines,
        });
      }

      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const message = "message" in result && typeof result.message === "string" ? result.message : "No se pudo procesar la accion.";
        throw new Error(message);
      }

      requestOpsRefresh();
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
        <div className="mx-auto max-w-[1400px] px-3 py-2.5 sm:px-5">
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-base font-semibold leading-none">B. Master 3.0</h1>

                <div className="relative">
                  <button
                    aria-label={`Seleccionar fecha operativa. Fecha actual ${fmtDateKey(focusDate)}`}
                    className="flex min-w-[145px] items-center justify-between gap-3 rounded-2xl border border-[#242433] bg-[#121218] px-3 py-1.5 text-left transition hover:border-[#FEEF00]/50"
                    type="button"
                    onClick={openFocusDatePicker}
                  >
                    <span>
                      <span className="block text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Fecha</span>
                      <span className="mt-0.5 block text-[13px] font-medium leading-none text-[#F5F5F7]">
                        {fmtDateKey(focusDate)}
                      </span>
                    </span>
                    <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-[#B7B7C2]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 2v3m12-3v3M3.75 9h16.5m-15-5h13.5A1.5 1.5 0 0 1 20.25 5.5v14a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-14A1.5 1.5 0 0 1 5.25 4Z" />
                    </svg>
                  </button>
                  <input
                    ref={focusDateInputRef}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-full h-px w-px opacity-0"
                    tabIndex={-1}
                    type="date"
                    value={focusDate}
                    onChange={(event) => navigateToFocusDate(event.target.value)}
                  />
                </div>

                <button
                  className="rounded-2xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-left transition hover:border-[#FEEF00]/50"
                  type="button"
                  onClick={() => {
                    setExchangeRateInput(activeRate ? String(activeRate) : "");
                    setExchangeRateError(null);
                    setRateEditorOpen(true);
                  }}
                  title="Actualizar tasa"
                >
                  <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Tasa</div>
                  <div className="mt-0.5 text-[13px] font-medium leading-none text-[#F5F5F7]">
                    {activeRate ? fmtRateBs(activeRate) : "--"}
                  </div>
                </button>

                <button
                  className="rounded-2xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-left transition hover:border-[#FEEF00]/50 disabled:cursor-wait disabled:opacity-60"
                  type="button"
                  disabled={isRefreshing}
                  onClick={requestOpsRefresh}
                  title="Volver a consultar la operacion en el servidor"
                >
                  <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">
                    {isRefreshing ? "Actualizando" : "Actualizar"}
                  </div>
                  <div className="mt-0.5 text-[11px] font-medium leading-none text-[#F5F5F7]">
                    {isRefreshing ? "Consultando..." : fmtTimeAMPM(snapshotAt)}
                  </div>
                </button>

                <MasterOpsAlerts publicVapidKey={publicVapidKey} onRefresh={requestOpsRefresh} />
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <div className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-2xl border border-[#242433] bg-[#0F0F14] p-1">
                  <TopNavButton label="Operacion" active={inboxMode == null} onClick={closeInbox} />
                  <TopNavButton
                    label="Acciones"
                    active={inboxMode === "actions"}
                    count={inboxCounts.actions}
                    onClick={() => setInboxMode("actions")}
                  />
                  <TopNavButton
                    label="Seguimiento"
                    active={inboxMode === "updates"}
                    count={inboxCounts.updates}
                    onClick={() => setInboxMode("updates")}
                  />
                </div>

                <div className="w-full rounded-2xl border border-[#242433] bg-[#121218] px-3 py-1.5 sm:w-[240px]">
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

      <main className="mx-auto max-w-[1400px] px-3 py-4 sm:px-5">
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
              const query = search.trim();
              setSubmittedOrderSearch(query);
              setIsOrderSearchSubmitted(true);
              setOrderSearchSubmissionVersion((version) => version + 1);
              setRemoteOrderSearchResults([]);
              setRemoteOrderSearchError(null);
            }}
          >
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setIsOrderSearchSubmitted(false);
              }}
              placeholder="N.º corto, cliente, telefono o ubicador"
              aria-label="Buscar por numero corto, cliente, telefono o ubicador"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] py-1.5 pl-3.5 pr-24 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />
            <button
              type="submit"
              className="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-lg border border-[#3A3A4A] bg-[#121218] px-2.5 py-1 text-xs font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/50 hover:text-[#FEEF00]"
              title="Buscar"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <circle cx="11" cy="11" r="6" />
                <path d="m16 16 4 4" />
              </svg>
              Buscar
            </button>
            {isOrderSearchSubmitted ? (
              <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-[#242433] bg-[#0B0B0D] shadow-2xl">
                {shouldSearchOrders ? mergedOrderSearchResults.map((result) => (
                  <button
                    key={`${result.source}-${result.id}`}
                    className="w-full px-4 py-3 text-left hover:bg-[#121218]"
                    type="button"
                    onClick={() => openSearchOrderResult(result)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-sm font-medium text-[#F5F5F7]">{result.label}</div>
                      <span className="shrink-0 rounded-full border border-[#2C3142] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[#8A8A96]">
                        {result.source === "local" ? "Dia" : "Historial"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-[#B7B7C2]">{result.sub}</div>
                  </button>
                )) : null}
                {!shouldSearchOrders ? (
                  <div className="px-4 py-3 text-xs text-[#8A8A96]">
                    Escribe al menos 2 caracteres o un numero corto de orden.
                  </div>
                ) : null}
                {shouldSearchOrders && remoteOrderSearchLoading ? (
                  <div className="border-t border-[#242433] px-4 py-2 text-xs text-[#8A8A96]">
                    Buscando en historial...
                  </div>
                ) : null}
                {shouldSearchOrders && !remoteOrderSearchLoading && !remoteOrderSearchError && mergedOrderSearchResults.length === 0 ? (
                  <div className="border-t border-[#242433] px-4 py-3 text-xs text-[#8A8A96]">
                    No encontramos pedidos por numero corto, cliente, telefono ni ubicador.
                  </div>
                ) : null}
                {shouldSearchOrders && remoteOrderSearchError ? (
                  <div className="border-t border-[#3A1F25] px-4 py-2 text-xs text-[#F0A6AE]">
                    No se pudo consultar el historial. Puedes volver a presionar Buscar para reintentar.
                  </div>
                ) : null}
              </div>
            ) : null}
          </form>

          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/40"
              type="button"
              onClick={() => setCreateOrderOpen(true)}
            >
              Nuevo pedido
            </button>
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

        <div className="mt-4 space-y-2 lg:hidden">
          {tableOrders.length === 0 ? (
            <div className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-8 text-center text-sm text-[#B7B7C2]">
              {emptyOrdersMessage}
            </div>
          ) : (
            tableOrders.map((order) => {
              const focusTab = getOrderFocusTab(order);
              const actionLabel = getNextPrimaryActionLabel(order);

              return (
                <article
                  key={order.id}
                  className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]"
                >
                  <button
                    className="w-full p-3 text-left transition hover:bg-[#171720]"
                    type="button"
                    onClick={() => openOrder(order, focusTab)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-[#F5F5F7]">
                            {orderDisplayNumber(order)}
                          </span>
                          <span className="text-xs text-[#B7B7C2]">
                            {fmtTimeAMPM(order.deliveryAtISO)}
                          </span>
                          <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[10px] text-[#B7B7C2]">
                            {pillLabel(order.fulfillment)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-sm font-medium text-[#F5F5F7]">
                          {order.clientName}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[#8A8A96]">
                          {order.advisorName} · {ORDER_STATUS_LABELS[order.status]}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-[#F5F5F7]">
                          {fmtUSD(order.totalUsd)}
                        </div>
                        <div className={`mt-1 text-xs font-semibold ${paymentToneClass(order.balanceUsd)}`}>
                          Pend. {fmtUSD(order.balanceUsd)}
                        </div>
                      </div>
                    </div>
                    {order.isNewClient ? (
                      <div className="mt-2 inline-flex rounded-full bg-[#FEEF00] px-2 py-0.5 text-[9px] font-semibold leading-none text-[#0B0B0D]">
                        CLIENTE NUEVO
                      </div>
                    ) : null}
                    <div className="mt-3 border-t border-[#242433] pt-3">
                      <RowProcessTimeline order={order} />
                    </div>
                  </button>
                  <div className="flex items-center justify-end border-t border-[#242433] px-3 py-2">
                    <button
                      className={[
                        "rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-1.5 text-xs font-medium transition hover:border-[#FEEF00]/40",
                        focusTab === "pagos"
                          ? "text-orange-200"
                          : focusTab === "entrega"
                            ? "text-sky-200"
                            : "text-[#F5F5F7]",
                      ].join(" ")}
                      type="button"
                      onClick={() => openOrder(order, focusTab)}
                    >
                      {actionLabel}
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <div className="mt-4 hidden overflow-hidden rounded-2xl border border-[#242433] bg-[#121218] lg:block">
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
                      {emptyOrdersMessage}
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
      {inboxMode ? (
        <MasterOpsInboxDrawer
          key={inboxMode}
          kind={inboxMode}
          onClose={closeInbox}
          onOpenOrder={openInboxOrder}
          onCountChange={handleInboxCountChange}
        />
      ) : null}
      {selectedOrder ? (
        <OrderDetailPanel
          key={selectedOrder.id}
          order={selectedOrder}
          activeRate={activeRate}
          roles={roles}
          activeTab={selectedDetailTab}
          detailLoading={
            !selectedOrderDetailReady &&
            (detailLoadingOrderId === selectedOrder.id || !detailError)
          }
          detailError={!selectedOrderDetailReady ? detailError : null}
          actionError={actionError}
          runningAction={runningAction}
          onTabChange={setSelectedDetailTab}
          onRetryDetail={() => setDetailRequestVersion((version) => version + 1)}
          onClose={closeOrderDetail}
          onEditOrder={(order) => setEditingOrderId(order.id)}
          onDirectAction={runDirectOrderAction}
          onCreatePaymentReport={runCreatePaymentReport}
          drivers={drivers}
          deliveryPartners={deliveryPartners}
          paymentAccounts={paymentAccounts}
        />
      ) : null}
      <MasterOpsOrderEditor
        mode="create"
        open={createOrderOpen}
        focusDate={focusDate}
        roles={roles}
        fallbackActiveRate={activeRate}
        onClose={() => setCreateOrderOpen(false)}
        onSaved={() => {
          setCreateOrderOpen(false);
          requestOpsRefresh();
        }}
      />
      <MasterOpsOrderEditor
        mode="edit"
        orderId={editingOrderId}
        roles={roles}
        fallbackActiveRate={activeRate}
        onClose={() => setEditingOrderId(null)}
        onSaved={() => {
          setEditingOrderId(null);
          requestOpsRefresh();
        }}
      />
      {rateEditorOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4">
          <form
            className="w-full max-w-sm rounded-2xl border border-[#242433] bg-[#121218] p-4 text-[#F5F5F7] shadow-2xl"
            onSubmit={saveExchangeRate}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Actualizar tasa</div>
                <div className="mt-1 text-xs text-[#8A8A96]">VES por USD. Actualiza catalogo y ordenes nuevas.</div>
              </div>
              <button
                className="rounded-xl border border-[#242433] px-3 py-2 text-sm text-[#F5F5F7]"
                type="button"
                onClick={() => setRateEditorOpen(false)}
                disabled={exchangeRateSaving}
              >
                Cerrar
              </button>
            </div>

            <label className="mt-4 block text-[11px] text-[#B7B7C2]">
              <span className="mb-1 block">Nueva tasa</span>
              <input
                className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#6F6F7C] focus:border-[#FEEF00]/60 focus:outline-none"
                value={exchangeRateInput}
                onChange={(event) => setExchangeRateInput(event.target.value)}
                inputMode="decimal"
                placeholder={activeRate ? String(activeRate) : "Ej. 737.23"}
                autoFocus
              />
            </label>

            {exchangeRateError ? <div className="mt-3 text-sm text-red-300">{exchangeRateError}</div> : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-xl border border-[#242433] px-4 py-2 text-sm font-semibold text-[#F5F5F7]"
                type="button"
                onClick={() => setRateEditorOpen(false)}
                disabled={exchangeRateSaving}
              >
                Cancelar
              </button>
              <button
                className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-5 py-2 text-sm font-semibold text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
                type="submit"
                disabled={exchangeRateSaving}
              >
                {exchangeRateSaving ? "Guardando..." : "Guardar tasa"}
              </button>
            </div>
          </form>
        </div>
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
