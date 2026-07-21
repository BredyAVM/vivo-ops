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
import { formatOrderDisplayNumber } from "@/lib/orders/order-labels";
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from "@/lib/auth";
import MasterOpsClient, {
  type DeliveryPartnerOption,
  type DriverOption,
  type MasterOpsPaymentAccountOption,
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
  order_number: string | null;
  client_id: number | string | null;
  attributed_advisor_id: string | null;
  source: "advisor" | "master" | "walk_in";
  status: OrderStatus;
  fulfillment: FulfillmentType;
  delivery_address: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  notes: string | null;
  created_at: string;
  sent_to_kitchen_at: string | null;
  kitchen_started_at: string | null;
  ready_at: string | null;
  eta_minutes: number | string | null;
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
        fund_balance_usd: number | string | null;
      }[]
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        created_at: string | null;
        client_type: string | null;
        fund_balance_usd: number | string | null;
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

type RawOrderItemRow = {
  id: number;
  order_id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  unit_price_bs_snapshot: number | string | null;
  line_total_usd: number | string | null;
  product_name_snapshot: string | null;
  notes: string | null;
};

type RawPaymentReportRow = {
  id: number;
  order_id: number | string;
  status: "pending" | "confirmed" | "rejected";
  created_at: string | null;
  operation_date: string | null;
  created_by_user_id: string | null;
  reported_currency_code: string;
  reported_amount: number | string | null;
  reported_exchange_rate_ves_per_usd: number | string | null;
  reported_amount_usd_equivalent: number | string | null;
  reported_money_account_id: number | string | null;
  reference_code: string | null;
  payer_name: string | null;
  notes: string | null;
};

type RawOrderEventRow = {
  id: number | string;
  order_id: number | string;
  title: string | null;
  message: string | null;
  severity: "info" | "warning" | "critical" | null;
  actor_user_id: string | null;
  created_at: string;
};

type RawOrderAdjustmentRow = {
  id: number;
  order_id: number | string;
  adjustment_type: string | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
  created_by_user_id: string | null;
};

type RawMoneyAccountRow = {
  id: number | string;
  name: string | null;
  currency_code?: string | null;
  account_kind?: string | null;
  is_active?: boolean | null;
};

type RawPaymentRuleRow = {
  money_account_id: number | string | null;
  role: string | null;
  payment_method_code: string | null;
  can_report_payment: boolean | null;
  is_active: boolean | null;
};

type RawProfileNameRow = {
  id: string;
  full_name: string | null;
};

type RawProductDetailRow = {
  id: number | string;
  type: string | null;
  units_per_service: number | string | null;
};

type RawDeliveryPartnerRow = {
  id: number | string;
  name: string | null;
  partner_type: string | null;
  whatsapp_phone: string | null;
  is_active: boolean | null;
};

type RawDriverProfileRow = {
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
};

