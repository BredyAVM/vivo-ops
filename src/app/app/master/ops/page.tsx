import { unstable_noStore as noStore } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from "@/lib/auth";
import {
  formatOrderDisplayNumber,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/orders/order-labels";
import MasterOpsClient, { type MasterOpsOrder } from "./MasterOpsClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  focusDate?: string;
}>;

type RawOrderRow = {
  id: number;
  order_number: string | null;
  status: OrderStatus;
  fulfillment: FulfillmentType;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  created_at: string;
  extra_fields: any;
  queued_needs_reapproval: boolean | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
  advisor: { full_name: string | null }[] | { full_name: string | null } | null;
  creator: { full_name: string | null }[] | { full_name: string | null } | null;
};

type PendingPaymentRow = {
  order_id: number | string | null;
};

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getCaracasTodayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Caracas",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function isDateKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function normalizeFocusDate(value: string | null | undefined) {
  return isDateKey(value) ? String(value) : getCaracasTodayKey();
}

function getCaracasDayRange(dayKey: string) {
  const startDate = new Date(`${dayKey}T00:00:00-04:00`);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);

  return {
    startISO: startDate.toISOString(),
    endISO: endDate.toISOString(),
  };
}

function addDaysKey(dayKey: string, days: number) {
  const date = new Date(`${dayKey}T12:00:00-04:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function one<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function cleanText(value: string | null | undefined, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function getScheduleDate(extraFields: any): string | null {
  const value = String(extraFields?.schedule?.date ?? "").trim();
  return isDateKey(value) ? value : null;
}

function getOperationalDate(row: RawOrderRow) {
  return getScheduleDate(row.extra_fields) ?? row.created_at.slice(0, 10);
}

function getScheduleLabel(row: RawOrderRow) {
  const schedule = row.extra_fields?.schedule ?? {};
  const date = getScheduleDate(row.extra_fields);
  const isAsap = Boolean(schedule.asap);
  const time = String(schedule.time ?? "").trim();

  if (isAsap) return date ? `${date} - Lo antes posible` : "Lo antes posible";
  if (date && time) return `${date} - ${time}`;
  if (date) return date;
  return "Sin agenda";
}

function mapOrder(row: RawOrderRow, pendingPaymentIds: Set<number>): MasterOpsOrder {
  const client = one(row.client);
  const advisor = one(row.advisor);
  const creator = one(row.creator);
  const source = String(row.extra_fields?.source ?? "").trim();
  const advisorName = cleanText(advisor?.full_name ?? creator?.full_name, source || "Sin asesor");
  const operationalDate = getOperationalDate(row);
  const hasPendingPayment = pendingPaymentIds.has(Number(row.id));
  const queuedNeedsReapproval = Boolean(row.queued_needs_reapproval);
  const status = row.status;
  const isAttentionOrder = status === "created" || queuedNeedsReapproval || hasPendingPayment;

  return {
    id: Number(row.id),
    orderNumber: formatOrderDisplayNumber(row.id),
    status,
    fulfillment: row.fulfillment,
    clientName: cleanText(client?.full_name, "Cliente sin nombre"),
    advisorName,
    totalUsd: toNumber(row.extra_fields?.pricing?.total_usd, toNumber(row.total_usd, 0)),
    totalBs: row.extra_fields?.pricing?.total_bs != null
      ? toNumber(row.extra_fields.pricing.total_bs, 0)
      : row.total_bs_snapshot == null
        ? null
        : toNumber(row.total_bs_snapshot, 0),
    createdAt: row.created_at,
    operationalDate,
    scheduleLabel: getScheduleLabel(row),
    paymentMethod: String(row.extra_fields?.payment?.method ?? "pending"),
    queuedNeedsReapproval,
    hasPendingPayment,
    isAttentionOrder,
  };
}

function buildStats(orders: MasterOpsOrder[]) {
  return orders.reduce(
    (stats, order) => {
      stats.total += 1;
      if (order.isAttentionOrder || order.hasPendingPayment) stats.actions += 1;
      if (order.status === "created") stats.created += 1;
      if (order.status === "queued") stats.queued += 1;
      if (order.status === "confirmed" || order.status === "in_kitchen") stats.kitchen += 1;
      if (order.status === "ready") stats.ready += 1;
      if (order.status === "out_for_delivery") stats.delivery += 1;
      if (order.hasPendingPayment) stats.pendingPayments += 1;
      return stats;
    },
    {
      total: 0,
      actions: 0,
      created: 0,
      queued: 0,
      kitchen: 0,
      ready: 0,
      delivery: 0,
      pendingPayments: 0,
    }
  );
}

function sortOrders(a: MasterOpsOrder, b: MasterOpsOrder) {
  const actionDiff = Number(b.isAttentionOrder) - Number(a.isAttentionOrder);
  if (actionDiff !== 0) return actionDiff;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export default async function MasterOpsPage({ searchParams }: { searchParams?: SearchParams }) {
  noStore();

  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!isMasterOrAdminRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const params = (await searchParams) ?? {};
  const focusDate = normalizeFocusDate(params.focusDate);
  const dayRange = getCaracasDayRange(focusDate);
  const orderSelect = `
    id,
    order_number,
    status,
    fulfillment,
    total_usd,
    total_bs_snapshot,
    created_at,
    extra_fields,
    queued_needs_reapproval,
    client:clients!orders_client_id_fkey (
      full_name,
      phone
    ),
    advisor:profiles!orders_attributed_advisor_id_fkey (
      full_name
    ),
    creator:profiles!orders_created_by_user_id_fkey (
      full_name
    )
  `;

  const [
    profileResult,
    activeRateResult,
    scheduledOrdersResult,
    createdOrdersResult,
    attentionOrdersResult,
    pendingPaymentsResult,
  ] = await Promise.all([
    ctx.supabase.from("profiles").select("full_name").eq("id", ctx.user.id).maybeSingle(),
    ctx.supabase
      .from("exchange_rates")
      .select("rate_bs_per_usd")
      .eq("is_active", true)
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .eq("extra_fields->schedule->>date", focusDate)
      .order("created_at", { ascending: false })
      .limit(180),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .gte("created_at", dayRange.startISO)
      .lt("created_at", dayRange.endISO)
      .order("created_at", { ascending: false })
      .limit(180),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .or("status.eq.created,queued_needs_reapproval.eq.true")
      .order("created_at", { ascending: false })
      .limit(120),
    ctx.supabase
      .from("payment_reports")
      .select("order_id")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(150),
  ]);

  const firstError =
    profileResult.error ??
    activeRateResult.error ??
    scheduledOrdersResult.error ??
    createdOrdersResult.error ??
    attentionOrdersResult.error ??
    pendingPaymentsResult.error;

  if (firstError) {
    throw new Error(firstError.message);
  }

  const pendingPaymentRows = (pendingPaymentsResult.data ?? []) as PendingPaymentRow[];
  const pendingOrderIds = Array.from(
    new Set(
      pendingPaymentRows
        .map((row) => Number(row.order_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const pendingPaymentOrdersResult =
    pendingOrderIds.length > 0
      ? await ctx.supabase
          .from("orders")
          .select(orderSelect)
          .in("id", pendingOrderIds)
          .order("created_at", { ascending: false })
          .limit(150)
      : { data: [], error: null };

  if (pendingPaymentOrdersResult.error) {
    throw new Error(pendingPaymentOrdersResult.error.message);
  }

  const pendingPaymentIdSet = new Set(pendingOrderIds);
  const rowById = new Map<number, RawOrderRow>();
  const addRows = (rows: unknown[] | null | undefined) => {
    for (const row of (rows ?? []) as RawOrderRow[]) {
      rowById.set(Number(row.id), row);
    }
  };

  addRows(scheduledOrdersResult.data);
  addRows(
    ((createdOrdersResult.data ?? []) as RawOrderRow[]).filter((row) => !getScheduleDate(row.extra_fields))
  );
  addRows(attentionOrdersResult.data);
  addRows(pendingPaymentOrdersResult.data);

  const orders = Array.from(rowById.values()).map((row) => mapOrder(row, pendingPaymentIdSet)).sort(sortOrders);
  const stats = buildStats(orders);
  const profile = profileResult.data as { full_name: string | null } | null;

  return (
    <MasterOpsClient
      activeRate={toNumber(activeRateResult.data?.rate_bs_per_usd, 0) || null}
      currentUserName={cleanText(profile?.full_name ?? ctx.user.email, "Usuario")}
      focusDate={focusDate}
      generatedAt={new Intl.DateTimeFormat("es-VE", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Caracas",
      }).format(new Date())}
      nextDate={addDaysKey(focusDate, 1)}
      orders={orders}
      previousDate={addDaysKey(focusDate, -1)}
      roles={ctx.roles}
      stats={stats}
    />
  );
}
