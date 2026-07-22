"use server";

import { revalidatePath } from "next/cache";
import { requireMasterOrAdminContext } from "@/lib/auth";
import { getPhoneSearchTerms } from "@/lib/phone/normalize-phone";
import { normalizeRemoteSearchValue } from "@/lib/search/normalize-search";
import {
  cancelOrderAction,
  confirmPaymentReportAction,
  searchMasterOrdersAction,
  settleClientFundPayoutAction,
  updateExchangeRateAction,
} from "../dashboard/actions";

const MASTER_OPS_OVERPAYMENT_ROUNDING_MAX_USD = 1;
const MASTER_OPS_SHORTFALL_ROUNDING_MAX_USD = 0.09;

export type MasterOpsOrderSearchResult = {
  id: number;
  orderNumber: string;
  matchPriority: number;
  status: string;
  fulfillment: string;
  clientName: string;
  clientPhone: string | null;
  advisorName: string;
  totalUsd: number;
  totalBs: number;
  createdAt: string;
  operationalDate: string;
};

function getMasterOpsSearchPricing(order: Record<string, unknown>) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === "object" && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, unknown>)
      : {};

  return extraFields.pricing && typeof extraFields.pricing === "object" && !Array.isArray(extraFields.pricing)
    ? (extraFields.pricing as Record<string, unknown>)
    : {};
}

function getMasterOpsSearchTotal(order: Record<string, unknown>, currency: "usd" | "bs") {
  const pricing = getMasterOpsSearchPricing(order);
  const snapshot = Number(pricing[`total_${currency}`]);
  const fallback = Number(order[currency === "usd" ? "total_usd" : "total_bs_snapshot"]);
  const value = Number.isFinite(snapshot) ? snapshot : Number.isFinite(fallback) ? fallback : 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getMasterOpsSearchOperationalDate(order: Record<string, unknown>) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === "object" && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, unknown>)
      : {};
  const schedule =
    extraFields.schedule && typeof extraFields.schedule === "object" && !Array.isArray(extraFields.schedule)
      ? (extraFields.schedule as Record<string, unknown>)
      : {};

  if (isDateKey(schedule.date)) return String(schedule.date);
  return getCaracasDateKey(String(order.created_at || ""));
}