type MasterOpsOrderDetailMaps = {
  itemsByOrder?: Map<number, RawOrderItemRow[]>;
  reportsByOrder?: Map<number, RawPaymentReportRow[]>;
  eventsByOrder?: Map<number, RawOrderEventRow[]>;
  adjustmentsByOrder?: Map<number, RawOrderAdjustmentRow[]>;
  moneyAccountNameById?: Map<number, string>;
  profileNameById?: Map<string, string>;
  productDetailById?: Map<number, RawProductDetailRow>;
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

function normalizeCurrencyCode(value: string | null | undefined): "USD" | "VES" | null {
  const currency = String(value || "").trim().toUpperCase();
  return currency === "USD" || currency === "VES" ? currency : null;
}

function buildPaymentAccountOptions({
  accounts,
  rules,
  roles,
}: {
  accounts: RawMoneyAccountRow[];
  rules: RawPaymentRuleRow[];
  roles: string[];
}): MasterOpsPaymentAccountOption[] {
  const activeRoles = new Set(roles.map((role) => String(role || "").trim()).filter(Boolean));
  const accountById = new Map(
    accounts
      .filter((account) => account.is_active !== false)
      .map((account) => [Number(account.id), account] as const)
      .filter(([id]) => Number.isFinite(id) && id > 0)
  );
  const options = new Map<string, MasterOpsPaymentAccountOption>();
  const methodOrder = new Map([
    ["payment_mobile", 10],
    ["transfer", 20],
    ["zelle", 30],
    ["wallet_usd", 35],
    ["cash_usd", 40],
    ["cash_ves", 50],
    ["pos", 60],
    ["retention", 70],
  ]);

  for (const rule of rules) {
    if (!rule.is_active || !rule.can_report_payment) continue;
    const role = String(rule.role || "").trim();
    if (!activeRoles.has(role)) continue;
    const method = String(rule.payment_method_code || "").trim();
    if (!method) continue;
    const accountId = Number(rule.money_account_id);
    const account = accountById.get(accountId);
    if (!account) continue;
    const currencyCode = normalizeCurrencyCode(account.currency_code);
    if (!currencyCode) continue;
    const key = `${accountId}:${method}`;
    if (options.has(key)) continue;

    options.set(key, {
      key,
      accountId,
      accountName: cleanText(account.name, `Cuenta #${accountId}`),
      currencyCode,
      paymentMethodCode: method,
    });
  }

  return Array.from(options.values()).sort((a, b) => {
    const byCurrency = a.currencyCode.localeCompare(b.currencyCode);
    if (byCurrency !== 0) return byCurrency;
    const byAccount = a.accountName.localeCompare(b.accountName, "es-VE");
    if (byAccount !== 0) return byAccount;
    return (methodOrder.get(a.paymentMethodCode) ?? 999) - (methodOrder.get(b.paymentMethodCode) ?? 999);
  });
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

function extractUnitsPerServiceFromName(name: string | null | undefined) {
  const match = String(name || "").match(/\((\d+(?:[.,]\d+)?)\s*(?:und|unidad|unidades|pzas?|piezas?)\)/i);
  if (!match) return 0;
  const units = Number(match[1].replace(",", "."));
  return Number.isFinite(units) && units > 0 ? units : 0;
}

function groupByOrderId<T extends { order_id: number | string }>(rows: T[]) {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const orderId = Number(row.order_id);
    if (!Number.isFinite(orderId) || orderId <= 0) continue;
    const bucket = map.get(orderId) ?? [];
    bucket.push(row);
    map.set(orderId, bucket);
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
  clientStats: Map<number, { firstOrderId: number | null; orderCount: number }>,
  detail: MasterOpsOrderDetailMaps = {}
): MasterOpsOrder {
  const client = one(row.client);
  const advisor = one(row.advisor);
  const creator = one(row.creator);
  const state = financialStates.get(Number(row.id)) ?? null;
  const orderId = Number(row.id);
  const orderItems = detail.itemsByOrder?.get(orderId) ?? [];
  const reports = detail.reportsByOrder?.get(orderId) ?? [];
  const events = detail.eventsByOrder?.get(orderId) ?? [];
  const adjustments = detail.adjustmentsByOrder?.get(orderId) ?? [];
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
  const subtotalUsd =
    row.extra_fields?.pricing?.subtotal_usd != null
      ? roundMoney(row.extra_fields.pricing.subtotal_usd, 0)
      : null;
  const subtotalBs =
    row.extra_fields?.pricing?.subtotal_bs != null
      ? roundMoney(row.extra_fields.pricing.subtotal_bs, 0)
      : null;
  const subtotalAfterDiscountUsd =
    row.extra_fields?.pricing?.subtotal_after_discount_usd != null
      ? roundMoney(row.extra_fields.pricing.subtotal_after_discount_usd, 0)
      : null;
  const subtotalAfterDiscountBs =
    row.extra_fields?.pricing?.subtotal_after_discount_bs != null
      ? roundMoney(row.extra_fields.pricing.subtotal_after_discount_bs, 0)
      : null;
  const invoiceTaxAmountUsd =
    row.extra_fields?.pricing?.invoice_tax_amount_usd != null
      ? roundMoney(row.extra_fields.pricing.invoice_tax_amount_usd, 0)
      : 0;
  const invoiceTaxAmountBs =
    row.extra_fields?.pricing?.invoice_tax_amount_bs != null
      ? roundMoney(row.extra_fields.pricing.invoice_tax_amount_bs, 0)
      : 0;
  const discountAmountUsd = Math.max(
    0,
    roundMoney((subtotalUsd ?? totalUsd) - (subtotalAfterDiscountUsd ?? totalUsd), 0)
  );
  const discountAmountBs = Math.max(
    0,
    roundMoney((subtotalBs ?? totalBs ?? 0) - (subtotalAfterDiscountBs ?? totalBs ?? 0), 0)
  );
  const lines = orderItems.map((item) => {
    const productName = cleanText(item.product_name_snapshot, "Producto");
    const productId = Number(item.product_id);
    const product = Number.isFinite(productId) ? detail.productDetailById?.get(productId) : null;
    const productUnits = toNumber(product?.units_per_service, 0);
    const unitsPerService = productUnits > 0 ? productUnits : extractUnitsPerServiceFromName(productName);
    const lowerName = productName.toLowerCase();

    return {
      name: productName,
      qty: toNumber(item.qty, 0),
      unitsPerService,
      priceBs: roundMoney(item.unit_price_bs_snapshot, 0),
      lineTotalUsd: roundMoney(item.line_total_usd, 0),
      productType: product?.type ?? null,
      isDelivery: lowerName.startsWith("delivery") || lowerName.includes("delivery"),
      editableDetailLines: item.notes
        ? item.notes
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    };
  });
  const paymentReports = reports.map((report) => {
    const accountId = Number(report.reported_money_account_id);
    const accountName =
      Number.isFinite(accountId) && accountId > 0
        ? detail.moneyAccountNameById?.get(accountId) ?? `Cuenta #${accountId}`
        : "Cuenta";
    const normalizedRetentionText = `${accountName} ${report.notes ?? ""}`
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return {
      id: Number(report.id),
      status: report.status,
      createdAt: report.created_at,
      operationDate: report.operation_date ?? null,
      reporterName:
        (report.created_by_user_id ? detail.profileNameById?.get(report.created_by_user_id) : null) ??
        "Usuario",
      currencyCode: cleanText(report.reported_currency_code, "--"),
      amount: roundMoney(report.reported_amount, 0),
      exchangeRate:
        report.reported_exchange_rate_ves_per_usd == null
          ? null
          : roundMoney(report.reported_exchange_rate_ves_per_usd, 0),
      usdEquivalent: roundMoney(report.reported_amount_usd_equivalent, 0),
      moneyAccountId: Number.isFinite(accountId) && accountId > 0 ? accountId : null,
      moneyAccountName: accountName,
      referenceCode: report.reference_code ?? null,
      payerName: report.payer_name ?? null,
      notes: report.notes ?? null,
      isRetention:
        normalizedRetentionText.includes("retencion") ||
        normalizedRetentionText.includes("comprobante retencion"),
    };
  });
  const orderEvents = events.map((event) => ({
    id: String(event.id),
    title: cleanText(event.title, "Evento"),
    message: event.message ?? null,
    severity:
      event.severity === "critical" || event.severity === "warning" || event.severity === "info"
        ? event.severity
        : "info",
    actorName:
      (event.actor_user_id ? detail.profileNameById?.get(event.actor_user_id) : null) ??
      "Sistema",
    createdAt: event.created_at,
  }));
  const adminAdjustments = adjustments.map((adjustment) => ({
    id: Number(adjustment.id),
    adjustmentType: cleanText(adjustment.adjustment_type, "Ajuste"),
    reason: cleanText(adjustment.reason, "--"),
    notes: adjustment.notes ?? null,
    createdAt: adjustment.created_at,
    createdByName:
      (adjustment.created_by_user_id ? detail.profileNameById?.get(adjustment.created_by_user_id) : null) ??
      "Admin",
  }));

  return {
    id: orderId,
    orderNumber: formatOrderDisplayNumber(orderId),
    status: row.status,
    fulfillment: row.fulfillment,
    advisorName,
    clientName: cleanText(client?.full_name ?? row.extra_fields?.receiver?.name, "Cliente sin nombre"),
    clientPhone: client?.phone ?? null,
    clientCreatedAtISO: client?.created_at ?? null,
    clientOrderCount: clientStats.get(clientId)?.orderCount ?? 0,
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
    address: row.delivery_address ?? null,
    notes: row.notes ?? null,
    receiverName: row.extra_fields?.receiver?.name ?? row.receiver_name ?? null,
    receiverPhone: row.extra_fields?.receiver?.phone ?? row.receiver_phone ?? null,
    deliveryGpsUrl: row.extra_fields?.delivery?.gps_url ?? null,
    deliveryDistanceKm:
      row.extra_fields?.delivery?.distance_km != null
        ? roundMoney(row.extra_fields.delivery.distance_km, 0)
        : null,
    deliveryCostUsd:
      row.extra_fields?.delivery?.cost_usd != null
        ? roundMoney(row.extra_fields.delivery.cost_usd, 0)
        : null,
    paymentMethod: row.extra_fields?.payment?.method ?? null,
    paymentCurrency:
      row.extra_fields?.payment?.currency === "VES" || row.extra_fields?.payment?.currency === "USD"
        ? row.extra_fields.payment.currency
        : null,
    paymentRequiresChange: Boolean(row.extra_fields?.payment?.requires_change ?? false),
    paymentChangeFor:
      row.extra_fields?.payment?.change_for != null
        ? String(row.extra_fields.payment.change_for)
        : null,
    paymentChangeCurrency:
      row.extra_fields?.payment?.change_currency === "VES" || row.extra_fields?.payment?.change_currency === "USD"
        ? row.extra_fields.payment.change_currency
        : null,
    paymentNote: row.extra_fields?.payment?.notes ?? null,
    hasDeliveryNote: Boolean(row.extra_fields?.documents?.has_delivery_note ?? false),
    hasInvoice: Boolean(row.extra_fields?.documents?.has_invoice ?? false),
    invoiceDataNote: row.extra_fields?.documents?.invoice_data_note ?? null,
    invoiceSnapshot: row.extra_fields?.documents?.invoice_snapshot
      ? {
          companyName: row.extra_fields.documents.invoice_snapshot.company_name ?? null,
          taxId: row.extra_fields.documents.invoice_snapshot.tax_id ?? null,
          address: row.extra_fields.documents.invoice_snapshot.address ?? null,
          phone: row.extra_fields.documents.invoice_snapshot.phone ?? null,
        }
      : null,
    deliveryNoteSnapshot: row.extra_fields?.documents?.delivery_note_snapshot
      ? {
          name: row.extra_fields.documents.delivery_note_snapshot.name ?? null,
          documentId: row.extra_fields.documents.delivery_note_snapshot.document_id ?? null,
          address: row.extra_fields.documents.delivery_note_snapshot.address ?? null,
          phone: row.extra_fields.documents.delivery_note_snapshot.phone ?? null,
        }
      : null,
    fxRate:
      row.extra_fields?.pricing?.fx_rate != null
        ? roundMoney(row.extra_fields.pricing.fx_rate, 0)
        : null,
    discountPct:
      row.extra_fields?.pricing?.discount_pct != null
        ? roundMoney(row.extra_fields.pricing.discount_pct, 0)
        : null,
    discountAmountUsd,
    discountAmountBs,
    invoiceTaxPct:
      row.extra_fields?.pricing?.invoice_tax_pct != null
        ? roundMoney(row.extra_fields.pricing.invoice_tax_pct, 0)
        : null,
    invoiceTaxAmountUsd,
    invoiceTaxAmountBs,
    subtotalUsd,
    subtotalBs,
    subtotalAfterDiscountUsd,
    subtotalAfterDiscountBs,
    lines,
    paymentReports,
    events: orderEvents,
    adminAdjustments,
    riderName:
      (row.internal_driver_user_id ? detail.profileNameById?.get(row.internal_driver_user_id) : null) ??
      (row.internal_driver_user_id ? "Interno asignado" : null),
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
    order_number,
    client_id,
    attributed_advisor_id,
    source,
    status,
    fulfillment,
    delivery_address,
    receiver_name,
    receiver_phone,
    total_usd,
    total_bs_snapshot,
    notes,
    created_at,
    sent_to_kitchen_at,
    kitchen_started_at,
    ready_at,
    eta_minutes,
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
      client_type,
      fund_balance_usd
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
    deliveryPartnersResult,
    driversResult,
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
    ctx.supabase
      .from("delivery_partners")
      .select("id, name, partner_type, whatsapp_phone, is_active")
      .order("name", { ascending: true }),
    ctx.supabase.rpc("get_driver_profiles"),
  ]);

  const firstError =
    profileResult.error ??
    activeRateResult.error ??
    scheduledDayResult.error ??
    createdDayResult.error ??
    scheduledWeekResult.error ??
    createdWeekResult.error ??
    deliveryPartnersResult.error ??
    driversResult.error;

  if (firstError) throw new Error(firstError.message);

  const deliveryPartners: DeliveryPartnerOption[] = ((deliveryPartnersResult.data ?? []) as RawDeliveryPartnerRow[])
    .map((row) => ({
      id: Number(row.id),
      name: cleanText(row.name, `Partner #${row.id}`),
      partnerType: cleanText(row.partner_type, "company_dispatch"),
      whatsappPhone: row.whatsapp_phone ?? null,
      isActive: row.is_active !== false,
    }))
    .filter((partner) => Number.isFinite(partner.id) && partner.id > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "es-VE"));

  const drivers: DriverOption[] = ((driversResult.data ?? []) as RawDriverProfileRow[])
    .filter((row) => row.is_active !== false)
    .map((row) => ({
      id: String(row.user_id),
      fullName: cleanText(row.full_name, "Sin nombre"),
    }))
    .filter((driver) => driver.id.trim())
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es-VE"));

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
  const dayOrderIds = dayRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
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

  const detailOrderIds = dayOrderIds.length > 0 ? dayOrderIds : [-1];
  const paymentReportRoles = ctx.roles.filter((role) => role === "admin" || role === "master");
  const [
    orderItemsResult,
    paymentReportsResult,
    orderEventsResult,
    orderAdjustmentsResult,
    moneyAccountsResult,
    paymentRulesResult,
  ] = await Promise.all([
    ctx.supabase
      .from("order_items")
      .select(
        `
        id,
        order_id,
        product_id,
        qty,
        unit_price_usd_snapshot,
        unit_price_bs_snapshot,
        line_total_usd,
        product_name_snapshot,
        notes
      `
      )
      .in("order_id", detailOrderIds),
    ctx.supabase
      .from("payment_reports")
      .select(
        `
        id,
        order_id,
        status,
        created_at,
        operation_date,
        created_by_user_id,
        reported_currency_code,
        reported_amount,
        reported_exchange_rate_ves_per_usd,
        reported_amount_usd_equivalent,
        reported_money_account_id,
        reference_code,
        payer_name,
        notes
      `
      )
      .in("order_id", detailOrderIds)
      .order("created_at", { ascending: false }),
    ctx.supabase
      .from("order_timeline_events")
      .select("id, order_id, title, message, severity, actor_user_id, created_at")
      .in("order_id", detailOrderIds)
      .order("created_at", { ascending: false })
      .limit(800),
    ctx.supabase
      .from("order_admin_adjustments")
      .select("id, order_id, adjustment_type, reason, notes, created_at, created_by_user_id")
      .in("order_id", detailOrderIds)
      .order("created_at", { ascending: false }),
    ctx.supabase.from("money_accounts").select("id, name, currency_code, account_kind, is_active"),
    ctx.supabase
      .from("money_account_payment_rules")
      .select("money_account_id, role, payment_method_code, can_report_payment, is_active")
      .eq("is_active", true)
      .eq("can_report_payment", true)
      .in("role", paymentReportRoles.length > 0 ? paymentReportRoles : ["master"]),
  ]);

  const detailError =
    orderItemsResult.error ??
    paymentReportsResult.error ??
    orderEventsResult.error ??
    orderAdjustmentsResult.error ??
    moneyAccountsResult.error ??
    paymentRulesResult.error;

  if (detailError) {
    throw new Error(detailError.message);
  }

  const orderItems = (orderItemsResult.data ?? []) as RawOrderItemRow[];
  const paymentReports = (paymentReportsResult.data ?? []) as RawPaymentReportRow[];
  const orderEvents = (orderEventsResult.data ?? []) as RawOrderEventRow[];
  const orderAdjustments = (orderAdjustmentsResult.data ?? []) as RawOrderAdjustmentRow[];
  const moneyAccounts = (moneyAccountsResult.data ?? []) as RawMoneyAccountRow[];
  const paymentRules = (paymentRulesResult.data ?? []) as RawPaymentRuleRow[];
  const productIds = Array.from(
    new Set(orderItems.map((item) => Number(item.product_id)).filter((id) => Number.isFinite(id) && id > 0))
  );
  const productsResult =
    productIds.length > 0
      ? await ctx.supabase.from("products").select("id, type, units_per_service").in("id", productIds)
      : { data: [], error: null };

  if (productsResult.error) {
    throw new Error(productsResult.error.message);
  }

  const profileIds = Array.from(
    new Set(
      [
        ...paymentReports.map((report) => report.created_by_user_id),
        ...orderEvents.map((event) => event.actor_user_id),
        ...orderAdjustments.map((adjustment) => adjustment.created_by_user_id),
        ...allRows.map((row) => row.internal_driver_user_id),
      ]
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    )
  );
  const profileNamesResult =
    profileIds.length > 0
      ? await ctx.supabase.from("profiles").select("id, full_name").in("id", profileIds)
      : { data: [], error: null };

  if (profileNamesResult.error) {
    throw new Error(profileNamesResult.error.message);
  }

  const moneyAccountNameById = new Map(
    moneyAccounts
      .map((account) => [Number(account.id), cleanText(account.name, `Cuenta #${account.id}`)] as const)
      .filter(([id]) => Number.isFinite(id) && id > 0)
  );
  const profileNameById = new Map(
    ((profileNamesResult.data ?? []) as RawProfileNameRow[]).map((profileRow) => [
      profileRow.id,
      cleanText(profileRow.full_name, "Usuario"),
    ])
  );
  const productDetailById = new Map(
    ((productsResult.data ?? []) as RawProductDetailRow[])
      .map((product) => [Number(product.id), product] as const)
      .filter(([id]) => Number.isFinite(id) && id > 0)
  );
  const detailMaps: MasterOpsOrderDetailMaps = {
    itemsByOrder: groupByOrderId(orderItems),
    reportsByOrder: groupByOrderId(paymentReports),
    eventsByOrder: groupByOrderId(orderEvents),
    adjustmentsByOrder: groupByOrderId(orderAdjustments),
    moneyAccountNameById,
    profileNameById,
    productDetailById,
  };

  const financialStates = financialStateById((financialStateData ?? []) as RawFinancialStateRow[]);
  const clientStats = buildClientOrderStats((clientHistoryResult.data ?? []) as Array<{ id: number | string; client_id: number | string | null }>);
  const dayOrders = dayRows.map((row) => mapOrder(row, financialStates, clientStats, detailMaps));
  const weekOrders = weekRows.map((row) => mapOrder(row, financialStates, clientStats));
  const paymentAccounts = buildPaymentAccountOptions({
    accounts: moneyAccounts,
    rules: paymentRules,
    roles: paymentReportRoles,
  });
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
      drivers={drivers}
      deliveryPartners={deliveryPartners}
      paymentAccounts={paymentAccounts}
    />
  );
}
