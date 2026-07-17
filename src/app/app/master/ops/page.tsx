import { unstable_noStore as noStore } from "next/cache";
import { redirect } from "next/navigation";
import {
  canManageOrderDeliveryAssignment,
  isRecognizedBillingOrder,
  isScheduledClosingOrder,
  needsInitialOrderApproval,
  type FulfillmentType,
  type OrderStatus,
} from "@/lib/domain/order-domain";
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from "@/lib/auth";
import MasterOpsClient, {
  type MasterOpsOrder,
  type MasterOpsStats,
  type OperationStatsSummary,
  type PaymentVerify,
} from "./MasterOpsClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CLIENT_IMPORT_CUTOFF_ISO = "2026-06-02T00:00:00-04:00";
const CLIENT_IMPORT_CUTOFF_MS = Date.parse(CLIENT_IMPORT_CUTOFF_ISO);

type SearchParams = Promise<{
  focusDate?: string;
}>;

type RawOrderRow = {
  id: number;
  client_id: number | string | null;
  attributed_advisor_id: string | null;
  source: "advisor" | "master" | "walk_in";
  status: OrderStatus;
  fulfillment: FulfillmentType;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  created_at: string;
  sent_to_kitchen_at: string | null;
  kitchen_started_at: string | null;
  ready_at: string | null;
  extra_fields: any;
  queued_needs_reapproval: boolean | null;
  internal_driver_user_id: string | null;
  external_driver_name: string | null;
  external_partner_id: number | string | null;
  client:
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        created_at: string | null;
        client_type: string | null;
      }[]
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        created_at: string | null;
        client_type: string | null;
      }
    | null;
  advisor: { full_name: string | null }[] | { full_name: string | null } | null;
  creator: { full_name: string | null }[] | { full_name: string | null } | null;
};

