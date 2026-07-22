"use server";

import { revalidatePath } from "next/cache";
import {
  canManageOrderDeliveryAssignment,
  needsInitialOrderApproval,
  needsOrderReapproval,
} from "@/lib/domain/order-domain";
import { requireMasterOrAdminContext } from "@/lib/auth";
import { normalizeRemoteSearchValue } from "@/lib/search/normalize-search";
import {
  markMasterInboxItemsReviewedAction,
  reopenMasterInboxItemsAction,
} from "../dashboard/actions";

export type MasterOpsInboxKind = "actions" | "updates";
export type MasterOpsInboxStatus = "reviewed" | "resolved" | null;
export type MasterOpsInboxCategory = "approval" | "payments" | "changes" | "kitchen" | "delivery";
export type MasterOpsInboxTab = "detalle" | "entrega" | "pagos" | "eventos" | "notas" | "ajustes";

export type MasterOpsInboxItem = {
  id: string;
  kind: MasterOpsInboxKind;
  orderId: number;
  operationalDate: string;
  clientName: string;
  advisorName: string;
  deliveryLabel: string;
  title: string;
  message: string | null;
  badge: string;
  severity: "info" | "warning" | "critical";
  category: MasterOpsInboxCategory;
  openTab: MasterOpsInboxTab;
  createdAt: string;
  detailLines: string[];
  isUrgent: boolean;
  status: MasterOpsInboxStatus;
};

export type MasterOpsInboxPayload = {
  items: MasterOpsInboxItem[];
  openCount: number;
};

export type MasterOpsInboxStateItemInput = {
  itemId: string;
  itemType: "event";
  orderId: number;
};

type InboxRelation = Record<string, unknown> | Record<string, unknown>[] | null;

type InboxOrderRow = {
  id: number | string;
  status: string;
  fulfillment: "pickup" | "delivery";
  queued_needs_reapproval: boolean | null;
  internal_driver_user_id: string | null;
  external_driver_name: string | null;
  external_partner_id: number | string | null;
  extra_fields: Record<string, unknown> | null;
  created_at: string;
  client: InboxRelation;
  advisor: InboxRelation;
};