export async function searchMasterOpsOrdersAction(input: {
  query: string;
  limit?: number;
}): Promise<MasterOpsOrderSearchResult[]> {
  const query = normalizeRemoteSearchValue(input.query);
  const isNumericQuery = /^\d+$/.test(query);

  if (query.length < 2 && !isNumericQuery) return [];

  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit ?? 10) || 10)));
  const baseSearchPromise =
    query.length >= 2
      ? searchMasterOrdersAction({ query, limit })
      : Promise.resolve([]);
  const [{ supabase }, baseResults] = await Promise.all([
    requireMasterOrAdminContext(),
    baseSearchPromise,
  ]);
  const phoneTerms = getPhoneSearchTerms(query)
    .map((term) => term.replace(/[,%()]/g, " ").trim())
    .filter((term) => term.replace(/\D/g, "").length >= 2)
    .slice(0, 5);
  let phoneClientIds: number[] = [];

  if (phoneTerms.length > 0) {
    const { data: phoneClients, error: phoneClientsError } = await supabase
      .from("clients")
      .select("id")
      .or(phoneTerms.map((term) => `phone.ilike.%${term}%`).join(","))
      .limit(Math.min(60, limit * 4));

    if (phoneClientsError) throw new Error(phoneClientsError.message);
    phoneClientIds = (phoneClients ?? [])
      .map((client) => Number(client.id))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  const directOrderId = isNumericQuery ? Number(query) : null;
  const supplementalFilters: string[] = [];
  if (directOrderId && Number.isSafeInteger(directOrderId) && directOrderId > 0) {
    supplementalFilters.push(`id.eq.${directOrderId}`);
  }
  if (phoneClientIds.length > 0) {
    supplementalFilters.push(`client_id.in.(${phoneClientIds.join(",")})`);
  }
  supplementalFilters.push(...phoneTerms.map((term) => `receiver_phone.ilike.%${term}%`));

  let supplementalRows: Array<Record<string, unknown>> = [];
  if (supplementalFilters.length > 0) {
    const { data, error } = await supabase
      .from("orders")
      .select(`
        id,
        status,
        fulfillment,
        total_usd,
        total_bs_snapshot,
        created_at,
        extra_fields,
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
      `)
      .or(supplementalFilters.join(","))
      .order("created_at", { ascending: false })
      .limit(Math.min(60, Math.max(12, limit * 3)));

    if (error) throw new Error(error.message);
    supplementalRows = (data ?? []) as Array<Record<string, unknown>>;
  }

  const byId = new Map<number, MasterOpsOrderSearchResult>();
  for (const result of baseResults as MasterOpsOrderSearchResult[]) {
    const id = Number(result.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, { ...result, id, orderNumber: String(id) });
  }

  const normalizedPhoneDigits = query.replace(/\D/g, "");
  for (const row of supplementalRows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const client = one(
      row.client as Record<string, unknown>[] | Record<string, unknown> | null
    );
    const advisor = one(
      row.advisor as Record<string, unknown>[] | Record<string, unknown> | null
    );
    const creator = one(
      row.creator as Record<string, unknown>[] | Record<string, unknown> | null
    );
    const clientPhone = cleanText(client?.phone) || null;
    const clientPhoneDigits = String(clientPhone || "").replace(/\D/g, "");
    const isExactPhone =
      normalizedPhoneDigits.length >= 2 &&
      (clientPhoneDigits === normalizedPhoneDigits || clientPhoneDigits.endsWith(normalizedPhoneDigits));
    const matchPriority = directOrderId === id ? 0 : isExactPhone ? 4 : 6;
    const current = byId.get(id);

    if (current) {
      byId.set(id, {
        ...current,
        orderNumber: String(id),
        matchPriority: Math.min(current.matchPriority, matchPriority),
      });
      continue;
    }

    byId.set(id, {
      id,
      orderNumber: String(id),
      matchPriority,
      status: cleanText(row.status),
      fulfillment: cleanText(row.fulfillment),
      clientName: cleanText(client?.full_name, "Sin cliente"),
      clientPhone,
      advisorName: cleanText(advisor?.full_name, cleanText(creator?.full_name)),
      totalUsd: getMasterOpsSearchTotal(row, "usd"),
      totalBs: getMasterOpsSearchTotal(row, "bs"),
      createdAt: cleanText(row.created_at),
      operationalDate: getMasterOpsSearchOperationalDate(row),
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => a.matchPriority - b.matchPriority || b.id - a.id)
    .slice(0, limit);
}

export type MasterOpsPaymentConfirmationInput = {
  reportId: number;
  orderId: number;
  confirmedMoneyAccountId: number;
  confirmedCurrency: string;
  confirmedAmount: number;
  movementDate: string;
  confirmedExchangeRateVesPerUsd: number | null;
  reviewNotes: string;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  paymentKind?: "retention" | null;
  overpaymentHandling?: "change_given" | "store_fund" | "close_difference" | null;
  overpaymentNotes?: string | null;
  changeLines?: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
};

export async function confirmMasterOpsPaymentReportAction(
  input: MasterOpsPaymentConfirmationInput
) {
  const reportId = Number(input.reportId || 0);
  const orderId = Number(input.orderId || 0);
  const movementDate = String(input.movementDate || "").trim();

  if (!Number.isFinite(reportId) || reportId <= 0) {
    throw new Error("No se pudo identificar el reporte de pago.");
  }
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error("No se pudo identificar la orden.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) {
    throw new Error("Debes indicar una fecha de operacion valida.");
  }

  const { supabase, roles } = await requireMasterOrAdminContext();
  const confirmedMoneyAccountId = Number(input.confirmedMoneyAccountId || 0);
  const confirmedCurrency = String(input.confirmedCurrency || "").trim().toUpperCase();
  const confirmedAmount = Number(input.confirmedAmount);
  const confirmedExchangeRate =
    input.confirmedExchangeRateVesPerUsd == null
      ? null
      : Number(input.confirmedExchangeRateVesPerUsd);

  if (!Number.isFinite(confirmedMoneyAccountId) || confirmedMoneyAccountId <= 0) {
    throw new Error("Debes seleccionar una cuenta valida.");
  }
  if (confirmedCurrency !== "USD" && confirmedCurrency !== "VES") {
    throw new Error("La moneda confirmada no es valida.");
  }
  if (!Number.isFinite(confirmedAmount) || confirmedAmount <= 0) {
    throw new Error("Debes indicar un monto valido.");
  }
  if (confirmedCurrency === "VES" && (!confirmedExchangeRate || confirmedExchangeRate <= 0)) {
    throw new Error("Debes indicar una tasa valida para el pago en VES.");
  }

  const { data: moneyAccount, error: moneyAccountError } = await supabase
    .from("money_accounts")
    .select("id, currency_code, is_active")
    .eq("id", confirmedMoneyAccountId)
    .maybeSingle();

  if (moneyAccountError) throw new Error(moneyAccountError.message);
  if (
    !moneyAccount ||
    moneyAccount.is_active === false ||
    String(moneyAccount.currency_code || "").trim().toUpperCase() !== confirmedCurrency
  ) {
    throw new Error("La cuenta seleccionada no coincide con la moneda confirmada.");
  }

  const { data: report, error: reportError } = await supabase
    .from("payment_reports")
    .select("id, order_id, status, operation_date")
    .eq("id", reportId)
    .maybeSingle();

  if (reportError) throw new Error(reportError.message);
  if (!report) throw new Error("No se encontro el reporte de pago.");
  if (Number(report.order_id || 0) !== orderId) {
    throw new Error("El reporte no pertenece a esta orden.");
  }
  if (report.status !== "pending") {
    throw new Error("Este reporte ya fue revisado.");
  }

  const { data: financialStateData, error: financialStateError } = await (supabase as any).rpc(
    "get_orders_financial_state",
    {
      p_order_ids: [orderId],
      p_operation_date: null,
      p_active_bs_rate: confirmedCurrency === "VES" ? confirmedExchangeRate : null,
    }
  );

  if (financialStateError) throw new Error(financialStateError.message);
  const financialState = Array.isArray(financialStateData)
    ? financialStateData.find((row) => Number(row?.order_id || 0) === orderId)
    : null;
  if (!financialState) {
    throw new Error("No se pudo cargar el estado financiero actual de la orden.");
  }

  const pendingUsd = Math.max(0, Number(financialState.pending_usd || 0));
  const confirmedUsd = Number(
    (confirmedCurrency === "VES"
      ? confirmedAmount / Number(confirmedExchangeRate)
      : confirmedAmount
    ).toFixed(2)
  );
  const excessUsd = Number(Math.max(0, confirmedUsd - pendingUsd).toFixed(2));
  const overpaymentHandling = input.overpaymentHandling ?? null;

  if (
    overpaymentHandling &&
    !["change_given", "store_fund", "close_difference"].includes(overpaymentHandling)
  ) {
    throw new Error("La decision sobre el excedente no es valida.");
  }

  if (excessUsd > 0.005 && !overpaymentHandling) {
    throw new Error("Debes decidir que hacer con el excedente antes de confirmar.");
  }
  if (overpaymentHandling === "close_difference") {
    if (!roles.includes("admin")) {
      throw new Error("Solo admin puede cerrar excedentes por redondeo.");
    }
    if (excessUsd > MASTER_OPS_OVERPAYMENT_ROUNDING_MAX_USD) {
      throw new Error(
        `Solo se pueden cerrar excedentes de hasta ${MASTER_OPS_OVERPAYMENT_ROUNDING_MAX_USD.toFixed(2)} USD.`
      );
    }
  }
  if (excessUsd > 0.005 && overpaymentHandling === "change_given") {
    const changeLines = Array.isArray(input.changeLines) ? input.changeLines : [];
    if (changeLines.length === 0) {
      throw new Error("Debes agregar al menos una linea de cambio.");
    }

    const changeAccountIds = Array.from(
      new Set(changeLines.map((line) => Number(line.moneyAccountId || 0)).filter((id) => id > 0))
    );
    if (changeAccountIds.length === 0) {
      throw new Error("Las lineas de cambio no tienen cuentas validas.");
    }
    const { data: changeAccounts, error: changeAccountsError } = await supabase
      .from("money_accounts")
      .select("id, currency_code, is_active")
      .in("id", changeAccountIds);

    if (changeAccountsError) throw new Error(changeAccountsError.message);
    const changeAccountById = new Map(
      (changeAccounts ?? []).map((account) => [Number(account.id), account] as const)
    );

    const totalChangeUsd = Number(
      changeLines
        .reduce((sum, line) => {
          const amount = Number(line.amount);
          const currencyCode = String(line.currencyCode || "").trim().toUpperCase();
          const changeAccount = changeAccountById.get(Number(line.moneyAccountId || 0));
          const exchangeRate =
            line.exchangeRateVesPerUsd == null ? null : Number(line.exchangeRateVesPerUsd);
          if (
            !changeAccount ||
            changeAccount.is_active === false ||
            String(changeAccount.currency_code || "").trim().toUpperCase() !== currencyCode
          ) {
            throw new Error("Una linea de cambio no coincide con una cuenta activa.");
          }
          if (!Number.isFinite(amount) || amount <= 0 || (currencyCode !== "USD" && currencyCode !== "VES")) {
            throw new Error("Una linea de cambio tiene monto o moneda invalida.");
          }
          if (currencyCode === "VES" && (!exchangeRate || exchangeRate <= 0)) {
            throw new Error("Debes indicar una tasa valida para cada linea de cambio en VES.");
          }
          return sum + (currencyCode === "VES" ? amount / Number(exchangeRate) : amount);
        }, 0)
        .toFixed(2)
    );

    if (Math.abs(totalChangeUsd - excessUsd) > 0.01) {
      throw new Error("El cambio debe coincidir con el excedente calculado.");
    }
  }

  if (report.operation_date !== movementDate) {
    const { data: updatedReport, error: updateDateError } = await supabase
      .from("payment_reports")
      .update({ operation_date: movementDate })
      .eq("id", reportId)
      .eq("order_id", orderId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (updateDateError) throw new Error(updateDateError.message);
    if (!updatedReport) {
      throw new Error("No se pudo actualizar la fecha del reporte pendiente.");
    }
  }

  return confirmPaymentReportAction({
    ...input,
    clientId: null,
    confirmedMoneyAccountId,
    confirmedCurrency,
    confirmedAmount,
    confirmedExchangeRateVesPerUsd:
      confirmedCurrency === "VES" ? confirmedExchangeRate : null,
    movementDate,
    overpaymentHandling: excessUsd > 0.005 ? overpaymentHandling : null,
  });
}

export type MasterOpsMoneyLineInput = {
  moneyAccountId: number;
  currencyCode: string;
  amount: number;
  exchangeRateVesPerUsd?: number | null;
  notes?: string | null;
};

type MasterOpsValidatedMoneyLine = {
  moneyAccountId: number;
  currencyCode: "USD" | "VES";
  amount: number;
  exchangeRateVesPerUsd: number | null;
  amountUsd: number;
  notes: string | null;
};

type MasterOpsServerClient = Awaited<
  ReturnType<typeof requireMasterOrAdminContext>
>["supabase"];

type MasterOpsFinancialState = {
  totalUsd: number;
  totalBs: number;
  appliedPaidUsd: number;
  clientFundUsedUsd: number;
  pendingUsd: number;
};

function roundOpsMoney(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function asOpsRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

async function loadMasterOpsFinancialState(
  supabase: MasterOpsServerClient,
  orderId: number,
  activeBsRate: number | null = null
): Promise<MasterOpsFinancialState> {
  const { data, error } = await (supabase as any).rpc("get_orders_financial_state", {
    p_order_ids: [orderId],
    p_operation_date: null,
    p_active_bs_rate: activeBsRate,
  });

  if (error) throw new Error(error.message);
  const row = Array.isArray(data)
    ? data.find((item) => Number(item?.order_id || 0) === orderId)
    : null;
  if (!row) throw new Error("No se pudo cargar el estado financiero actual de la orden.");

  return {
    totalUsd: roundOpsMoney(row.total_usd),
    totalBs: roundOpsMoney(row.total_bs),
    appliedPaidUsd: roundOpsMoney(row.confirmed_paid_usd),
    clientFundUsedUsd: roundOpsMoney(row.client_fund_used_usd),
    pendingUsd: Math.max(0, roundOpsMoney(row.pending_usd)),
  };
}

async function validateMasterOpsMoneyLines(
  supabase: MasterOpsServerClient,
  linesInput: MasterOpsMoneyLineInput[],
  fallbackNotes: string | null,
  operationLabel: string
): Promise<MasterOpsValidatedMoneyLine[]> {
  const lines = Array.isArray(linesInput) ? linesInput : [];
  if (lines.length === 0) {
    throw new Error(`Debes agregar al menos una linea de ${operationLabel}.`);
  }
  if (lines.length > 20) {
    throw new Error(`No puedes registrar mas de 20 lineas de ${operationLabel}.`);
  }

  const normalized = lines.map((line) => {
    const moneyAccountId = Number(line.moneyAccountId || 0);
    const currencyText = String(line.currencyCode || "").trim().toUpperCase();
    const currencyCode = currencyText === "USD" || currencyText === "VES" ? currencyText : null;
    const amount = roundOpsMoney(line.amount);
    const exchangeRate =
      line.exchangeRateVesPerUsd == null
        ? null
        : Number(Number(line.exchangeRateVesPerUsd).toFixed(6));

    if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
      throw new Error(`Una linea de ${operationLabel} no tiene cuenta valida.`);
    }
    if (!currencyCode || amount <= 0) {
      throw new Error(`Una linea de ${operationLabel} tiene monto o moneda invalida.`);
    }
    if (currencyCode === "VES" && (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
      throw new Error(`Debes indicar una tasa valida para cada linea de ${operationLabel} en VES.`);
    }

    const amountUsd = roundOpsMoney(
      currencyCode === "VES" ? amount / Number(exchangeRate) : amount
    );
    if (amountUsd <= 0) {
      throw new Error(`Una linea de ${operationLabel} tiene equivalente USD invalido.`);
    }

    return {
      moneyAccountId,
      currencyCode,
      amount,
      exchangeRateVesPerUsd: currencyCode === "VES" ? exchangeRate : null,
      amountUsd,
      notes: String(line.notes || fallbackNotes || "").trim() || null,
    } satisfies MasterOpsValidatedMoneyLine;
  });

  const accountIds = Array.from(new Set(normalized.map((line) => line.moneyAccountId)));
  const { data: accounts, error: accountsError } = await supabase
    .from("money_accounts")
    .select("id, currency_code, is_active")
    .in("id", accountIds);

  if (accountsError) throw new Error(accountsError.message);
  const accountById = new Map((accounts ?? []).map((account) => [Number(account.id), account] as const));

  for (const line of normalized) {
    const account = accountById.get(line.moneyAccountId);
    if (
      !account ||
      account.is_active === false ||
      String(account.currency_code || "").trim().toUpperCase() !== line.currencyCode
    ) {
      throw new Error(`Una linea de ${operationLabel} no coincide con una cuenta activa.`);
    }
  }

  return normalized;
}

export async function settleMasterOpsClientFundPayoutAction(input: {
  orderId: number;
  lines: MasterOpsMoneyLineInput[];
  notes?: string | null;
}) {
  const { supabase } = await requireMasterOrAdminContext();
  const orderId = Number(input.orderId || 0);
  const notes = String(input.notes || "").trim() || null;

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error("Orden invalida.");
  }

  const cleanLines = await validateMasterOpsMoneyLines(
    supabase,
    input.lines,
    notes,
    "devolucion"
  );
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, client_id")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("No se pudo cargar la orden.");

  const clientId = Number(order.client_id || 0);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error("La orden no tiene cliente asociado.");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, fund_balance_usd")
    .eq("id", clientId)
    .maybeSingle();

  if (clientError) throw new Error(clientError.message);
  if (!client) throw new Error("No se pudo cargar el fondo del cliente.");

  const availableFundUsd = Math.max(0, roundOpsMoney(client.fund_balance_usd));
  const requestedPayoutUsd = roundOpsMoney(
    cleanLines.reduce((sum, line) => sum + line.amountUsd, 0)
  );
  if (requestedPayoutUsd > availableFundUsd + 0.005) {
    throw new Error(
      `La devolucion de ${requestedPayoutUsd.toFixed(2)} USD supera el fondo disponible de ${availableFundUsd.toFixed(2)} USD.`
    );
  }

  return settleClientFundPayoutAction({
    orderId,
    lines: cleanLines.map((line) => ({
      moneyAccountId: line.moneyAccountId,
      currencyCode: line.currencyCode,
      amount: line.amount,
      exchangeRateVesPerUsd: line.exchangeRateVesPerUsd,
      notes: line.notes,
    })),
    notes,
  });
}

export async function closeMasterOpsRoundingBalanceAction(input: {
  orderId: number;
  notes?: string | null;
}) {
  try {
    const { supabase, user, roles } = await requireMasterOrAdminContext();
    if (!roles.includes("admin")) {
      throw new Error("Solo admin puede cerrar diferencias de redondeo.");
    }

    const orderId = Number(input.orderId || 0);
    if (!Number.isFinite(orderId) || orderId <= 0) throw new Error("Orden invalida.");

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, status, total_usd, total_bs_snapshot, extra_fields")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) throw new Error(orderError.message);
    if (!order) throw new Error("No se pudo cargar la orden.");
    if (order.status === "cancelled") {
      throw new Error("No puedes cerrar diferencias en una orden cancelada.");
    }

    const extraFields = asOpsRecord(order.extra_fields);
    const pricing = asOpsRecord(extraFields.pricing);
    const payment = asOpsRecord(extraFields.payment);
    const fxRate = Number(pricing.fx_rate || 0);
    const financialState = await loadMasterOpsFinancialState(
      supabase,
      orderId,
      Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null
    );
    const pendingUsd = financialState.pendingUsd;

    if (pendingUsd <= 0.005) {
      throw new Error("Esta orden ya no tiene una diferencia pendiente por cerrar.");
    }
    if (pendingUsd > MASTER_OPS_SHORTFALL_ROUNDING_MAX_USD) {
      throw new Error(
        `Solo se pueden cerrar diferencias de hasta ${MASTER_OPS_SHORTFALL_ROUNDING_MAX_USD.toFixed(2)} USD.`
      );
    }

    const currentTotalUsd = financialState.totalUsd || roundOpsMoney(order.total_usd);
    const currentTotalBs = financialState.totalBs || roundOpsMoney(order.total_bs_snapshot);
    const nextTotalUsd = roundOpsMoney(currentTotalUsd - pendingUsd);
    const nextTotalBs =
      Number.isFinite(fxRate) && fxRate > 0
        ? roundOpsMoney(nextTotalUsd * fxRate)
        : currentTotalUsd > 0
          ? roundOpsMoney((currentTotalBs / currentTotalUsd) * nextTotalUsd)
          : currentTotalBs;
    const nowIso = new Date().toISOString();
    const notes = String(input.notes || "").trim() || null;

    pricing.total_usd = nextTotalUsd;
    pricing.total_bs = nextTotalBs;
    pricing.rounding_closed_usd = pendingUsd;
    pricing.rounding_close_applied_at = nowIso;
    pricing.rounding_close_applied_by = user.id;
    payment.rounding_close = {
      closed_balance_usd: pendingUsd,
      previous_total_usd: currentTotalUsd,
      next_total_usd: nextTotalUsd,
      applied_at: nowIso,
      applied_by: user.id,
      notes,
    };
    extraFields.pricing = pricing;
    extraFields.payment = payment;

    const { data: updatedOrder, error: updateOrderError } = await supabase
      .from("orders")
      .update({
        total_usd: nextTotalUsd,
        total_bs_snapshot: nextTotalBs,
        extra_fields: extraFields,
        last_modified_at: nowIso,
        last_modified_by: user.id,
      })
      .eq("id", orderId)
      .neq("status", "cancelled")
      .select("id")
      .maybeSingle();

    if (updateOrderError) throw new Error(updateOrderError.message);
    if (!updatedOrder) throw new Error("La orden cambio antes de cerrar la diferencia.");

    const { error: adjustmentError } = await supabase
      .from("order_admin_adjustments")
      .insert({
        order_id: orderId,
        order_item_id: null,
        adjustment_type: "other",
        reason: "Cierre de diferencia por redondeo",
        notes,
        payload: {
          kind: "rounding_writeoff",
          delta_usd: -pendingUsd,
          original_unit_price_usd: currentTotalUsd,
          override_unit_price_usd: nextTotalUsd,
          product_name: "Cierre por redondeo",
          qty: 1,
          closed_balance_usd: pendingUsd,
          previous_total_usd: currentTotalUsd,
          previous_total_bs: currentTotalBs,
          applied_paid_usd: financialState.appliedPaidUsd,
          client_fund_used_usd: financialState.clientFundUsedUsd,
          next_total_usd: nextTotalUsd,
          next_total_bs: nextTotalBs,
        },
        created_by_user_id: user.id,
      });

    revalidatePath("/app/master/ops");
    return {
      ok: true as const,
      id: orderId,
      auditWarning: adjustmentError?.message ?? null,
    };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Error cerrando la diferencia por redondeo.",
    };
  }
}

export async function cancelMasterOpsOrderAction(input: {
  orderId: number;
  reason: string;
  paidHandling?: "store_fund" | "refund" | null;
  refundLines?: MasterOpsMoneyLineInput[];
}) {
  const { supabase } = await requireMasterOrAdminContext();
  const orderId = Number(input.orderId || 0);
  const reason = String(input.reason || "").trim();

  if (!Number.isFinite(orderId) || orderId <= 0) throw new Error("Orden invalida.");
  if (!reason) throw new Error("Debes indicar un motivo de cancelacion.");

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, client_id, status, extra_fields")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("No se pudo cargar la orden.");
  if (order.status === "cancelled") throw new Error("La orden ya esta cancelada.");

  const { data: movements, error: movementsError } = await supabase
    .from("money_movements")
    .select("id, direction, amount_usd_equivalent, status, confirmed_at")
    .eq("order_id", orderId);

  if (movementsError) throw new Error(movementsError.message);
  const inconsistentMovements = (movements ?? []).filter(
    (movement) => movement.status !== "confirmed" && Boolean(movement.confirmed_at)
  );
  if (inconsistentMovements.length > 0) {
    throw new Error(
      "La cancelacion fue bloqueada porque existen movimientos anulados o no confirmados con marca de confirmacion. Requiere revision financiera."
    );
  }

  const { data: fundMovements, error: fundMovementsError } = await supabase
    .from("client_fund_movements")
    .select("movement_type, amount_usd, reason_code")
    .eq("order_id", orderId);

  if (fundMovementsError) throw new Error(fundMovementsError.message);
  const storedOverpaymentUsd = roundOpsMoney(
    (fundMovements ?? []).reduce((sum, movement) => {
      const reasonCode = String(movement.reason_code || "");
      const amountUsd = roundOpsMoney(movement.amount_usd);
      if (
        movement.movement_type === "credit" &&
        (reasonCode === "payment_overage_stored" || reasonCode === "retention_overage_stored")
      ) {
        return sum + amountUsd;
      }
      if (movement.movement_type === "debit" && reasonCode === "payment_void_fund_reversal") {
        return sum - amountUsd;
      }
      return sum;
    }, 0)
  );
  if (storedOverpaymentUsd > 0.005) {
    throw new Error(
      "La cancelacion fue bloqueada porque la orden tiene excedentes ya guardados en fondo. Requiere conciliacion financiera antes de cancelar."
    );
  }
  if (storedOverpaymentUsd < -0.005) {
    throw new Error("La orden tiene un ledger de fondo inconsistente y no puede cancelarse desde Ops.");
  }

  const confirmedMoneyUsd = roundOpsMoney(
    (movements ?? []).reduce((sum, movement) => {
      if (movement.status !== "confirmed") return sum;
      const amountUsd = roundOpsMoney(movement.amount_usd_equivalent);
      return sum + (movement.direction === "outflow" ? -amountUsd : amountUsd);
    }, 0)
  );
  if (confirmedMoneyUsd < -0.005) {
    throw new Error("La orden tiene un saldo de movimientos confirmado inconsistente.");
  }

  const extraFields = asOpsRecord(order.extra_fields);
  const payment = asOpsRecord(extraFields.payment);
  const clientFundUsedUsd = Math.max(0, roundOpsMoney(payment.client_fund_used_usd));
  const hasConfirmedMoney = confirmedMoneyUsd > 0.005;
  const hasClientFund = clientFundUsedUsd > 0.005;
  const clientId = Number(order.client_id || 0);

  if ((hasConfirmedMoney || hasClientFund) && (!Number.isFinite(clientId) || clientId <= 0)) {
    throw new Error("La orden tiene dinero involucrado, pero no tiene cliente asociado.");
  }
  if (
    hasConfirmedMoney &&
    input.paidHandling !== "store_fund" &&
    input.paidHandling !== "refund"
  ) {
    throw new Error("Debes decidir si el pago confirmado se guarda en fondo o se devuelve.");
  }

  let refundLines: MasterOpsValidatedMoneyLine[] = [];
  if (hasConfirmedMoney && input.paidHandling === "refund") {
    refundLines = await validateMasterOpsMoneyLines(
      supabase,
      input.refundLines ?? [],
      reason,
      "devolucion"
    );
    const refundUsd = roundOpsMoney(refundLines.reduce((sum, line) => sum + line.amountUsd, 0));
    if (Math.abs(refundUsd - confirmedMoneyUsd) > 0.01) {
      throw new Error(
        `La devolucion debe coincidir con el pago confirmado de ${confirmedMoneyUsd.toFixed(2)} USD.`
      );
    }
  }

  return cancelOrderAction({
    orderId,
    reason,
    paidHandling: hasConfirmedMoney ? input.paidHandling ?? null : null,
    refundLines: refundLines.map((line) => ({
      moneyAccountId: line.moneyAccountId,
      currencyCode: line.currencyCode,
      amount: line.amount,
      exchangeRateVesPerUsd: line.exchangeRateVesPerUsd,
      notes: line.notes,
    })),
  });
}

export async function updateMasterOpsExchangeRateAction(input: {
  rateBsPerUsd: number;
}) {
  await requireMasterOrAdminContext();
  const rateBsPerUsd = Number(input.rateBsPerUsd);
  if (!Number.isFinite(rateBsPerUsd) || rateBsPerUsd <= 0) {
    throw new Error("La tasa debe ser mayor a 0.");
  }

  return updateExchangeRateAction({ rateBsPerUsd });
}

type RawRelatedProduct =
  | {
      id: number | string | null;
      sku: string | null;
      name: string | null;
      type: string | null;
    }
  | Array<{
      id: number | string | null;
      sku: string | null;
      name: string | null;
      type: string | null;
    }>
  | null;

type RawOrderEditRow = {
  id: number | string;
  client_id: number | string | null;
  attributed_advisor_id: string | null;
  source: "advisor" | "master" | "walk_in";
  status: string;
  fulfillment: "pickup" | "delivery";
  delivery_address: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  notes: string | null;
  created_at: string;
  last_modified_at: string | null;
  extra_fields: any;
  client:
    | {
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        client_type: string | null;
        fund_balance_usd: number | string | null;
        recent_addresses: any;
        billing_company_name: string | null;
        billing_tax_id: string | null;
        billing_address: string | null;
        billing_phone: string | null;
        delivery_note_name: string | null;
        delivery_note_document_id: string | null;
        delivery_note_address: string | null;
        delivery_note_phone: string | null;
      }
    | Array<{
        id: number | string | null;
        full_name: string | null;
        phone: string | null;
        client_type: string | null;
        fund_balance_usd: number | string | null;
        recent_addresses: any;
        billing_company_name: string | null;
        billing_tax_id: string | null;
        billing_address: string | null;
        billing_phone: string | null;
        delivery_note_name: string | null;
        delivery_note_document_id: string | null;
        delivery_note_address: string | null;
        delivery_note_phone: string | null;
      }>
    | null;
};

type RawOrderItemEditRow = {
  id: number | string;
  order_id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  pricing_origin_currency: string | null;
  pricing_origin_amount: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  admin_price_override_usd: number | string | null;
  admin_price_override_reason: string | null;
  admin_price_override_by_user_id: string | null;
  admin_price_override_at: string | null;
  product_name_snapshot: string | null;
  sku_snapshot: string | null;
  notes: string | null;
};

type RawOrderClientEditRow = {
  id: number | string | null;
  full_name: string | null;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd: number | string | null;
  recent_addresses: any;
  billing_company_name: string | null;
  billing_tax_id: string | null;
  billing_address: string | null;
  billing_phone: string | null;
  delivery_note_name: string | null;
  delivery_note_document_id: string | null;
  delivery_note_address: string | null;
  delivery_note_phone: string | null;
};

type RawCatalogEditRow = {
  id: number | string;
  sku: string | null;
  name: string | null;
  type: string | null;
  is_active: boolean | null;
  source_price_amount: number | string | null;
  source_price_currency: string | null;
  base_price_usd: number | string | null;
  base_price_bs: number | string | null;
  units_per_service: number | string | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | string | null;
  internal_rider_pay_usd: number | string | null;
};

type RawProductComponentEditRow = {
  id: number | string;
  parent_product_id: number | string;
  component_product_id: number | string;
  component_mode: string | null;
  quantity: number | string | null;
  counts_toward_detail_limit: boolean | null;
  is_required: boolean | null;
  sort_order: number | string | null;
  notes: string | null;
  component_product: RawRelatedProduct;
};

export type MasterOpsEditCurrency = "USD" | "VES";

export type MasterOpsEditCatalogItem = {
  id: number;
  sku: string | null;
  name: string;
  type: "product" | "combo" | "service" | "promo" | "gambit";
  isActive: boolean;
  sourcePriceAmount: number;
  sourcePriceCurrency: MasterOpsEditCurrency;
  basePriceUsd: number;
  basePriceBs: number;
  unitsPerService: number;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  internalRiderPayUsd: number | null;
};

export type MasterOpsEditProductComponent = {
  id: number;
  parentProductId: number;
  componentProductId: number;
  componentMode: "fixed" | "selectable";
  quantity: number;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
  sortOrder: number;
  notes: string | null;
  componentSku: string | null;
  componentName: string;
  componentType: "product" | "combo" | "service" | "promo" | "gambit";
};

export type MasterOpsEditClient = {
  id: number;
  fullName: string;
  phone: string;
  clientType: "assigned" | "own" | "legacy";
  fundBalanceUsd: number;
  recentAddresses: any[];
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
};

export type MasterOpsEditAdvisor = {
  id: string;
  fullName: string;
};

export type MasterOpsEditOrderItem = {
  localId: string;
  productId: number;
  skuSnapshot: string | null;
  productNameSnapshot: string;
  qty: number;
  sourcePriceCurrency: MasterOpsEditCurrency;
  sourcePriceAmount: number;
  unitPriceUsdSnapshot: number;
  lineTotalUsd: number;
  editableDetailLines: string[];
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideCurrency: MasterOpsEditCurrency | null;
  adminPriceOverrideReason: string | null;
  adminPriceOverrideByUserId: string | null;
  adminPriceOverrideAt: string | null;
};

export type MasterOpsEditOrder = {
  id: number;
  orderNumber: string;
  status: string;
  source: "advisor" | "master" | "walk_in";
  attributedAdvisorUserId: string | null;
  fulfillment: "pickup" | "delivery";
  selectedClientId: number | null;
  client: MasterOpsEditClient | null;
  deliveryDate: string;
  deliveryHour12: string;
  deliveryMinute: string;
  deliveryAmPm: "AM" | "PM";
  isAsap: boolean;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  note: string;
  discountEnabled: boolean;
  discountPct: string;
  invoiceTaxPct: string;
  fxRate: string;
  paymentMethod: string;
  paymentCurrency: MasterOpsEditCurrency;
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: MasterOpsEditCurrency;
  paymentNote: string;
  useClientFund: boolean;
  clientFundAmountUsd: string;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  lastModifiedAtISO: string | null;
  items: MasterOpsEditOrderItem[];
};

export type MasterOpsEditData = {
  order: MasterOpsEditOrder;
  catalogItems: MasterOpsEditCatalogItem[];
  productComponents: MasterOpsEditProductComponent[];
  advisors: MasterOpsEditAdvisor[];
  activeRate: number | null;
};

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asCurrency(value: unknown, fallback: MasterOpsEditCurrency = "USD"): MasterOpsEditCurrency {
  return String(value || "").toUpperCase() === "VES" ? "VES" : fallback;
}

function cleanText(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function one<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isDateKey(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getCaracasDateKey(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  }
  return date.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

function splitScheduleFields(extraFields: any, fallbackISO: string) {
  const schedule = extraFields?.schedule ?? {};
  const date = isDateKey(schedule.date) ? schedule.date : getCaracasDateKey(fallbackISO);
  const time24 = String(schedule.time_24 || "").trim();
  const time12 = String(schedule.time_12 || "").trim();
  let hour24: number | null = null;
  let minute = "00";

  const time24Match = time24.match(/^(\d{1,2}):(\d{2})$/);
  if (time24Match) {
    const parsedHour = Number(time24Match[1]);
    if (Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      hour24 = parsedHour;
      minute = time24Match[2];
    }
  }

  if (hour24 == null) {
    const time12Match = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (time12Match) {
      const parsedHour12 = Number(time12Match[1]);
      const parsedMinute = time12Match[2];
      const parsedAmPm = time12Match[3].toUpperCase() as "AM" | "PM";
      if (Number.isFinite(parsedHour12) && parsedHour12 >= 1 && parsedHour12 <= 12) {
        hour24 = parsedAmPm === "AM" ? parsedHour12 % 12 : (parsedHour12 % 12) + 12;
        minute = parsedMinute;
      }
    }
  }

  if (hour24 == null) {
    hour24 = 12;
  }

  const amPm: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return {
    deliveryDate: date,
    deliveryHour12: String(hour12).padStart(2, "0"),
    deliveryMinute: minute,
    deliveryAmPm: amPm,
    isAsap: Boolean(schedule.asap ?? false),
  };
}

function normalizeClientType(value: unknown): "assigned" | "own" | "legacy" {
  const clientType = String(value || "").trim();
  if (clientType === "own" || clientType === "legacy") return clientType;
  return "assigned";
}

function normalizeProductType(value: unknown): "product" | "combo" | "service" | "promo" | "gambit" {
  const type = String(value || "").trim();
  if (type === "combo" || type === "service" || type === "promo" || type === "gambit") return type;
  return "product";
}

function mapClient(client: RawOrderClientEditRow): MasterOpsEditClient {
  return {
    id: Number(client.id),
    fullName: cleanText(client.full_name, "Cliente"),
    phone: cleanText(client.phone),
    clientType: normalizeClientType(client.client_type),
    fundBalanceUsd: toNumber(client.fund_balance_usd, 0),
    recentAddresses: Array.isArray(client.recent_addresses) ? client.recent_addresses : [],
    billingCompanyName: cleanText(client.billing_company_name),
    billingTaxId: cleanText(client.billing_tax_id),
    billingAddress: cleanText(client.billing_address),
    billingPhone: cleanText(client.billing_phone),
    deliveryNoteName: cleanText(client.delivery_note_name),
    deliveryNoteDocumentId: cleanText(client.delivery_note_document_id),
    deliveryNoteAddress: cleanText(client.delivery_note_address),
    deliveryNotePhone: cleanText(client.delivery_note_phone),
  };
}

function getRelatedProduct(value: RawRelatedProduct) {
  return one(value);
}

function getDefaultScheduleFields(focusDateInput?: string | null) {
  const now = new Date();
  const date = isDateKey(focusDateInput)
    ? String(focusDateInput)
    : now.toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Caracas",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "12";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const dayPeriod = (parts.find((part) => part.type === "dayPeriod")?.value ?? "PM").toUpperCase();

  return {
    deliveryDate: date,
    deliveryHour12: hour.padStart(2, "0"),
    deliveryMinute: minute.padStart(2, "0"),
    deliveryAmPm: dayPeriod === "AM" ? ("AM" as const) : ("PM" as const),
    isAsap: false,
  };
}

async function loadMasterOpsOrderComposerLookups(
  ctx: Awaited<ReturnType<typeof requireMasterOrAdminContext>>
) {
  const [productsResult, productComponentsResult, advisorsResult, activeRateResult] = await Promise.all([
    ctx.supabase
      .from("products")
      .select(
        `
        id,
        sku,
        name,
        type,
        is_active,
        source_price_amount,
        source_price_currency,
        base_price_usd,
        base_price_bs,
        units_per_service,
        is_detail_editable,
        detail_units_limit,
        internal_rider_pay_usd
      `
      )
      .eq("is_active", true)
      .order("name", { ascending: true })
      .limit(700),
    ctx.supabase
      .from("product_components")
      .select(
        `
        id,
        parent_product_id,
        component_product_id,
        component_mode,
        quantity,
        counts_toward_detail_limit,
        is_required,
        sort_order,
        notes,
        component_product:products!product_components_component_product_id_fkey (
          id,
          sku,
          name,
          type
        )
      `
      )
      .order("parent_product_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(2000),
    ctx.supabase.rpc("get_advisor_profiles"),
    ctx.supabase
      .from("exchange_rates")
      .select("rate_bs_per_usd")
      .eq("is_active", true)
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const error =
    productsResult.error ??
    productComponentsResult.error ??
    advisorsResult.error ??
    activeRateResult.error;

  if (error) {
    throw new Error(error.message);
  }

  const catalogItems = ((productsResult.data ?? []) as RawCatalogEditRow[])
    .map((product) => ({
      id: Number(product.id),
      sku: product.sku ?? null,
      name: cleanText(product.name, `Producto #${product.id}`),
      type: normalizeProductType(product.type),
      isActive: product.is_active !== false,
      sourcePriceAmount: toNumber(product.source_price_amount, 0),
      sourcePriceCurrency: asCurrency(product.source_price_currency, "USD"),
      basePriceUsd: toNumber(product.base_price_usd, 0),
      basePriceBs: toNumber(product.base_price_bs, 0),
      unitsPerService: toNumber(product.units_per_service, 0),
      isDetailEditable: Boolean(product.is_detail_editable),
      detailUnitsLimit: toNumber(product.detail_units_limit, 0),
      internalRiderPayUsd:
        product.internal_rider_pay_usd == null ? null : toNumber(product.internal_rider_pay_usd, 0),
    }))
    .filter((product) => Number.isFinite(product.id) && product.id > 0);

  const productComponents = ((productComponentsResult.data ?? []) as RawProductComponentEditRow[])
    .map((component) => {
      const related = getRelatedProduct(component.component_product);
      return {
        id: Number(component.id),
        parentProductId: Number(component.parent_product_id),
        componentProductId: Number(component.component_product_id),
        componentMode: component.component_mode === "selectable" ? ("selectable" as const) : ("fixed" as const),
        quantity: toNumber(component.quantity, 0),
        countsTowardDetailLimit: component.counts_toward_detail_limit !== false,
        isRequired: component.is_required !== false,
        sortOrder: toNumber(component.sort_order, 0),
        notes: component.notes ?? null,
        componentSku: related?.sku ?? null,
        componentName: cleanText(related?.name, `Componente #${component.component_product_id}`),
        componentType: normalizeProductType(related?.type),
      };
    })
    .filter(
      (component) =>
        Number.isFinite(component.id) &&
        Number.isFinite(component.parentProductId) &&
        Number.isFinite(component.componentProductId)
    );

  const advisors = ((advisorsResult.data ?? []) as Array<{ user_id: string | null; full_name: string | null; is_active: boolean | null }>)
    .filter((advisor) => advisor.is_active !== false)
    .map((advisor) => ({
      id: String(advisor.user_id || ""),
      fullName: cleanText(advisor.full_name, "Asesor"),
    }))
    .filter((advisor) => advisor.id.trim())
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es-VE"));

  const activeRate =
    toNumber(activeRateResult.data?.rate_bs_per_usd, 0) > 0
      ? toNumber(activeRateResult.data?.rate_bs_per_usd, 0)
      : null;

  return {
    catalogItems,
    productComponents,
    advisors,
    activeRate,
  };
}

export async function loadMasterOpsOrderCreateDataAction(
  focusDateInput?: string | null
): Promise<MasterOpsEditData> {
  const ctx = await requireMasterOrAdminContext();
  const lookups = await loadMasterOpsOrderComposerLookups(ctx);
  const schedule = getDefaultScheduleFields(focusDateInput);

  return {
    order: {
      id: 0,
      orderNumber: "",
      status: "created",
      source: "master",
      attributedAdvisorUserId: null,
      fulfillment: "pickup",
      selectedClientId: null,
      client: null,
      ...schedule,
      receiverName: "",
      receiverPhone: "",
      deliveryAddress: "",
      deliveryGpsUrl: "",
      note: "",
      discountEnabled: false,
      discountPct: "0",
      invoiceTaxPct: "16",
      fxRate: lookups.activeRate ? String(lookups.activeRate) : "",
      paymentMethod: "",
      paymentCurrency: "USD",
      paymentRequiresChange: false,
      paymentChangeFor: "",
      paymentChangeCurrency: "USD",
      paymentNote: "",
      useClientFund: false,
      clientFundAmountUsd: "",
      hasDeliveryNote: false,
      hasInvoice: false,
      invoiceCompanyName: "",
      invoiceTaxId: "",
      invoiceAddress: "",
      invoicePhone: "",
      deliveryNoteName: "",
      deliveryNoteDocumentId: "",
      deliveryNoteAddress: "",
      deliveryNotePhone: "",
      lastModifiedAtISO: null,
      items: [],
    },
    ...lookups,
  };
}

export async function loadMasterOpsOrderEditDataAction(orderIdInput: number): Promise<MasterOpsEditData> {
  const ctx = await requireMasterOrAdminContext();
  const orderId = Number(orderIdInput);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error("Orden invalida.");
  }

  const [
    orderResult,
    orderItemsResult,
    productsResult,
    productComponentsResult,
    advisorsResult,
    activeRateResult,
  ] = await Promise.all([
    ctx.supabase
      .from("orders")
      .select(
        `
        id,
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
        last_modified_at,
        extra_fields,
        client:clients!orders_client_id_fkey (
          id,
          full_name,
          phone,
          client_type,
          fund_balance_usd,
          recent_addresses,
          billing_company_name,
          billing_tax_id,
          billing_address,
          billing_phone,
          delivery_note_name,
          delivery_note_document_id,
          delivery_note_address,
          delivery_note_phone
        )
      `
      )
      .eq("id", orderId)
      .single(),
    ctx.supabase
      .from("order_items")
      .select(
        `
        id,
        order_id,
        product_id,
        qty,
        pricing_origin_currency,
        pricing_origin_amount,
        unit_price_usd_snapshot,
        line_total_usd,
        admin_price_override_usd,
        admin_price_override_reason,
        admin_price_override_by_user_id,
        admin_price_override_at,
        product_name_snapshot,
        sku_snapshot,
        notes
      `
      )
      .eq("order_id", orderId)
      .order("id", { ascending: true }),
    ctx.supabase
      .from("products")
      .select(
        `
        id,
        sku,
        name,
        type,
        is_active,
        source_price_amount,
        source_price_currency,
        base_price_usd,
        base_price_bs,
        units_per_service,
        is_detail_editable,
        detail_units_limit,
        internal_rider_pay_usd
      `
      )
      .eq("is_active", true)
      .order("name", { ascending: true })
      .limit(700),
    ctx.supabase
      .from("product_components")
      .select(
        `
        id,
        parent_product_id,
        component_product_id,
        component_mode,
        quantity,
        counts_toward_detail_limit,
        is_required,
        sort_order,
        notes,
        component_product:products!product_components_component_product_id_fkey (
          id,
          sku,
          name,
          type
        )
      `
      )
      .order("parent_product_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(2000),
    ctx.supabase.rpc("get_advisor_profiles"),
    ctx.supabase
      .from("exchange_rates")
      .select("rate_bs_per_usd")
      .eq("is_active", true)
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const error =
    orderResult.error ??
    orderItemsResult.error ??
    productsResult.error ??
    productComponentsResult.error ??
    advisorsResult.error ??
    activeRateResult.error;

  if (error) {
    throw new Error(error.message);
  }

  const orderRow = orderResult.data as RawOrderEditRow;
  const clientRow = one(orderRow.client);
  const client = clientRow ? mapClient(clientRow as any) : null;
  const schedule = splitScheduleFields(orderRow.extra_fields, orderRow.created_at);
  const extraFields = orderRow.extra_fields ?? {};
  const pricing = extraFields.pricing ?? {};
  const payment = extraFields.payment ?? {};
  const documents = extraFields.documents ?? {};
  const invoiceSnapshot = documents.invoice_snapshot ?? {};
  const deliveryNoteSnapshot = documents.delivery_note_snapshot ?? {};

  const catalogItems = ((productsResult.data ?? []) as RawCatalogEditRow[])
    .map((product) => ({
      id: Number(product.id),
      sku: product.sku ?? null,
      name: cleanText(product.name, `Producto #${product.id}`),
      type: normalizeProductType(product.type),
      isActive: product.is_active !== false,
      sourcePriceAmount: toNumber(product.source_price_amount, 0),
      sourcePriceCurrency: asCurrency(product.source_price_currency, "USD"),
      basePriceUsd: toNumber(product.base_price_usd, 0),
      basePriceBs: toNumber(product.base_price_bs, 0),
      unitsPerService: toNumber(product.units_per_service, 0),
      isDetailEditable: Boolean(product.is_detail_editable),
      detailUnitsLimit: toNumber(product.detail_units_limit, 0),
      internalRiderPayUsd:
        product.internal_rider_pay_usd == null ? null : toNumber(product.internal_rider_pay_usd, 0),
    }))
    .filter((product) => Number.isFinite(product.id) && product.id > 0);

  const productComponents = ((productComponentsResult.data ?? []) as RawProductComponentEditRow[])
    .map((component) => {
      const related = getRelatedProduct(component.component_product);
      return {
        id: Number(component.id),
        parentProductId: Number(component.parent_product_id),
        componentProductId: Number(component.component_product_id),
        componentMode: component.component_mode === "selectable" ? ("selectable" as const) : ("fixed" as const),
        quantity: toNumber(component.quantity, 0),
        countsTowardDetailLimit: component.counts_toward_detail_limit !== false,
        isRequired: component.is_required !== false,
        sortOrder: toNumber(component.sort_order, 0),
        notes: component.notes ?? null,
        componentSku: related?.sku ?? null,
        componentName: cleanText(related?.name, `Componente #${component.component_product_id}`),
        componentType: normalizeProductType(related?.type),
      };
    })
    .filter(
      (component) =>
        Number.isFinite(component.id) &&
        Number.isFinite(component.parentProductId) &&
        Number.isFinite(component.componentProductId)
    );

  const advisors = ((advisorsResult.data ?? []) as Array<{ user_id: string | null; full_name: string | null; is_active: boolean | null }>)
    .filter((advisor) => advisor.is_active !== false)
    .map((advisor) => ({
      id: String(advisor.user_id || ""),
      fullName: cleanText(advisor.full_name, "Asesor"),
    }))
    .filter((advisor) => advisor.id.trim())
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es-VE"));

  const fxRate = toNumber(pricing.fx_rate, toNumber(activeRateResult.data?.rate_bs_per_usd, 0));

  const items = ((orderItemsResult.data ?? []) as RawOrderItemEditRow[]).map((item) => {
    const sourcePriceCurrency = asCurrency(item.pricing_origin_currency, "USD");
    const sourcePriceAmount = toNumber(
      item.pricing_origin_amount,
      sourcePriceCurrency === "VES" ? 0 : toNumber(item.unit_price_usd_snapshot, 0)
    );
    const adminPriceOverrideUsd =
      item.admin_price_override_usd == null ? null : toNumber(item.admin_price_override_usd, 0);

    return {
      localId: `db-${item.id}`,
      productId: Number(item.product_id || 0),
      skuSnapshot: item.sku_snapshot ?? null,
      productNameSnapshot: cleanText(item.product_name_snapshot, "Producto"),
      qty: toNumber(item.qty, 0),
      sourcePriceCurrency,
      sourcePriceAmount,
      unitPriceUsdSnapshot: toNumber(item.unit_price_usd_snapshot, 0),
      lineTotalUsd: toNumber(item.line_total_usd, 0),
      editableDetailLines: String(item.notes || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      adminPriceOverrideUsd,
      adminPriceOverrideCurrency: adminPriceOverrideUsd == null ? null : sourcePriceCurrency,
      adminPriceOverrideReason: item.admin_price_override_reason ?? null,
      adminPriceOverrideByUserId: item.admin_price_override_by_user_id ?? null,
      adminPriceOverrideAt: item.admin_price_override_at ?? null,
    };
  });

  return {
    order: {
      id: Number(orderRow.id),
      orderNumber: String(orderRow.id),
      status: orderRow.status,
      source: orderRow.source,
      attributedAdvisorUserId: orderRow.attributed_advisor_id ?? null,
      fulfillment: orderRow.fulfillment,
      selectedClientId: client?.id ?? (orderRow.client_id == null ? null : Number(orderRow.client_id)),
      client,
      ...schedule,
      receiverName: cleanText(extraFields.receiver?.name, cleanText(orderRow.receiver_name)),
      receiverPhone: cleanText(extraFields.receiver?.phone, cleanText(orderRow.receiver_phone)),
      deliveryAddress: cleanText(extraFields.delivery?.address, cleanText(orderRow.delivery_address)),
      deliveryGpsUrl: cleanText(extraFields.delivery?.gps_url),
      note: cleanText(extraFields.note, cleanText(orderRow.notes)),
      discountEnabled: Boolean(pricing.discount_enabled ?? toNumber(pricing.discount_pct, 0) > 0),
      discountPct: cleanText(pricing.discount_pct, "0"),
      invoiceTaxPct: cleanText(pricing.invoice_tax_pct, "16"),
      fxRate: fxRate > 0 ? String(fxRate) : "",
      paymentMethod: cleanText(payment.method),
      paymentCurrency: asCurrency(payment.currency, "USD"),
      paymentRequiresChange: Boolean(payment.requires_change ?? false),
      paymentChangeFor: payment.change_for == null ? "" : String(payment.change_for),
      paymentChangeCurrency: asCurrency(payment.change_currency, "USD"),
      paymentNote: cleanText(payment.notes),
      useClientFund: toNumber(payment.client_fund_used_usd, 0) > 0.005,
      clientFundAmountUsd: toNumber(payment.client_fund_used_usd, 0) > 0 ? String(toNumber(payment.client_fund_used_usd, 0)) : "",
      hasDeliveryNote: Boolean(documents.has_delivery_note ?? false),
      hasInvoice: Boolean(documents.has_invoice ?? false),
      invoiceCompanyName: cleanText(invoiceSnapshot.company_name, client?.billingCompanyName ?? ""),
      invoiceTaxId: cleanText(invoiceSnapshot.tax_id, client?.billingTaxId ?? ""),
      invoiceAddress: cleanText(invoiceSnapshot.address, client?.billingAddress ?? ""),
      invoicePhone: cleanText(invoiceSnapshot.phone, client?.billingPhone ?? ""),
      deliveryNoteName: cleanText(deliveryNoteSnapshot.name, client?.deliveryNoteName ?? ""),
      deliveryNoteDocumentId: cleanText(deliveryNoteSnapshot.document_id, client?.deliveryNoteDocumentId ?? ""),
      deliveryNoteAddress: cleanText(deliveryNoteSnapshot.address, client?.deliveryNoteAddress ?? ""),
      deliveryNotePhone: cleanText(deliveryNoteSnapshot.phone, client?.deliveryNotePhone ?? ""),
      lastModifiedAtISO: orderRow.last_modified_at ?? null,
      items,
    },
    catalogItems,
    productComponents,
    advisors,
    activeRate: toNumber(activeRateResult.data?.rate_bs_per_usd, 0) > 0 ? toNumber(activeRateResult.data?.rate_bs_per_usd, 0) : null,
  };
}