type RawFinancialStateRow = {
  order_id: number | string;
  total_usd: number | string | null;
  total_bs: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
  pending_reports_count: number | string | null;
  confirmed_reports_count: number | string | null;
  rejected_reports_count: number | string | null;
};

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: unknown, fallback = 0) {
  const n = toNumber(value, fallback);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function one<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function cleanText(value: string | null | undefined, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function getCaracasTodayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function isDateKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function normalizeFocusDate(value: string | null | undefined) {
  return isDateKey(value) ? String(value) : getCaracasTodayKey();
}

function toCaracasDateKey(value: Date) {
  return value.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addDaysKey(dayKey: string, days: number) {
  return toCaracasDateKey(addDays(new Date(`${dayKey}T12:00:00-04:00`), days));
}

function getCaracasDayRange(dayKey: string) {
  const start = new Date(`${dayKey}T00:00:00-04:00`);
  const end = addDays(start, 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function getCaracasWeekRange(dayKey: string) {
  const noon = new Date(`${dayKey}T12:00:00-04:00`);
  const weekday = noon.getDay();
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addDays(noon, -daysFromMonday);
  const nextMonday = addDays(monday, 7);
  const startKey = toCaracasDateKey(monday);
  const endExclusiveKey = toCaracasDateKey(nextMonday);
  return {
    startKey,
    endExclusiveKey,
    startISO: new Date(`${startKey}T00:00:00-04:00`).toISOString(),
    endISO: new Date(`${endExclusiveKey}T00:00:00-04:00`).toISOString(),
  };
}

function getWeekLabel(dayKey: string) {
  const range = getCaracasWeekRange(dayKey);
  const start = new Date(`${range.startKey}T12:00:00-04:00`);
  const end = addDays(new Date(`${range.endExclusiveKey}T12:00:00-04:00`), -1);
  const dd1 = String(start.getDate()).padStart(2, "0");
  const mm1 = String(start.getMonth() + 1).padStart(2, "0");
  const dd2 = String(end.getDate()).padStart(2, "0");
  const mm2 = String(end.getMonth() + 1).padStart(2, "0");
  return `Lun ${dd1}/${mm1} - Dom ${dd2}/${mm2}`;
}

function getScheduleDate(extraFields: any): string | null {
  const value = String(extraFields?.schedule?.date ?? "").trim();
  return isDateKey(value) ? value : null;
}

function buildDeliveryISO(extraFields: any, fallbackISO: string) {
  const schedule = extraFields?.schedule;
  const date = schedule?.date;
  const time24 = schedule?.time_24;

  if (typeof date === "string" && typeof time24 === "string") {
    const candidate = new Date(`${date}T${time24}:00-04:00`);
    if (!Number.isNaN(candidate.getTime())) return candidate.toISOString();
  }

  return fallbackISO;
}

function mergeRows(...groups: Array<RawOrderRow[]>) {
  const map = new Map<number, RawOrderRow>();
  for (const rows of groups) {
    for (const row of rows) map.set(Number(row.id), row);
  }
  return Array.from(map.values());
}

function financialStateById(states: RawFinancialStateRow[]) {
  const map = new Map<number, RawFinancialStateRow>();
  for (const state of states) {
    const id = Number(state.order_id);
    if (Number.isFinite(id) && id > 0) map.set(id, state);
  }
  return map;
}

function paymentVerifyFromState(status: OrderStatus, state: RawFinancialStateRow | null): PaymentVerify {
  if (status === "cancelled") return "none";
  const pendingCount = Math.trunc(toNumber(state?.pending_reports_count, 0));
  const rejectedCount = Math.trunc(toNumber(state?.rejected_reports_count, 0));
  const confirmedCount = Math.trunc(toNumber(state?.confirmed_reports_count, 0));
  const confirmedPaid = roundMoney(state?.confirmed_paid_usd, 0);

  if (pendingCount > 0) return "pending";
  if (rejectedCount > 0 && confirmedPaid <= 0.01) return "rejected";
  if (confirmedPaid > 0.01 || confirmedCount > 0) return "confirmed";
  return "none";
}

function buildClientOrderStats(rows: Array<{ id: number | string; client_id: number | string | null }>) {
  const map = new Map<number, { firstOrderId: number | null; orderCount: number }>();
  for (const row of rows) {
    const clientId = Number(row.client_id);
    const orderId = Number(row.id);
    if (!Number.isFinite(clientId) || clientId <= 0 || !Number.isFinite(orderId) || orderId <= 0) continue;
    const current = map.get(clientId) ?? { firstOrderId: null, orderCount: 0 };
    map.set(clientId, {
      firstOrderId: current.firstOrderId ?? orderId,
      orderCount: current.orderCount + 1,
    });
  }
  return map;
}

function mapOrder(
  row: RawOrderRow,
  financialStates: Map<number, RawFinancialStateRow>,
  clientStats: Map<number, { firstOrderId: number | null; orderCount: number }>
): MasterOpsOrder {
  const client = one(row.client);
  const advisor = one(row.advisor);
  const creator = one(row.creator);
  const state = financialStates.get(Number(row.id)) ?? null;
  const totalUsd = roundMoney(
    state?.total_usd,
    roundMoney(row.extra_fields?.pricing?.total_usd, toNumber(row.total_usd, 0))
  );
  const totalBs =
    state?.total_bs != null
      ? roundMoney(state.total_bs, 0)
      : row.extra_fields?.pricing?.total_bs != null
        ? roundMoney(row.extra_fields.pricing.total_bs, 0)
        : row.total_bs_snapshot == null
          ? null
          : roundMoney(row.total_bs_snapshot, 0);
  const clientId = Number(row.client_id ?? client?.id ?? 0);
  const clientCreatedAtMs = client?.created_at ? Date.parse(client.created_at) : Number.NaN;
  const isNewClient =
    row.status !== "cancelled" &&
    Number.isFinite(clientId) &&
    clientId > 0 &&
    Number.isFinite(clientCreatedAtMs) &&
    clientCreatedAtMs >= CLIENT_IMPORT_CUTOFF_MS &&
    clientStats.get(clientId)?.firstOrderId === Number(row.id);
  const creatorName = cleanText(creator?.full_name, "Usuario");
  const advisorName =
    row.source === "master"
      ? `Master (${creatorName})`
      : row.source === "walk_in"
        ? `Mostrador (${creatorName})`
        : cleanText(advisor?.full_name ?? creator?.full_name, "Sin asesor");

  return {
    id: Number(row.id),
    status: row.status,
    fulfillment: row.fulfillment,
    advisorName,
    clientName: cleanText(client?.full_name ?? row.extra_fields?.receiver?.name, "Cliente sin nombre"),
    totalUsd,
    totalBs,
    balanceUsd: row.status === "cancelled" ? 0 : Math.max(0, roundMoney(state?.pending_usd, totalUsd)),
    confirmedPaidUsd: row.status === "cancelled" ? 0 : roundMoney(state?.confirmed_paid_usd, 0),
    paymentVerify: paymentVerifyFromState(row.status, state),
    deliveryAtISO: buildDeliveryISO(row.extra_fields, row.created_at),
    createdAtISO: row.created_at,
    sentToKitchenAtISO: row.sent_to_kitchen_at ?? null,
    kitchenStartedAtISO: row.kitchen_started_at ?? null,
    readyAtISO: row.ready_at ?? null,
    queuedNeedsReapproval: Boolean(row.queued_needs_reapproval),
    returnedToAdvisor: Boolean(row.extra_fields?.review?.returned_to_advisor),
    isAsap: Boolean(row.extra_fields?.schedule?.asap ?? false),
    isNewClient,
    riderName: row.internal_driver_user_id ? "Interno asignado" : null,
    externalPartner: row.external_driver_name?.trim() || (row.external_partner_id ? "Externo asignado" : null),
  };
}

function buildOperationStats(orders: MasterOpsOrder[]): OperationStatsSummary {
  const scheduledOrders = orders.filter((order) => isScheduledClosingOrder(order));
  const billingOrders = orders.filter((order) => isRecognizedBillingOrder(order));
  return {
    cierres: scheduledOrders.length,
    fact: billingOrders.reduce((sum, order) => sum + order.totalUsd, 0),
    abonadoConfirmado: billingOrders.reduce((sum, order) => sum + order.confirmedPaidUsd, 0),
    pendiente: billingOrders.reduce((sum, order) => sum + order.balanceUsd, 0),
  };
}

function buildStats(dayOrders: MasterOpsOrder[], weekOrders: MasterOpsOrder[]): MasterOpsStats {
  const activeDeliveryOrders = dayOrders.filter(
    (order) => order.fulfillment === "delivery" && !["delivered", "cancelled"].includes(order.status)
  );
  const driverTasks = weekOrders.filter((order) => canManageOrderDeliveryAssignment(order) && !order.riderName && !order.externalPartner);

  return {
    day: buildOperationStats(dayOrders),
    week: buildOperationStats(weekOrders),
    payments: {
      porConfirmar: weekOrders.filter((order) => order.paymentVerify === "pending").length,
      confirmados: weekOrders.filter((order) => order.paymentVerify === "confirmed").length,
      rechazados: weekOrders.filter((order) => order.paymentVerify === "rejected").length,
    },
    deliveries: {
      internos: activeDeliveryOrders.filter((order) => Boolean(order.riderName?.trim())).length,
      externos: activeDeliveryOrders.filter((order) => Boolean(order.externalPartner?.trim())).length,
    },
    kitchen: {
      totalEnCocina: dayOrders.filter((order) => ["confirmed", "in_kitchen", "ready"].includes(order.status)).length,
      pendientesToma: dayOrders.filter((order) => order.status === "confirmed").length,
      enPreparacion: dayOrders.filter((order) => order.status === "in_kitchen").length,
      preparados: dayOrders.filter((order) => order.status === "ready").length,
    },
    urgentTasks: {
      approve: weekOrders.filter((order) => needsInitialOrderApproval(order)).length,
      reapprove: weekOrders.filter((order) => order.status === "queued" && order.queuedNeedsReapproval).length,
      kitchen: weekOrders.filter((order) => order.status === "queued" && !order.queuedNeedsReapproval).length,
      driver: driverTasks.length,
    },
    actions:
      weekOrders.filter((order) => needsInitialOrderApproval(order)).length +
      weekOrders.filter((order) => order.status === "queued" && order.queuedNeedsReapproval).length +
      weekOrders.filter((order) => order.paymentVerify === "pending").length +
      driverTasks.length,
    updates: weekOrders.filter((order) => ["confirmed", "in_kitchen", "ready", "out_for_delivery"].includes(order.status)).length,
  };
}

export default async function MasterOpsPage({ searchParams }: { searchParams?: SearchParams }) {
  noStore();

  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!isMasterOrAdminRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const params = (await searchParams) ?? {};
  const focusDate = normalizeFocusDate(params.focusDate);
  const dayRange = getCaracasDayRange(focusDate);
  const weekRange = getCaracasWeekRange(focusDate);
  const orderSelect = `
    id,
    client_id,
    attributed_advisor_id,
    source,
    status,
    fulfillment,
    total_usd,
    total_bs_snapshot,
    created_at,
    sent_to_kitchen_at,
    kitchen_started_at,
    ready_at,
    extra_fields,
    queued_needs_reapproval,
    internal_driver_user_id,
    external_driver_name,
    external_partner_id,
    client:clients!orders_client_id_fkey (
      id,
      full_name,
      phone,
      created_at,
      client_type
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
    scheduledDayResult,
    createdDayResult,
    scheduledWeekResult,
    createdWeekResult,
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
      .limit(500),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .gte("created_at", dayRange.startISO)
      .lt("created_at", dayRange.endISO)
      .order("created_at", { ascending: false })
      .limit(500),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .gte("extra_fields->schedule->>date", weekRange.startKey)
      .lt("extra_fields->schedule->>date", weekRange.endExclusiveKey)
      .order("created_at", { ascending: false })
      .limit(900),
    ctx.supabase
      .from("orders")
      .select(orderSelect)
      .gte("created_at", weekRange.startISO)
      .lt("created_at", weekRange.endISO)
      .order("created_at", { ascending: false })
      .limit(900),
  ]);

  const firstError =
    profileResult.error ??
    activeRateResult.error ??
    scheduledDayResult.error ??
    createdDayResult.error ??
    scheduledWeekResult.error ??
    createdWeekResult.error;

  if (firstError) throw new Error(firstError.message);

  const scheduledDayRows = (scheduledDayResult.data ?? []) as RawOrderRow[];
  const createdDayRows = ((createdDayResult.data ?? []) as RawOrderRow[]).filter(
    (row) => !getScheduleDate(row.extra_fields)
  );
  const scheduledWeekRows = (scheduledWeekResult.data ?? []) as RawOrderRow[];
  const createdWeekRows = ((createdWeekResult.data ?? []) as RawOrderRow[]).filter(
    (row) => !getScheduleDate(row.extra_fields)
  );
  const dayRows = mergeRows(scheduledDayRows, createdDayRows);
  const weekRows = mergeRows(scheduledWeekRows, createdWeekRows);
  const allRows = mergeRows(dayRows, weekRows);
  const allOrderIds = allRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  const activeRate = toNumber(activeRateResult.data?.rate_bs_per_usd, 0);

  const { data: financialStateData, error: financialStateError } =
    allOrderIds.length > 0
      ? await (ctx.supabase as any).rpc("get_orders_financial_state", {
          p_order_ids: allOrderIds,
          p_operation_date: null,
          p_active_bs_rate: activeRate > 0 ? activeRate : null,
        })
      : { data: [], error: null };

  if (financialStateError) {
    throw new Error(financialStateError.message);
  }

  const clientIds = Array.from(
    new Set(allRows.map((row) => Number(row.client_id)).filter((id) => Number.isFinite(id) && id > 0))
  );
  const clientHistoryResult =
    clientIds.length > 0
      ? await ctx.supabase
          .from("orders")
          .select("id, client_id")
          .in("client_id", clientIds)
          .neq("status", "cancelled")
          .order("id", { ascending: true })
          .limit(2000)
      : { data: [], error: null };

  if (clientHistoryResult.error) {
    throw new Error(clientHistoryResult.error.message);
  }

  const financialStates = financialStateById((financialStateData ?? []) as RawFinancialStateRow[]);
  const clientStats = buildClientOrderStats((clientHistoryResult.data ?? []) as Array<{ id: number | string; client_id: number | string | null }>);
  const dayOrders = dayRows.map((row) => mapOrder(row, financialStates, clientStats));
  const weekOrders = weekRows.map((row) => mapOrder(row, financialStates, clientStats));
  const profile = profileResult.data as { full_name: string | null } | null;

  return (
    <MasterOpsClient
      activeRate={activeRate > 0 ? activeRate : null}
      currentUserName={cleanText(profile?.full_name ?? ctx.user.email, "Usuario")}
      focusDate={focusDate}
      nextDate={addDaysKey(focusDate, 1)}
      orders={dayOrders}
      previousDate={addDaysKey(focusDate, -1)}
      roles={ctx.roles}
      stats={buildStats(dayOrders, weekOrders)}
      weekLabel={getWeekLabel(focusDate)}
    />
  );
}