type InboxTimelineRow = {
  id: number | string;
  order_id: number | string;
  event_type: string | null;
  event_group: string | null;
  title: string | null;
  message: string | null;
  severity: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type InboxRecipientRow = {
  event_id: number | string;
  target_role: string | null;
  target_user_id: string | null;
  requires_action: boolean | null;
  read_at: string | null;
};

type InboxNotificationRow = {
  id: number | string;
  order_id: number | string | null;
  type: string | null;
  title: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  created_at: string | null;
  read_at: string | null;
};

type InboxStateRow = {
  item_id: string;
  status: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function relation(value: InboxRelation) {
  if (Array.isArray(value)) return value[0] ?? {};
  return value ?? {};
}

function text(value: unknown, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function validId(value: unknown) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function getOperationalDate(order: InboxOrderRow) {
  const schedule = record(record(order.extra_fields).schedule);
  const scheduledDate = text(schedule.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) return scheduledDate;

  const createdAt = new Date(order.created_at);
  if (Number.isNaN(createdAt.getTime())) return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  return createdAt.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function getDeliveryLabel(order: InboxOrderRow) {
  const schedule = record(record(order.extra_fields).schedule);
  const date = getOperationalDate(order);
  if (Boolean(schedule.asap)) return `${date} · ASAP`;
  const time = text(schedule.time_12, text(schedule.time_24));
  return time ? `${date} · ${time}` : date;
}

function getOrderDisplay(order: InboxOrderRow) {
  const client = relation(order.client);
  const advisor = relation(order.advisor);
  return {
    clientName: text(client.full_name, "Sin cliente"),
    advisorName: text(advisor.full_name, "Sin asesor"),
    operationalDate: getOperationalDate(order),
    deliveryLabel: getDeliveryLabel(order),
    isAsap: Boolean(record(record(order.extra_fields).schedule).asap),
  };
}

function getEventDetailLines(payloadInput: unknown) {
  const payload = record(payloadInput);
  const lines: string[] = [];
  const reason = text(payload.reason, text(payload.review_notes, text(payload.rejection_reason)));
  const notes = text(payload.notes);
  const etaMinutes = Number(payload.eta_minutes);
  const changedFields = Array.isArray(payload.changed_fields)
    ? payload.changed_fields.map((value) => text(value)).filter(Boolean)
    : [];

  if (reason) lines.push(`Motivo: ${reason}`);
  if (notes && notes !== reason) lines.push(notes);
  if (Number.isFinite(etaMinutes) && etaMinutes > 0) lines.push(`ETA: ${etaMinutes} min`);
  if (changedFields.length > 0) lines.push(`Cambios: ${changedFields.slice(0, 4).join(", ")}`);
  return lines.slice(0, 4);
}

function getInboxCategory(input: { eventGroup?: unknown; title?: unknown; message?: unknown; details?: string[] }) {
  const group = normalizeRemoteSearchValue(text(input.eventGroup));
  const content = normalizeRemoteSearchValue(
    [input.title, input.message, ...(input.details ?? [])].map((value) => text(value)).join(" ")
  );

  if (group.includes("payment") || content.includes("pago") || content.includes("retencion")) return "payments" as const;
  if (group.includes("delivery") || /driver|motorizado|partner|entregad|retirad|en camino/.test(content)) return "delivery" as const;
  if (group.includes("kitchen") || /cocina|preparad|cola|eta/.test(content)) return "kitchen" as const;
  if (group.includes("change") || /modific|re-aprob|reaprob|devol|cambio|revision/.test(content)) return "changes" as const;
  return "approval" as const;
}

function tabForCategory(category: MasterOpsInboxCategory): MasterOpsInboxTab {
  if (category === "payments") return "pagos";
  if (category === "delivery") return "entrega";
  if (category === "changes" || category === "kitchen") return "eventos";
  return "detalle";
}

function severity(value: unknown, fallback: "info" | "warning" | "critical" = "info") {
  const normalized = text(value).toLowerCase();
  if (normalized === "critical") return "critical" as const;
  if (normalized === "warning") return "warning" as const;
  return fallback;
}

function makeActionItem(input: {
  id: string;
  order: InboxOrderRow;
  title: string;
  message: string;
  badge: string;
  category: MasterOpsInboxCategory;
  createdAt?: string | null;
  detailLines?: string[];
  severity?: "warning" | "critical";
}): MasterOpsInboxItem {
  const display = getOrderDisplay(input.order);
  return {
    id: input.id,
    kind: "actions",
    orderId: Number(input.order.id),
    operationalDate: display.operationalDate,
    clientName: display.clientName,
    advisorName: display.advisorName,
    deliveryLabel: display.deliveryLabel,
    title: input.title,
    message: input.message,
    badge: input.badge,
    severity: input.severity ?? "warning",
    category: input.category,
    openTab: tabForCategory(input.category),
    createdAt: input.createdAt || input.order.created_at,
    detailLines: input.detailLines ?? [],
    isUrgent: display.isAsap || input.severity === "critical",
    status: null,
  };
}

async function loadActionItems(limit: number): Promise<MasterOpsInboxPayload> {
  const { supabase } = await requireMasterOrAdminContext();
  const orderSelect = `
    id,
    status,
    fulfillment,
    queued_needs_reapproval,
    internal_driver_user_id,
    external_driver_name,
    external_partner_id,
    extra_fields,
    created_at,
    client:clients!orders_client_id_fkey (
      full_name
    ),
    advisor:profiles!orders_attributed_advisor_id_fkey (
      full_name
    )
  `;
  const activeStatuses = ["created", "queued", "confirmed", "in_kitchen", "ready", "out_for_delivery"];
  const [activeOrdersResult, pendingPaymentsResult, fundRequestsResult] = await Promise.all([
    supabase
      .from("orders")
      .select(orderSelect)
      .in("status", activeStatuses)
      .order("created_at", { ascending: false })
      .limit(Math.min(180, Math.max(80, limit * 4))),
    supabase
      .from("payment_reports")
      .select("order_id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(40, limit * 2))),
    supabase
      .from("order_timeline_events")
      .select("id, order_id, payload, created_at")
      .eq("event_type", "client_fund_application_requested")
      .order("created_at", { ascending: false })
      .limit(Math.min(60, Math.max(20, limit))),
  ]);

  const queryError = activeOrdersResult.error ?? pendingPaymentsResult.error ?? fundRequestsResult.error;
  if (queryError) throw new Error(queryError.message);

  const ordersById = new Map<number, InboxOrderRow>();
  for (const row of (activeOrdersResult.data ?? []) as InboxOrderRow[]) {
    const orderId = validId(row.id);
    if (orderId) ordersById.set(orderId, row);
  }

  const pendingPaymentCreatedAtByOrder = new Map<number, string>();
  for (const row of pendingPaymentsResult.data ?? []) {
    const orderId = validId(row.order_id);
    if (orderId && !pendingPaymentCreatedAtByOrder.has(orderId)) {
      pendingPaymentCreatedAtByOrder.set(orderId, text(row.created_at));
    }
  }

  const latestFundRequestByOrder = new Map<number, { id: string; payload: unknown; createdAt: string }>();
  for (const row of fundRequestsResult.data ?? []) {
    const orderId = validId(row.order_id);
    if (orderId && !latestFundRequestByOrder.has(orderId)) {
      latestFundRequestByOrder.set(orderId, {
        id: text(row.id),
        payload: row.payload,
        createdAt: text(row.created_at),
      });
    }
  }

  const supplementalOrderIds = Array.from(
    new Set([...pendingPaymentCreatedAtByOrder.keys(), ...latestFundRequestByOrder.keys()])
  ).filter((orderId) => !ordersById.has(orderId));

  if (supplementalOrderIds.length > 0) {
    const { data, error } = await supabase
      .from("orders")
      .select(orderSelect)
      .in("id", supplementalOrderIds.slice(0, 80));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as InboxOrderRow[]) {
      const orderId = validId(row.id);
      if (orderId) ordersById.set(orderId, row);
    }
  }

  const fundOrderIds = Array.from(latestFundRequestByOrder.keys()).filter((orderId) => ordersById.has(orderId));
  const fundPendingByOrder = new Map<number, number>();
  if (fundOrderIds.length > 0) {
    const rpcClient = supabase as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await rpcClient.rpc("get_orders_financial_state", {
      p_order_ids: fundOrderIds,
      p_operation_date: null,
      p_active_bs_rate: null,
    });
    if (error) throw new Error(error.message);
    for (const row of Array.isArray(data) ? data : []) {
      const state = record(row);
      const orderId = validId(state.order_id);
      if (orderId) fundPendingByOrder.set(orderId, Number(state.pending_usd || 0));
    }
  }

  const items: MasterOpsInboxItem[] = [];
  for (const [orderId, order] of ordersById) {
    const extraFields = record(order.extra_fields);
    const review = record(extraFields.review);
    const payment = record(extraFields.payment);
    const processInput = {
      status: order.status,
      queuedNeedsReapproval: Boolean(order.queued_needs_reapproval),
      returnedToAdvisor: Boolean(review.returned_to_advisor),
    };

    if (needsInitialOrderApproval(processInput)) {
      items.push(makeActionItem({
        id: `n-ap-${orderId}`,
        order,
        title: "Orden por aprobar",
        message: "La orden está pendiente de aprobación del máster.",
        badge: "Aprobar",
        category: "approval",
      }));
    }

    if (needsOrderReapproval(processInput)) {
      items.push(makeActionItem({
        id: `n-re-${orderId}`,
        order,
        title: "Orden por re-aprobar",
        message: "La orden fue modificada y requiere una nueva revisión.",
        badge: "Re-aprobar",
        category: "changes",
      }));
    }

    const pendingPaymentCreatedAt = pendingPaymentCreatedAtByOrder.get(orderId);
    if (pendingPaymentCreatedAt) {
      items.push(makeActionItem({
        id: `n-pay-${orderId}`,
        order,
        title: "Pago por confirmar",
        message: "Hay un reporte de pago pendiente de revisión.",
        badge: "Confirmar pago",
        category: "payments",
        createdAt: pendingPaymentCreatedAt,
      }));
    }

    if (
      canManageOrderDeliveryAssignment({ status: order.status, fulfillment: order.fulfillment }) &&
      !order.internal_driver_user_id &&
      !text(order.external_driver_name) &&
      !validId(order.external_partner_id)
    ) {
      items.push(makeActionItem({
        id: `n-driver-${orderId}`,
        order,
        title: "Delivery sin asignar",
        message: "La orden necesita un driver interno o un partner externo.",
        badge: "Asignar delivery",
        category: "delivery",
      }));
    }

    const fundRequest = latestFundRequestByOrder.get(orderId);
    const fundUsedUsd = Number(payment.client_fund_used_usd || 0);
    if (fundRequest && (fundPendingByOrder.get(orderId) ?? 0) > 0.005 && fundUsedUsd <= 0.005) {
      items.push(makeActionItem({
        id: `n-fund-${orderId}-${fundRequest.id}`,
        order,
        title: "Aplicar fondo del cliente",
        message: "El asesor solicitó usar fondo del cliente para pagar esta orden.",
        badge: "Aplicar fondo",
        category: "payments",
        createdAt: fundRequest.createdAt,
        detailLines: getEventDetailLines(fundRequest.payload),
      }));
    }
  }

  const priority: Record<MasterOpsInboxCategory, number> = {
    changes: 1,
    payments: 2,
    approval: 3,
    delivery: 4,
    kitchen: 5,
  };
  const sorted = items
    .sort((a, b) => priority[a.category] - priority[b.category] || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  return { items: sorted, openCount: items.length };
}

async function loadUpdateItems(limit: number): Promise<MasterOpsInboxPayload> {
  const { supabase, user, roles } = await requireMasterOrAdminContext();
  const eventLimit = Math.min(160, Math.max(80, limit * 4));
  const [eventsResult, notificationsResult] = await Promise.all([
    supabase
      .from("order_timeline_events")
      .select("id, order_id, event_type, event_group, title, message, severity, actor_user_id, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(eventLimit),
    supabase
      .from("notifications")
      .select("id, order_id, type, title, body, meta, created_at, read_at")
      .eq("recipient_user_id", user.id)
      .not("order_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(50, limit * 2))),
  ]);

  const queryError = eventsResult.error ?? notificationsResult.error;
  if (queryError) throw new Error(queryError.message);

  const events = (eventsResult.data ?? []) as InboxTimelineRow[];
  const notifications = (notificationsResult.data ?? []) as InboxNotificationRow[];
  const eventIds = events.map((event) => validId(event.id)).filter((id): id is number => id != null);
  const { data: recipientData, error: recipientError } = eventIds.length > 0
    ? await supabase
        .from("order_timeline_event_recipients")
        .select("event_id, target_role, target_user_id, requires_action, read_at")
        .in("event_id", eventIds)
    : { data: [] as InboxRecipientRow[], error: null };
  if (recipientError) throw new Error(recipientError.message);

  const recipientsByEvent = new Map<number, InboxRecipientRow[]>();
  for (const recipient of (recipientData ?? []) as InboxRecipientRow[]) {
    const eventId = validId(recipient.event_id);
    if (!eventId) continue;
    const bucket = recipientsByEvent.get(eventId) ?? [];
    bucket.push(recipient);
    recipientsByEvent.set(eventId, bucket);
  }

  const visibleEvents = events.filter((event) => {
    const eventId = validId(event.id);
    if (!eventId || event.actor_user_id === user.id) return false;
    const recipients = recipientsByEvent.get(eventId) ?? [];
    const matchingRecipient = recipients.find((recipient) => {
      if (recipient.target_user_id === user.id) return true;
      const targetRole = text(recipient.target_role);
      return targetRole === "master" || targetRole === "admin" || roles.some((role) => role === targetRole);
    });
    if (recipients.length > 0 && !matchingRecipient) return false;
    const group = text(event.event_group).toLowerCase();
    return Boolean(matchingRecipient?.requires_action) || group === "approval" || group === "payment";
  });

  const orderIds = Array.from(new Set([
    ...visibleEvents.map((event) => validId(event.order_id)),
    ...notifications.map((notification) => validId(notification.order_id)),
  ].filter((id): id is number => id != null)));
  const orderSelect = `
    id,
    status,
    fulfillment,
    queued_needs_reapproval,
    internal_driver_user_id,
    external_driver_name,
    external_partner_id,
    extra_fields,
    created_at,
    client:clients!orders_client_id_fkey (
      full_name
    ),
    advisor:profiles!orders_attributed_advisor_id_fkey (
      full_name
    )
  `;
  const { data: orderData, error: orderError } = orderIds.length > 0
    ? await supabase.from("orders").select(orderSelect).in("id", orderIds.slice(0, 180))
    : { data: [] as InboxOrderRow[], error: null };
  if (orderError) throw new Error(orderError.message);

  const ordersById = new Map<number, InboxOrderRow>();
  for (const row of (orderData ?? []) as InboxOrderRow[]) {
    const orderId = validId(row.id);
    if (orderId) ordersById.set(orderId, row);
  }

  const itemIds = [
    ...visibleEvents.map((event) => `timeline-${text(event.id)}`),
    ...notifications.map((notification) => `notification-${text(notification.id)}`),
  ];
  const { data: stateData, error: stateError } = itemIds.length > 0
    ? await supabase
        .from("master_inbox_item_states")
        .select("item_id, status")
        .in("item_id", itemIds.slice(0, 260))
    : { data: [] as InboxStateRow[], error: null };
  if (stateError) throw new Error(stateError.message);

  const statusById = new Map<string, Exclude<MasterOpsInboxStatus, null>>();
  for (const state of (stateData ?? []) as InboxStateRow[]) {
    if (state.status === "reviewed" || state.status === "resolved") {
      statusById.set(text(state.item_id), state.status);
    }
  }

  const items: MasterOpsInboxItem[] = [];
  for (const event of visibleEvents) {
    const eventId = validId(event.id);
    const orderId = validId(event.order_id);
    const order = orderId ? ordersById.get(orderId) : null;
    if (!eventId || !orderId || !order) continue;
    const recipients = recipientsByEvent.get(eventId) ?? [];
    const matchingRecipient = recipients.find((recipient) => {
      if (recipient.target_user_id === user.id) return true;
      const targetRole = text(recipient.target_role);
      return targetRole === "master" || targetRole === "admin" || roles.some((role) => role === targetRole);
    });
    const detailLines = getEventDetailLines(event.payload);
    const category = getInboxCategory({
      eventGroup: event.event_group,
      title: event.title,
      message: event.message,
      details: detailLines,
    });
    const display = getOrderDisplay(order);
    const itemId = `timeline-${eventId}`;
    const itemSeverity = severity(event.severity, matchingRecipient?.requires_action ? "warning" : "info");
    const itemStatus = statusById.get(itemId) ?? null;
    items.push({
      id: itemId,
      kind: "updates",
      orderId,
      operationalDate: display.operationalDate,
      clientName: display.clientName,
      advisorName: display.advisorName,
      deliveryLabel: display.deliveryLabel,
      title: text(event.title, "Actualización de orden"),
      message: text(event.message) || null,
      badge: category === "payments" ? "Pago" : category === "changes" ? "Cambio" : "Actualización",
      severity: itemSeverity,
      category,
      openTab: tabForCategory(category),
      createdAt: event.created_at,
      detailLines,
      isUrgent: itemStatus == null && !matchingRecipient?.read_at && (display.isAsap || itemSeverity === "critical"),
      status: itemStatus,
    });
  }

  for (const notification of notifications) {
    const notificationId = validId(notification.id);
    const orderId = validId(notification.order_id);
    const order = orderId ? ordersById.get(orderId) : null;
    if (!notificationId || !orderId || !order) continue;
    const detailLines = getEventDetailLines(notification.meta);
    const category = getInboxCategory({
      eventGroup: notification.type,
      title: notification.title,
      message: notification.body,
      details: detailLines,
    });
    const display = getOrderDisplay(order);
    const itemId = `notification-${notificationId}`;
    const notificationTitle = text(notification.title, "Notificación de orden");
    const itemSeverity = /rechazad|critica|devuelt/.test(normalizeRemoteSearchValue(notificationTitle))
      ? "critical" as const
      : /requiere|pendiente|atencion/.test(normalizeRemoteSearchValue(notificationTitle))
        ? "warning" as const
        : "info" as const;
    const itemStatus = statusById.get(itemId) ?? null;
    items.push({
      id: itemId,
      kind: "updates",
      orderId,
      operationalDate: display.operationalDate,
      clientName: display.clientName,
      advisorName: display.advisorName,
      deliveryLabel: display.deliveryLabel,
      title: notificationTitle,
      message: text(notification.body) || null,
      badge: category === "payments" ? "Pago" : category === "changes" ? "Cambio" : "Actualización",
      severity: itemSeverity,
      category,
      openTab: tabForCategory(category),
      createdAt: text(notification.created_at, order.created_at),
      detailLines,
      isUrgent: itemStatus == null && !notification.read_at && (display.isAsap || itemSeverity === "critical"),
      status: itemStatus,
    });
  }

  const attentionItems: MasterOpsInboxItem[] = [];
  const latestInfoByOrder = new Map<number, MasterOpsInboxItem>();
  for (const item of items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (item.severity !== "info" || item.isUrgent) {
      attentionItems.push(item);
      continue;
    }
    if (!latestInfoByOrder.has(item.orderId)) latestInfoByOrder.set(item.orderId, item);
  }

  const result = [...attentionItems, ...latestInfoByOrder.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  return {
    items: result,
    openCount: result.filter((item) => item.status == null).length,
  };
}

export async function loadMasterOpsInboxAction(input: {
  kind: MasterOpsInboxKind;
  limit?: number;
}): Promise<MasterOpsInboxPayload> {
  const kind = input.kind === "updates" ? "updates" : "actions";
  const limit = Math.max(1, Math.min(60, Math.floor(Number(input.limit ?? 30) || 30)));
  return kind === "actions" ? loadActionItems(limit) : loadUpdateItems(limit);
}

export async function markMasterOpsInboxItemsReviewedAction(input: {
  items: MasterOpsInboxStateItemInput[];
}) {
  await markMasterInboxItemsReviewedAction({ items: input.items });
  revalidatePath("/app/master/ops");
}

export async function reopenMasterOpsInboxItemsAction(input: { itemIds: string[] }) {
  await reopenMasterInboxItemsAction(input);
  revalidatePath("/app/master/ops");
}
