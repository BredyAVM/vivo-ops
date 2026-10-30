"use server";
import { countsTowardCrmMinimum } from "@/lib/crm/benefit-eligibility";
import { verifyMuerdemeOrderItems } from "@/lib/brands/order-menu-save";
import { readMenuOrderQuote } from "@/lib/brands/order-menu";
import type {RewardOrderFunding} from '@/components/rewards/RewardOrderBadge';

import { revalidatePath } from "next/cache";
import { isCrmOnlyCatalogProduct } from "@/lib/crm/play-order";
import { inventoryUnitLabel } from "@/app/app/inventory/display";
import { requireMasterOrAdminContext } from "@/lib/auth";
import { paymentActionFailure } from "@/lib/payments/action-result";
import { loadMasterCrmOrderContext } from "@/lib/crm/advisor-order-context";
import { resolveCrmOrderBenefit, validateMasterCrmBenefitSelection } from "@/lib/crm/master-order-benefit";
import {
  mapOrderFinancialActivity,
  type OrderFinancialActivity,
} from "@/lib/finance/order-financial-activity";
import { getVisibleEditableDetailLines } from "@/lib/orders/order-composer";
import {
  sanitizeOrderChangeDetails,
  type OrderChangeDetail,
} from "@/lib/orders/order-change-detail";
import { getPaymentReportCurrency } from "@/lib/payments/payment-report-rules";
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from "@/lib/pricing/order-snapshots";
import { APPROVED_PRICE_CHANGE_MESSAGE, hasUnauthorizedPriceChange, preservedApprovedPriceSnapshot, storedApprovedPriceLine } from "@/lib/orders/approved-price-preservation";
import { preservedAgreedPriceSnapshot, preservedOperationalSnapshot } from "@/lib/orders/operational-edit-pricing";
import {
  cancelOrderAction,
  closeOrderRoundingBalanceAction,
  confirmPaymentReportAction,
  createOrderAction,
  searchMasterOrdersAction,
  settleClientFundPayoutAction,
  updateExchangeRateAction,
  updateOrderAction,
} from "../dashboard/actions";
import type {
  MasterOrderAdminAdjustment,
  MasterOrderDetailLine,
  MasterOrderEvent,
  MasterOrderPaymentReport,
} from "../_components/MasterOrderDetailCore";
import { getMasterOpsOrderEditorValidationIssues } from "./order-editor-validation";
import { buildRepeatedMasterOpsOrder, type RepeatOrderSource } from "./order-repeat";
import {
  isMasterOpsOrderPaymentMethod,
  normalizeMasterOpsOrderPaymentMethod,
} from "./order-editor-payment";
import { canEditMasterOpsOrder } from "./operational-rules";
import { prepareEditorCommissionFields, readEditorCommissionFields, type EditorCommissionFields, type EditorCommissionProduct } from "./order-editor-commission";
import type {
  CounterPickupChangeDecisionResult,
  CounterPickupChangePreviewItem,
  CounterPickupChangeRequest,
} from "../../counter/pickup-contract";

const MASTER_OPS_OVERPAYMENT_ROUNDING_MAX_USD = 1;
const MASTER_OPS_DETAIL_ITEM_RETRY_DELAYS_MS = [120, 320] as const;

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

export type MasterOpsOrderDetailPayload = {
  integrityStatus: "complete" | "missing_items";
  lines: MasterOrderDetailLine[];
  paymentReports: MasterOrderPaymentReport[];
  financialActivity: OrderFinancialActivity[];
  events: MasterOrderEvent[];
  changes: MasterOpsOrderChangeEvent[];
  adminAdjustments: MasterOrderAdminAdjustment[];
  pickupChangeRequests: CounterPickupChangeRequest[];
  inventory: MasterOpsOrderInventoryPreview;
};

export type MasterOpsOrderChangeEvent = {
  id: string;
  title: string;
  message: string | null;
  actorName: string;
  createdAt: string;
  details: OrderChangeDetail[];
  isDetailed: boolean;
};

export type MasterOpsOrderInventoryLine = {
  itemId: number;
  itemName: string;
  unitName: string;
  status: string;
  requestedUnits: number;
  onHandUnits: number | null;
  availableUnits: number | null;
  availableWithoutIncomingUnits: number | null;
  shortageUnits: number | null;
  committedThroughTargetUnits: number | null;
  committedHorizonUnits: number | null;
  incomingThroughTargetUnits: number | null;
  reliesOnIncoming: boolean;
  declaredUnavailable: boolean;
  unavailableUntil: string | null;
  unavailabilityNotes: string | null;
};

export type MasterOpsOrderInventoryRouteLine = {
  itemId: number;
  itemName: string;
  unitName: string;
  requestedUnits: number;
  onHandUnits: number | null;
  availableUnits: number | null;
};

export type MasterOpsOrderInventoryRoute = {
  key: string;
  name: string;
  mode: "primary" | "master_fallback";
  selected: boolean;
  decision: string;
  lines: MasterOpsOrderInventoryRouteLine[];
};

export type MasterOpsOrderInventoryRouteOption = {
  orderItemId: number;
  productId: number;
  productName: string;
  selectedRouteKey: string;
  routes: MasterOpsOrderInventoryRoute[];
};

export type MasterOpsOrderInventoryPreview = {
  status: "ready" | "unavailable";
  decision:
    | "available"
    | "insufficient"
    | "relies_on_incoming"
    | "outside_horizon"
    | "requires_opening"
    | "no_inventory_effect"
    | "unknown";
  calculatedAt: string | null;
  effectiveAt: string | null;
  horizonDays: number;
  horizonEndsAt: string | null;
  lines: MasterOpsOrderInventoryLine[];
  routeOptions: MasterOpsOrderInventoryRouteOption[];
  message: string | null;
};

type MasterOpsDetailItemRow = {
  id: number;
  product_id: number | string | null;
  qty: number | string | null;
  unit_price_bs_snapshot: number | string | null;
  pricing_origin_currency: string | null;
  line_total_bs_snapshot: number | string | null;
  line_total_usd: number | string | null;
  product_name_snapshot: string | null;
  notes: string | null;
};

type MasterOpsCrmRedemptionRow = {
  order_item_id: number | string | null;
  status: 'reserved' | 'redeemed';
  play_name_snapshot: string | null;
  benefit_credit_usd: number | string | null;
  customer_paid_difference_usd: number | string | null;
};

type MasterOpsDetailPaymentRow = {
  id: number;
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

type MasterOpsDetailEventRow = {
  id: number | string;
  event_type: string | null;
  title: string | null;
  message: string | null;
  severity: "info" | "warning" | "critical" | null;
  actor_user_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type MasterOpsDetailAdjustmentRow = {
  payload_kind: string | null;
  balance_adjustment_usd: number | string | null;
  id: number;
  adjustment_type: string | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
  created_by_user_id: string | null;
};

function asOpsArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalOpsNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapMasterOpsOrderInventoryPreview(
  value: unknown,
  errorMessage: string | null
): MasterOpsOrderInventoryPreview {
  if (errorMessage) {
    return {
      status: "unavailable",
      decision: "unknown",
      calculatedAt: null,
      effectiveAt: null,
      horizonDays: 10,
      horizonEndsAt: null,
      lines: [],
      routeOptions: [],
      message: "La lectura de inventario no estuvo disponible. La orden puede continuar normalmente.",
    };
  }

  const preview = asOpsRecord(value);
  const rawDecision = String(preview.decision || "unknown");
  const decision: MasterOpsOrderInventoryPreview["decision"] = [
    "available",
    "insufficient",
    "relies_on_incoming",
    "outside_horizon",
    "requires_opening",
    "no_inventory_effect",
  ].includes(rawDecision)
    ? rawDecision as MasterOpsOrderInventoryPreview["decision"]
    : "unknown";

  const lines = asOpsArray(preview.lines).map((value): MasterOpsOrderInventoryLine => {
    const line = asOpsRecord(value);
    return {
      itemId: Math.trunc(Number(line.inventory_item_id || 0)),
      itemName: cleanText(line.inventory_item_name, "Ítem de inventario"),
      unitName: inventoryUnitLabel(String(line.unit_name || "unidad")),
      status: cleanText(line.status, "unknown"),
      requestedUnits: optionalOpsNumber(line.requested_quantity_units) ?? 0,
      onHandUnits: optionalOpsNumber(line.on_hand_units),
      availableUnits: optionalOpsNumber(line.available_without_affecting_commitments),
      availableWithoutIncomingUnits: optionalOpsNumber(line.available_without_incoming),
      shortageUnits: optionalOpsNumber(line.shortage_quantity_units),
      committedThroughTargetUnits: optionalOpsNumber(line.committed_through_target),
      committedHorizonUnits: optionalOpsNumber(line.committed_through_horizon),
      incomingThroughTargetUnits: optionalOpsNumber(line.incoming_through_target),
      reliesOnIncoming: Boolean(line.relies_on_incoming),
      declaredUnavailable: Boolean(line.declared_unavailable),
      unavailableUntil: line.unavailable_until ? String(line.unavailable_until) : null,
      unavailabilityNotes: line.unavailability_notes
        ? cleanText(line.unavailability_notes)
        : null,
    };
  });

  return {
    status: "ready",
    decision,
    calculatedAt: preview.calculated_at ? String(preview.calculated_at) : null,
    effectiveAt: preview.effective_at ? String(preview.effective_at) : null,
    horizonDays: Math.max(1, Math.trunc(Number(preview.horizon_days || 10))),
    horizonEndsAt: preview.horizon_ends_at ? String(preview.horizon_ends_at) : null,
    lines,
    routeOptions: [],
    message: null,
  };
}

function mapMasterOpsOrderInventoryRouteOptions(value: unknown): MasterOpsOrderInventoryRouteOption[] {
  const payload = asOpsRecord(value);
  return asOpsArray(payload.options).map((optionValue) => {
    const option = asOpsRecord(optionValue);
    return {
      orderItemId: Math.trunc(Number(option.order_item_id || 0)),
      productId: Math.trunc(Number(option.product_id || 0)),
      productName: cleanText(option.product_name, "Producto"),
      selectedRouteKey: cleanText(option.selected_route_key, "primary"),
      routes: asOpsArray(option.routes).map((routeValue) => {
        const route = asOpsRecord(routeValue);
        return {
          key: cleanText(route.key),
          name: cleanText(route.name, "Ruta física"),
          mode: route.mode === "master_fallback" ? "master_fallback" : "primary",
          selected: Boolean(route.selected),
          decision: cleanText(route.decision, "unknown"),
          lines: asOpsArray(route.lines).map((lineValue) => {
            const line = asOpsRecord(lineValue);
            return {
              itemId: Math.trunc(Number(line.inventory_item_id || 0)),
              itemName: cleanText(line.inventory_item_name, "Ítem de inventario"),
              unitName: inventoryUnitLabel(String(line.unit_name || "unidad")),
              requestedUnits: optionalOpsNumber(line.requested_quantity_units) ?? 0,
              onHandUnits: optionalOpsNumber(line.on_hand_units),
              availableUnits: optionalOpsNumber(line.available_without_affecting_commitments),
            };
          }),
        };
      }),
    };
  });
}

function mapMasterOpsPickupPreviewItem(value: unknown): CounterPickupChangePreviewItem {
  const item = asOpsRecord(value);
  return {
    itemId: item.itemId == null ? null : Math.trunc(Number(item.itemId || 0)),
    productId: Math.trunc(Number(item.productId || 0)),
    name: cleanText(item.name, "Producto"),
    previousQty: item.previousQty == null ? null : Number(item.previousQty || 0),
    qty: Number(item.qty || 0),
    lineUsd: roundOpsMoney(item.lineUsd),
    lineBs: roundOpsMoney(item.lineBs),
    notes: item.notes == null ? null : String(item.notes),
  };
}

function extractMasterOpsUnitsPerService(name: string) {
  const match = name.match(/\((\d+(?:[.,]\d+)?)\s*(?:und|unidad|unidades|pzas?|piezas?)\)/i);
  if (!match) return 0;
  const units = Number(match[1].replace(",", "."));
  return Number.isFinite(units) && units > 0 ? units : 0;
}

function masterOpsAdjustmentLabel(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "item_price_override") return "Precio ajustado";
  if (normalized === "other") return "Ajuste administrativo";
  if (!normalized) return "Ajuste";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function loadMasterOpsOrderDetailAction(input: {
  orderId: number;
}): Promise<
  | { ok: true; detail: MasterOpsOrderDetailPayload }
  | { ok: false; message: string }
> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function selectMasterOpsOrderInventoryRouteAction(input: {
  orderItemId: number;
  routeKey: string;
}): Promise<
  | { ok: true; orderId: number; message: string }
  | { ok: false; message: string }
> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function decideCounterPickupChangeAction(input: {
  idempotencyKey: string;
  requestId: number;
  decision: "approve" | "reject";
  notes?: string | null;
}): Promise<CounterPickupChangeDecisionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function addMasterOpsOrderNoteAction(input: {
  orderId: number;
  note: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export type MasterOpsPaymentSuggestion = {
  pendingUsd: number;
  pendingBs: number | null;
  exchangeRate: number | null;
  activeRate: number | null;
  collectionMode: string | null;
  operationDate: string;
};

type MasterOpsPaymentSuggestionRow = {
  pending_usd: number | string | null;
  pending_bs: number | string | null;
  snapshot_rate_bs_per_usd: number | string | null;
  collection_mode: string | null;
  effective_operation_date: string | null;
};

export async function loadMasterOpsPaymentSuggestionAction(input: {
  orderId: number;
  operationDate: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function searchMasterOpsOrdersAction(input: {
  query: string;
  limit?: number;
}): Promise<MasterOpsOrderSearchResult[]> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export type MasterOpsPaymentConfirmationInput = {
  expectedChangeDebtUsd?: number;
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

export async function confirmMasterOpsPaymentReportAction(input: MasterOpsPaymentConfirmationInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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

function roundOpsMoney(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function asOpsRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
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
  requestId: string;
  expectedDifferenceUsd?: number;
  orderId: number;
  lines: MasterOpsMoneyLineInput[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function closeMasterOpsRoundingBalanceAction(
  input: Parameters<typeof closeOrderRoundingBalanceAction>[0]
) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelMasterOpsOrderAction(input: Parameters<typeof cancelOrderAction>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateMasterOpsExchangeRateAction(input: {
  rateBsPerUsd: number;
  operationId: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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
  is_price_locked: boolean | null;
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
        primary_advisor_id: string | null;
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
        primary_advisor_id: string | null;
      }>
    | null;
};

type RawOrderItemEditRow = {
  pricing_fx_rate_snapshot?: number | string | null;
  product?: EditorCommissionProduct | EditorCommissionProduct[] | null;
  id: number | string;
  order_id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  pricing_origin_currency: string | null;
  pricing_origin_amount: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  unit_price_bs_snapshot: number | string | null;
  line_total_bs_snapshot: number | string | null;
  admin_price_override_usd: number | string | null;
  admin_price_override_reason: string | null;
  admin_price_override_by_user_id: string | null;
  admin_price_override_at: string | null;
  product_name_snapshot: string | null;
  sku_snapshot: string | null;
  notes: string | null;
  crm_play_member_id: number | string | null;
  crm_play_benefit_id: number | string | null;
  crm_play_benefit_upgrade_id: number | string | null;
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
  primary_advisor_id: string | null;
};

type RawCatalogEditRow = {
  inventory_group?: string | null;
  commission_mode?: string | null;
  commission_value?: number | string | null;
  extra_fields?: Record<string, unknown> | null;
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
  inventoryGroup?: string | null;
  commissionInheritedMode?: EditorCommissionFields['commissionInheritedMode'];
  commissionInheritedValue?: number | null;
  discretionaryAllowed?: boolean;
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

export type MasterOpsAdvisorSuggestion = {
  userId: string;
  fullName: string;
  source: "primary" | "last_order";
  isActive: boolean;
};

export type MasterOpsEditOrderItem = EditorCommissionFields & {
  orderItemId: number | null;
  localId: string;
  productId: number;
  skuSnapshot: string | null;
  productNameSnapshot: string;
  qty: number;
  sourcePriceCurrency: MasterOpsEditCurrency;
  sourcePriceAmount: number;
  unitPriceUsdSnapshot: number;
  lineTotalUsd: number;
  unitPriceBsSnapshot?: number | null;
  lineTotalBsSnapshot?: number | null;
  pricingFxRateSnapshot?: number | null;
  editableDetailLines: string[];
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideCurrency: MasterOpsEditCurrency | null;
  adminPriceOverrideReason: string | null;
  adminPriceOverrideByUserId: string | null;
  adminPriceOverrideAt: string | null;
  crmPlayMemberId?: number | null;
  crmPlayBenefitId?: number | null;
  crmPlayBenefitUpgradeId?: number | null;
  crmRedemptionStatus?: 'reserved' | 'redeemed' | null;
  crmPlayName?: string | null;
};

export type MasterOpsEditOrder = {
  id: number;
  orderNumber: string;
  status: string;
  isPriceProtected: boolean;
  source: "advisor" | "master" | "walk_in";
  attributedAdvisorUserId: string | null;
  advisorSuggestion: MasterOpsAdvisorSuggestion | null;
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
  repeatSummary?: { sourceOrderId: number; skippedItems: string[] };
  order: MasterOpsEditOrder;
  catalogItems: MasterOpsEditCatalogItem[];
  productComponents: MasterOpsEditProductComponent[];
  advisors: MasterOpsEditAdvisor[];
  activeRate: number | null;
};

type DashboardCreateOrderInput = Parameters<typeof createOrderAction>[0];
type DashboardUpdateOrderInput = Parameters<typeof updateOrderAction>[0];

export type MasterOpsOrderSaveItem = DashboardCreateOrderInput["items"][number] & {
  orderItemId?: number | null;
  crmPlayMemberId?: number | null;
  crmPlayBenefitId?: number | null;
  crmPlayBenefitUpgradeId?: number | null;
};

export type MasterOpsOrderCreateInput = Omit<DashboardCreateOrderInput, "items"> & {
  items: MasterOpsOrderSaveItem[];
};

export type MasterOpsOrderUpdateInput = Omit<DashboardUpdateOrderInput, "items"> & {
  items: MasterOpsOrderSaveItem[];
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

function mapClient(client: Omit<RawOrderClientEditRow, "primary_advisor_id">): MasterOpsEditClient {
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

type MasterOpsSaveCatalogRow = EditorCommissionProduct & {
  id: number | string;
  sku: string | null;
  name: string | null;
  is_active: boolean | null;
  source_price_amount: number | string | null;
  source_price_currency: string | null;
  base_price_usd: number | string | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | string | null;
  internal_rider_pay_usd: number | string | null;
};

type MasterOpsSaveComponentRow = {
  parent_product_id: number | string;
  component_product_id: number | string;
  component_mode: string | null;
  is_required: boolean | null;
  counts_toward_detail_limit: boolean | null;
  component_product:
    | { name: string | null }
    | Array<{ name: string | null }>
    | null;
};

type MasterOpsExistingSaveItemRow = {
  reward_grant_id?: number | null;
  reward_purpose?: 'customer_gift' | 'personal_purchase' | null;
  reward_amount_usd?: number | string | null;
  pricing_fx_rate_snapshot?: number | string | null;
  id: number | string;
  product_id: number | string | null;
  qty: number | string | null;
  pricing_origin_currency: string | null;
  pricing_origin_amount: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  unit_price_bs_snapshot: number | string | null;
  line_total_bs_snapshot: number | string | null;
  admin_price_override_usd: number | string | null;
  admin_price_override_reason: string | null;
  product_name_snapshot: string | null;
  sku_snapshot: string | null;
  notes: string | null;
  crm_play_member_id: number | string | null;
  crm_play_benefit_id: number | string | null;
  crm_play_benefit_upgrade_id: number | string | null;
};

function closeNumber(left: unknown, right: unknown, tolerance = 0.000001) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? Math.abs(leftNumber - rightNumber) <= tolerance
    : false;
}

function normalizedDetailLines(value: unknown) {
  const lines = Array.isArray(value) ? value : String(value || "").split("\n");
  return lines.map((line) => String(line || "").trim()).filter(Boolean);
}

function sameDetailLines(left: unknown, right: unknown) {
  return JSON.stringify(normalizedDetailLines(left)) === JSON.stringify(normalizedDetailLines(right));
}

function readPricingRecord(extraFields: unknown) {
  const record = asOpsRecord(extraFields);
  return asOpsRecord(record.pricing);
}

function readDocumentsRecord(extraFields: unknown) {
  const record = asOpsRecord(extraFields);
  return asOpsRecord(record.documents);
}

async function loadMasterOpsOrderFinancialStateForValidation(
  supabase: unknown,
  orderId: number,
  activeRate: number
) {
  const rpcClient = supabase as {
    rpc: (
      name: "get_order_financial_state",
      args: {
        p_order_id: number;
        p_operation_date: null;
        p_active_bs_rate: number | null;
      }
    ) => Promise<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>;
  };
  return rpcClient.rpc("get_order_financial_state", {
    p_order_id: orderId,
    p_operation_date: null,
    p_active_bs_rate: activeRate > 0 ? activeRate : null,
  });
}

function stripMasterOpsOrderItem(item: MasterOpsOrderSaveItem): MasterOpsOrderSaveItem {
  return {
    rewardGrantId:item.rewardGrantId ?? null,
    rewardPurpose:item.rewardPurpose ?? null,
    rewardAmountUsd:item.rewardAmountUsd ?? null,
    orderItemId: item.orderItemId ?? null,
    productId: item.productId,
    skuSnapshot: item.skuSnapshot,
    productNameSnapshot: item.productNameSnapshot,
    qty: item.qty,
    sourcePriceCurrency: item.sourcePriceCurrency,
    sourcePriceAmount: item.sourcePriceAmount,
    unitPriceUsdSnapshot: item.unitPriceUsdSnapshot,
    lineTotalUsd: item.lineTotalUsd,
    adminPriceOverrideUsd: item.adminPriceOverrideUsd,
    adminPriceOverrideCurrency: item.adminPriceOverrideCurrency ?? null,
    adminPriceOverrideReason: item.adminPriceOverrideReason,
    editableDetailLines: item.editableDetailLines,
    crmPlayMemberId: item.crmPlayMemberId ?? null,
    crmPlayBenefitId: item.crmPlayBenefitId ?? null,
    crmPlayBenefitUpgradeId: item.crmPlayBenefitUpgradeId ?? null,
    ...(Object.hasOwn(item, 'adminCommissionOverrideMode') ? {
      commissionInheritedMode: item.commissionInheritedMode,
      commissionInheritedValue: item.commissionInheritedValue,
      commissionInheritedSource: item.commissionInheritedSource,
      adminCommissionOverrideMode: item.adminCommissionOverrideMode,
      adminCommissionOverrideValue: item.adminCommissionOverrideValue,
      adminCommissionOverrideReason: item.adminCommissionOverrideReason,
      adminCommissionOverrideChanged: item.adminCommissionOverrideChanged,
    } : {}),
  };
}

export async function loadMasterOpsClientCrmContextAction(input: { clientId: number; orderId?: number | null }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function prepareMasterOpsOrderSave(
  mode: "create" | "edit",
  input: MasterOpsOrderCreateInput | MasterOpsOrderUpdateInput
) {
  const ctx = await requireMasterOrAdminContext();
  const isAdmin = ctx.roles.includes("admin");
  const muerdemeQuotes = await verifyMuerdemeOrderItems(ctx.supabase, input.items, mode === 'edit' ? Number((input as MasterOpsOrderUpdateInput).orderId) : null);

  if (!["advisor", "master", "walk_in"].includes(String(input.source || ""))) {
    throw new Error("El origen de la orden no es válido.");
  }
  if (!["pickup", "delivery"].includes(String(input.fulfillment || ""))) {
    throw new Error("El tipo de entrega no es válido.");
  }
  if (!["USD", "VES"].includes(String(input.paymentCurrency || ""))) {
    throw new Error("La moneda de pago no es válida.");
  }
  if (!["USD", "VES"].includes(String(input.paymentChangeCurrency || ""))) {
    throw new Error("La moneda del cambio no es válida.");
  }
  const paymentMethod = normalizeMasterOpsOrderPaymentMethod(input.paymentMethod);
  if (!isMasterOpsOrderPaymentMethod(paymentMethod)) {
    throw new Error("El método de pago no es válido.");
  }
  const requiredPaymentCurrency = getPaymentReportCurrency(paymentMethod);
  if (requiredPaymentCurrency && input.paymentCurrency !== requiredPaymentCurrency) {
    throw new Error("La moneda no coincide con el método de pago.");
  }
  if (!["assigned", "own", "legacy"].includes(String(input.newClientType || ""))) {
    throw new Error("El tipo de cliente no es válido.");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("Agrega al menos un producto al pedido.");
  }

  const productIds = Array.from(
    new Set(
      input.items
        .map((item) => Number(item.productId))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    )
  );
  if (productIds.length !== new Set(input.items.map((item) => Number(item.productId))).size) {
    throw new Error("Uno de los productos de la orden no es válido.");
  }

  const orderId = mode === "edit" ? Number((input as MasterOpsOrderUpdateInput).orderId) : null;
  if (mode === "edit" && (!Number.isSafeInteger(orderId) || Number(orderId) <= 0)) {
    throw new Error("La orden no es válida.");
  }

  const [productsResult, componentsResult, activeRateResult, advisorsResult, selectedClientResult, orderResult, orderItemsResult] =
    await Promise.all([
      ctx.supabase
        .from("products")
        .select(
          "id, sku, name, is_active, source_price_amount, source_price_currency, base_price_usd, is_detail_editable, detail_units_limit, internal_rider_pay_usd, commission_mode, commission_value, extra_fields"
        )
        .in("id", productIds),
      ctx.supabase
        .from("product_components")
        .select(
          "parent_product_id, component_product_id, component_mode, is_required, counts_toward_detail_limit, component_product:products!product_components_component_product_id_fkey(name)"
        )
        .in("parent_product_id", productIds),
      ctx.supabase
        .from("exchange_rates")
        .select("rate_bs_per_usd")
        .eq("is_active", true)
        .order("effective_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      input.source === "advisor" || Boolean(String(input.attributedAdvisorUserId || "").trim())
        ? ctx.supabase.rpc("get_advisor_profiles")
        : Promise.resolve({ data: [], error: null }),
      Number(input.selectedClientId || 0) > 0
        ? ctx.supabase
            .from("clients")
            .select("id, fund_balance_usd")
            .eq("id", Number(input.selectedClientId))
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      mode === "edit"
        ? ctx.supabase
            .from("orders")
            .select("id, status, client_id, total_usd, is_price_locked, last_modified_at, extra_fields")
            .eq("id", Number(orderId))
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      mode === "edit"
        ? ctx.supabase
            .from("order_items")
            .select(
              "id, product_id, qty, pricing_origin_currency, pricing_origin_amount, pricing_fx_rate_snapshot, unit_price_usd_snapshot, line_total_usd, unit_price_bs_snapshot, line_total_bs_snapshot, admin_price_override_usd, admin_price_override_reason, product_name_snapshot, sku_snapshot, notes, crm_play_member_id, crm_play_benefit_id, crm_play_benefit_upgrade_id, reward_grant_id, reward_purpose, reward_amount_usd"
            )
            .eq("order_id", Number(orderId))
        : Promise.resolve({ data: [], error: null }),
    ]);

  const queryError =
    productsResult.error ??
    componentsResult.error ??
    activeRateResult.error ??
    advisorsResult.error ??
    selectedClientResult.error ??
    orderResult.error ??
    orderItemsResult.error;
  if (queryError) throw new Error(queryError.message);

  const currentOrder = orderResult.data as {
    id: number | string;
    status: string;
    client_id: number | string | null;
    total_usd: number | string | null;
    is_price_locked: boolean | null;
    last_modified_at: string | null;
    extra_fields: unknown;
  } | null;

  if (mode === "edit" && !currentOrder) {
    throw new Error("La orden ya no está disponible.");
  }
  if (currentOrder && ["delivered", "cancelled"].includes(String(currentOrder.status || ""))) {
    throw new Error("Una orden entregada o cancelada no se modifica desde Master Ops.");
  }
  if (currentOrder && !canEditMasterOpsOrder(currentOrder)) {
    throw new Error("Una orden que ya salió del local no se modifica desde Master Ops.");
  }

  if (currentOrder) {
    const expectedLastModifiedAt = String(
      (input as MasterOpsOrderUpdateInput).expectedLastModifiedAt || ""
    ).trim() || null;
    const currentLastModifiedAt = String(currentOrder.last_modified_at || "").trim() || null;
    if (expectedLastModifiedAt !== currentLastModifiedAt) {
      throw new Error("La orden cambió mientras la editabas. Ciérrala y vuelve a abrirla antes de guardar.");
    }
  }

  const attributedAdvisorUserId = String(input.attributedAdvisorUserId || "").trim();
  if (attributedAdvisorUserId) {
    const advisorIsActive = ((advisorsResult.data ?? []) as Array<{
      user_id: string | null;
      is_active: boolean | null;
    }>).some(
      (advisor) => String(advisor.user_id || "") === attributedAdvisorUserId && advisor.is_active !== false
    );
    if (!advisorIsActive) {
      throw new Error("El asesor seleccionado ya no está activo.");
    }
  }

  if (Number(input.selectedClientId || 0) > 0 && !selectedClientResult.data) {
    throw new Error("El cliente seleccionado ya no está disponible.");
  }

  const liveProducts = new Map(
    ((productsResult.data ?? []) as MasterOpsSaveCatalogRow[]).map((product) => [Number(product.id), product] as const)
  );
  const existingItems = (orderItemsResult.data ?? []) as MasterOpsExistingSaveItemRow[];
  const existingItemsById = new Map(existingItems.map((item) => [Number(item.id), item] as const));
  const commissionAudits = isAdmin && currentOrder
    ? await ctx.supabase.from("order_admin_adjustments").select("order_item_id, payload, reason")
        .eq("order_id", Number(currentOrder.id)).eq("adjustment_type", "other")
        .order("created_at", { ascending: false }).order("id", { ascending: false })
    : { data: [], error: null };
  if (commissionAudits.error) throw new Error(commissionAudits.error.message);
  const newCrmItems = input.items.filter((item) => !item.orderItemId && item.crmPlayMemberId != null);
  const newCrmContext = newCrmItems.length
    ? await loadMasterCrmOrderContext({
        supabase: ctx.supabase,
        clientId: Number(input.selectedClientId || 0),
        playMemberId: Number(newCrmItems[0].crmPlayMemberId),
      })
    : null;
  if (newCrmItems.length && !newCrmContext) throw new Error("La jugada ya no está disponible para este cliente. Vuelve a abrir el editor.");
  if (newCrmItems.length && input.items.some((item) => item.orderItemId && existingItemsById.get(Number(item.orderItemId))?.crm_play_member_id)) {
    throw new Error("La orden ya tiene un beneficio reservado. Conserva ese beneficio o retíralo y guarda antes de elegir otro.");
  }
  const submittedExistingIds = new Set<number>();
  let itemPricingChanged = mode === "create";

  const preparedItems = input.items.map((item) => {
    const productId = Number(item.productId);
    const liveProduct = liveProducts.get(productId) ?? null;
    const orderItemId = Number(item.orderItemId || 0) > 0 ? Number(item.orderItemId) : null;
    const existingItem = orderItemId ? existingItemsById.get(orderItemId) ?? null : null;
    if(existingItem?.reward_grant_id && (Number(item.productId)!==Number(existingItem.product_id)||Number(item.qty)!==Number(existingItem.qty)||item.adminPriceOverrideUsd!=null)) {
      throw new Error('Esta línea está financiada por un premio. Conserva su producto y cantidad; para cambiarlos, retira la línea y vuelve a agregar el producto normal.');
    }
    const newCrmChoice = !existingItem && item.crmPlayMemberId != null && newCrmContext
      ? resolveCrmOrderBenefit(newCrmContext, Number(item.crmPlayBenefitId), item.crmPlayBenefitUpgradeId ?? null)
      : null;
    if (!item.crmPlayMemberId && (item.crmPlayBenefitId != null || item.crmPlayBenefitUpgradeId != null)) {
      throw new Error("La vinculación del beneficio está incompleta.");
    }
    if (existingItem && (
      Number(item.crmPlayMemberId || 0) !== Number(existingItem.crm_play_member_id || 0) ||
      Number(item.crmPlayBenefitId || 0) !== Number(existingItem.crm_play_benefit_id || 0) ||
      Number(item.crmPlayBenefitUpgradeId || 0) !== Number(existingItem.crm_play_benefit_upgrade_id || 0)
    )) throw new Error("Una línea existente debe conservar su vinculación con la jugada.");

    if (mode === "create" && orderItemId) {
      throw new Error("Un pedido nuevo no puede reutilizar líneas de otra orden.");
    }
    if (mode === "edit" && orderItemId && !existingItem) {
      throw new Error("Una línea de la orden cambió mientras la editabas. Vuelve a abrir el editor.");
    }
    if (orderItemId) {
      if (submittedExistingIds.has(orderItemId)) {
        throw new Error("La orden contiene una línea duplicada.");
      }
      submittedExistingIds.add(orderItemId);
    }

    const productChanged = Boolean(existingItem) && Number(existingItem?.product_id || 0) !== productId;
    const quantityChanged = Boolean(existingItem) && !closeNumber(existingItem?.qty, item.qty);
    const detailsChanged = Boolean(existingItem) && !sameDetailLines(existingItem?.notes, item.editableDetailLines);
    const existingOverride = existingItem?.admin_price_override_usd == null
      ? null
      : Number(existingItem.admin_price_override_usd);
    const nextOverride = item.adminPriceOverrideUsd == null ? null : Number(item.adminPriceOverrideUsd);
    const overrideChanged = Boolean(existingItem) &&
      (existingOverride !== nextOverride ||
        String(existingItem?.admin_price_override_reason || "").trim() !==
          String(item.adminPriceOverrideReason || "").trim());
    const isNewLine = !existingItem;
    const linePricingChanged = isNewLine || productChanged || quantityChanged || overrideChanged ||
      (muerdemeQuotes.has(productId) && !closeNumber(existingItem?.pricing_origin_amount, item.sourcePriceAmount));
    if (existingItem?.crm_play_member_id && (productChanged || quantityChanged || overrideChanged)) {
      throw new Error("El beneficio reservado conserva su producto, cantidad y condiciones económicas.");
    }
    if (newCrmChoice && nextOverride != null) throw new Error("El precio del beneficio lo determina la jugada.");
    if (linePricingChanged) itemPricingChanged = true;

    if (!liveProduct) {
      throw new Error(`${String(item.productNameSnapshot || "El producto")} ya no existe en el catálogo.`);
    }
    const retainsInactiveQuantity = Boolean(existingItem) && !productChanged && !overrideChanged && Number(item.qty) <= Number(existingItem?.qty);
    const muerdemeQuote = muerdemeQuotes.has(productId) ? readMenuOrderQuote(item.editableDetailLines) : null;
    if (linePricingChanged && liveProduct.is_active === false && !retainsInactiveQuantity && !muerdemeQuote) {
      throw new Error(`${String(liveProduct.name || item.productNameSnapshot)} ya no está activo en el catálogo.`);
    }

    if (nextOverride != null && (isNewLine || overrideChanged)) {
      if (!isAdmin) throw new Error("Solo admin puede crear o cambiar ajustes de precio.");
      if (!Number.isFinite(nextOverride) || nextOverride < 0) {
        throw new Error(`El ajuste de precio de ${String(liveProduct.name || "el producto")} es inválido.`);
      }
      if (String(item.adminPriceOverrideReason || "").trim().length < 4) {
        throw new Error(`Indica el motivo del ajuste de precio de ${String(liveProduct.name || "el producto")}.`);
      }
    }

    let sourcePriceCurrency: "USD" | "VES";
    let sourcePriceAmount: number;
    let unitPriceUsdSnapshot: number;
    let adminPriceOverrideUsd: number | null;
    let adminPriceOverrideReason: string | null;

    if (muerdemeQuote) {
      sourcePriceCurrency = "USD";
      sourcePriceAmount = muerdemeQuote.unitUsd;
      unitPriceUsdSnapshot = muerdemeQuote.unitUsd;
      adminPriceOverrideUsd = null;
      adminPriceOverrideReason = null;
    } else if (newCrmChoice) {
      sourcePriceCurrency = newCrmChoice.sourcePriceCurrency;
      sourcePriceAmount = newCrmChoice.sourcePriceAmount;
      unitPriceUsdSnapshot = newCrmChoice.unitPriceUsdSnapshot;
      adminPriceOverrideUsd = null;
      adminPriceOverrideReason = null;
    } else if (existingItem && !productChanged && !overrideChanged) {
      sourcePriceCurrency = existingItem.pricing_origin_currency === "VES" ? "VES" : "USD";
      sourcePriceAmount = toNumber(existingItem.pricing_origin_amount, 0);
      unitPriceUsdSnapshot = toNumber(existingItem.unit_price_usd_snapshot, 0);
      adminPriceOverrideUsd = existingOverride;
      adminPriceOverrideReason = existingItem.admin_price_override_reason ?? null;
    } else if (nextOverride != null) {
      sourcePriceCurrency = item.sourcePriceCurrency === "VES" ? "VES" : "USD";
      sourcePriceAmount = Number(item.sourcePriceAmount);
      unitPriceUsdSnapshot = existingItem && !productChanged
        ? toNumber(existingItem.unit_price_usd_snapshot, 0)
        : toNumber(liveProduct.base_price_usd, 0);
      adminPriceOverrideUsd = nextOverride;
      adminPriceOverrideReason = String(item.adminPriceOverrideReason || "").trim();
      if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
        throw new Error(`El precio de ${String(liveProduct.name || "el producto")} es inválido.`);
      }
    } else {
      const liveCurrency = liveProduct.source_price_currency === "VES" ? "VES" : "USD";
      const liveAmount = toNumber(liveProduct.source_price_amount, 0);
      if (
        item.sourcePriceCurrency !== liveCurrency ||
        !closeNumber(item.sourcePriceAmount, liveAmount)
      ) {
        throw new Error("El catálogo cambió mientras editabas. Cierra el editor y vuelve a abrirlo.");
      }
      sourcePriceCurrency = liveCurrency;
      sourcePriceAmount = liveAmount;
      unitPriceUsdSnapshot = toNumber(liveProduct.base_price_usd, 0);
      adminPriceOverrideUsd = null;
      adminPriceOverrideReason = null;
    }

    return {
      orderItemId,
      productId,
      skuSnapshot: existingItem && !productChanged
        ? existingItem.sku_snapshot
        : liveProduct.sku,
      productNameSnapshot: muerdemeQuote ? muerdemeQuote.title : existingItem && !productChanged
        ? cleanText(existingItem.product_name_snapshot, cleanText(liveProduct.name, "Producto"))
        : cleanText(liveProduct.name, "Producto"),
      qty: Number(item.qty),
      sourcePriceCurrency,
      sourcePriceAmount,
      unitPriceUsdSnapshot,
      lineTotalUsd: Number(item.lineTotalUsd || 0),
      adminPriceOverrideUsd,
      adminPriceOverrideCurrency: adminPriceOverrideUsd == null ? null : sourcePriceCurrency,
      adminPriceOverrideReason,
      ...prepareEditorCommissionFields(item, readEditorCommissionFields(
        liveProduct, input.deliveryDate, commissionAudits.data ?? [], orderItemId,
      ), isAdmin),
      editableDetailLines: normalizedDetailLines(item.editableDetailLines),
      validateConfiguration: isNewLine || productChanged || detailsChanged,
      allowInactiveCatalog: Boolean(existingItem) && (!linePricingChanged || retainsInactiveQuantity),
      validateOverride: isNewLine || overrideChanged,
      crmPlayMemberId:
        newCrmChoice?.crmPlayMemberId ?? (existingItem?.crm_play_member_id == null ? null : Number(existingItem.crm_play_member_id)),
      rewardGrantId:existingItem?.reward_grant_id ?? null,
      rewardPurpose:existingItem?.reward_purpose ?? null,
      rewardAmountUsd:existingItem?.reward_amount_usd==null?null:Number(existingItem.reward_amount_usd),
      crmPlayBenefitId:
        newCrmChoice?.crmPlayBenefitId ?? (existingItem?.crm_play_benefit_id == null ? null : Number(existingItem.crm_play_benefit_id)),
      crmPlayBenefitUpgradeId:
        newCrmChoice ? newCrmChoice.crmPlayBenefitUpgradeId : existingItem?.crm_play_benefit_upgrade_id == null
          ? null
          : Number(existingItem.crm_play_benefit_upgrade_id),
    };
  });

  if (mode === "edit" && submittedExistingIds.size !== existingItems.length) {
    itemPricingChanged = true;
  }

  const activeRate = toNumber(activeRateResult.data?.rate_bs_per_usd, 0);
  if (activeRate <= 0) {
    throw new Error("No hay una tasa activa válida para guardar la orden.");
  }

  const currentPricing = readPricingRecord(currentOrder?.extra_fields);
  const currentDocuments = readDocumentsRecord(currentOrder?.extra_fields);
  const currentPayment = asOpsRecord(asOpsRecord(currentOrder?.extra_fields).payment);
  const currentFxRate = toNumber(currentPricing.fx_rate, activeRate);
  const requestedDiscountPct = input.discountEnabled ? toNumber(input.discountPct, 0) : 0;
  const currentDiscountPct = currentPricing.discount_enabled ? toNumber(currentPricing.discount_pct, 0) : 0;
  const requestedTaxPct = input.hasInvoice ? toNumber(input.invoiceTaxPct, 0) : 0;
  const currentTaxPct = currentDocuments.has_invoice ? toNumber(currentPricing.invoice_tax_pct, 0) : 0;
  const totalsConfigurationChanged = mode === "create" ||
    Boolean(input.discountEnabled) !== Boolean(currentPricing.discount_enabled) ||
    !closeNumber(requestedDiscountPct, currentDiscountPct) ||
    Boolean(input.hasInvoice) !== Boolean(currentDocuments.has_invoice) ||
    !closeNumber(requestedTaxPct, currentTaxPct);
  const requestedFxRate = toNumber(input.fxRate, 0);
  const requestedRateChanged = mode === "edit" && !closeNumber(requestedFxRate, currentFxRate);
  const pricingChanged = itemPricingChanged || totalsConfigurationChanged || requestedRateChanged;
  const effectiveFxRate = mode === "create" || requestedRateChanged ? activeRate : currentFxRate;

  if (!closeNumber(requestedFxRate, effectiveFxRate)) {
    throw new Error("La tasa cambió mientras editabas. Cierra el editor y vuelve a abrirlo.");
  }

  let isPriceProtected = Boolean(currentOrder?.is_price_locked);
  if (currentOrder && !isPriceProtected) {
    const { data: financialStateData, error: financialStateError } = await loadMasterOpsOrderFinancialStateForValidation(
      ctx.supabase,
      Number(currentOrder.id),
      activeRate
    );
    if (!financialStateError) {
      const financialState = ((financialStateData ?? []) as Array<Record<string, unknown>>)[0] ?? {};
      const financialTotal = toNumber(financialState.total_usd, toNumber(currentOrder.total_usd, 0));
      const confirmedPaid = toNumber(financialState.confirmed_paid_usd, 0);
      isPriceProtected = financialTotal > 0.005 && confirmedPaid / financialTotal + 0.000001 >= 0.9;
    }
  }

  const commercialTermsChanged = totalsConfigurationChanged || (requestedRateChanged && !itemPricingChanged);
  if (currentOrder && isPriceProtected && pricingChanged) {
    if (!isAdmin && commercialTermsChanged) {
      throw new Error("El precio está protegido. Solo admin puede cambiar descuentos, impuestos o la tasa manualmente.");
    }
    if (String((input as MasterOpsOrderUpdateInput).adminEditReason || "").trim().length < 4) {
      throw new Error("Indica el motivo para modificar una orden con precio protegido.");
    }
  }

  const approvedPricesById = new Map(existingItems.map((row) => [Number(row.id), storedApprovedPriceLine(row)]));
  if (!isAdmin && hasUnauthorizedPriceChange(preparedItems, [...approvedPricesById.values()], true)) {
    throw new Error(APPROVED_PRICE_CHANGE_MESSAGE);
  }
  const recalculatedItems = preparedItems.map((item) => {
    const original = approvedPricesById.get(Number(item.orderItemId));
    const preserved = preservedAgreedPriceSnapshot(item, original, currentFxRate) ??
      (!isAdmin ? preservedApprovedPriceSnapshot(item, original, true) ?? preservedOperationalSnapshot(item, original) : null);
    const snapshot = preserved ?? calculateOrderLineSnapshot({
      sourceCurrency: item.sourcePriceCurrency,
      sourceAmount: item.sourcePriceAmount,
      quantity: item.qty,
      fxRate: effectiveFxRate,
      overrideUnitUsd: item.adminPriceOverrideCurrency ? null : item.adminPriceOverrideUsd,
      fallbackUnitUsd: item.unitPriceUsdSnapshot,
    });
    return {
      ...item,
      unitPriceUsdSnapshot:
        preserved ? preserved.unitUsd : item.adminPriceOverrideUsd == null ? snapshot.unitUsd : item.unitPriceUsdSnapshot,
      lineTotalUsd: snapshot.lineUsd,
      lineTotalBsSnapshot: snapshot.lineBs,
    };
  });
  const subtotalUsd = recalculatedItems.reduce((sum, item) => sum + item.lineTotalUsd, 0);
  const subtotalBs = recalculatedItems.reduce((sum, item) => sum + item.lineTotalBsSnapshot, 0);
  const totals = calculateOrderTotalsSnapshot({
    subtotalUsd,
    subtotalBs,
    discountPct: requestedDiscountPct,
    invoiceTaxPct: requestedTaxPct,
  });
  // Reducing an order must restore the now-unneeded portion of its applied fund.
  const originalFund = toNumber(currentPayment.client_fund_used_usd, 0);
  const adjustsExistingFund = Boolean(currentOrder && input.useClientFund &&
    Number(input.selectedClientId) === Number(currentOrder.client_id) &&
    closeNumber(input.clientFundAmountUsd, originalFund));
  const effectiveFundAmount = adjustsExistingFund ? Math.min(originalFund, totals.totalUsd) : toNumber(input.clientFundAmountUsd, 0);

  const catalogItems = ((productsResult.data ?? []) as MasterOpsSaveCatalogRow[]).map((product) => ({
    id: Number(product.id),
    name: cleanText(product.name, `Producto #${product.id}`),
    isActive: muerdemeQuotes.has(Number(product.id)) || product.is_active !== false,
    isDetailEditable: Boolean(product.is_detail_editable),
    detailUnitsLimit: toNumber(product.detail_units_limit, 0),
    internalRiderPayUsd: product.internal_rider_pay_usd == null
      ? null
      : toNumber(product.internal_rider_pay_usd, 0),
  }));
  const validationComponents = ((componentsResult.data ?? []) as MasterOpsSaveComponentRow[]).map((component) => ({
    parentProductId: Number(component.parent_product_id),
    componentProductId: Number(component.component_product_id),
    componentName: cleanText(one(component.component_product)?.name, `Componente #${component.component_product_id}`),
    componentMode: component.component_mode === "selectable" ? ("selectable" as const) : ("fixed" as const),
    isRequired: component.is_required !== false,
    countsTowardDetailLimit: component.counts_toward_detail_limit !== false,
  }));
  const validationIssues = getMasterOpsOrderEditorValidationIssues({
    ...input,
    paymentMethod,
    clientFundAmountUsd: String(effectiveFundAmount),
    items: recalculatedItems.map((item) => ({
      ...item,
      adminPriceOverrideUsd: item.validateOverride ? item.adminPriceOverrideUsd : null,
      validateConfiguration: item.validateConfiguration,
      allowInactiveCatalog: item.allowInactiveCatalog,
    })),
    catalogItems,
    productComponents: validationComponents,
    fxRate: effectiveFxRate,
    clientFundAvailableUsd:
      toNumber(selectedClientResult.data?.fund_balance_usd, 0) +
      (currentOrder && Number(currentOrder.client_id || 0) === Number(input.selectedClientId || 0)
        ? Math.max(0, toNumber(currentPayment.client_fund_used_usd, 0))
        : 0),
    orderTotalUsd: totals.totalUsd,
    isAdmin,
    isPriceProtected,
    pricingChanged,
    commercialTermsChanged,
    isAdvancedEdit:
      mode === "edit" &&
      (Boolean(currentOrder && !["created", "queued"].includes(currentOrder.status)) ||
        Boolean(isPriceProtected && pricingChanged)),
    adminEditReason:
      mode === "edit" ? (input as MasterOpsOrderUpdateInput).adminEditReason ?? null : null,
  });
  if (validationIssues.length > 0) {
    throw new Error(validationIssues[0].message);
  }

  if (newCrmContext) {
    const commercialSubtotalUsd = recalculatedItems
      .filter((item) => countsTowardCrmMinimum({ productName: item.productNameSnapshot, sku: item.skuSnapshot, isCrmBenefit: Boolean(item.crmPlayMemberId), lineUsd: item.lineTotalUsd }))
      .reduce((sum, item) => sum + item.lineTotalUsd, 0) * (1 - requestedDiscountPct / 100);
    validateMasterCrmBenefitSelection({
      context: newCrmContext,
      clientId: Number(input.selectedClientId),
      advisorUserId: attributedAdvisorUserId || null,
      commercialSubtotalUsd,
      items: newCrmItems,
    });
    const { error } = await ctx.supabase.rpc("crm_set_play_benefits_v2", {
      p_play_member_id: newCrmContext.playMemberId,
      p_play_benefit_ids: newCrmItems.map((item) => Number(item.crmPlayBenefitId)),
    });
    if (error) throw new Error(error.message);
  }

  return {
    ...input,
    paymentMethod,
    useClientFund: input.useClientFund && effectiveFundAmount > 0,
    clientFundAmountUsd: String(effectiveFundAmount),
    fxRate: String(effectiveFxRate),
    items: recalculatedItems.map(stripMasterOpsOrderItem),
  };
}

export async function createMasterOpsOrderAction(input: MasterOpsOrderCreateInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function storeMasterOpsOrderExcessAction(input: { orderId: number; reason: string }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateMasterOpsOrderAction(input: MasterOpsOrderUpdateInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function appendMasterOpsBeverageAction(input: {
  orderId: number; productId: number; qty: number; expectedLastModifiedAt: string | null;
  operationId: string; reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function appendMasterOpsGiftAction(input: {
  orderId: number; productId: number; qty: number; expectedLastModifiedAt: string | null;
  operationId: string; reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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
        inventory_group,
        is_active,
        source_price_amount,
        source_price_currency,
        base_price_usd,
        base_price_bs,
        units_per_service,
        is_detail_editable,
        detail_units_limit,
        internal_rider_pay_usd,
        commission_mode,
        commission_value,
        extra_fields
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
      inventoryGroup: product.inventory_group ?? null,
      commissionInheritedMode: readEditorCommissionFields(product, getCaracasDateKey(new Date().toISOString())).commissionInheritedMode,
      commissionInheritedValue: readEditorCommissionFields(product, getCaracasDateKey(new Date().toISOString())).commissionInheritedValue,
      discretionaryAllowed: !isCrmOnlyCatalogProduct(product),
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
    .filter((product) => {
      const source = ((productsResult.data ?? []) as Array<{ id: number | string; extra_fields?: unknown }>).find(
        (row) => Number(row.id) === product.id
      );
      const extraFields = asOpsRecord(source?.extra_fields);
      return extraFields.catalog_access_scope !== "admin_internal";
    })
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
  focusDateInput?: string | null,
  templateOrderIdInput?: number | null
): Promise<MasterOpsEditData> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function loadMasterOpsRepeatSource(
  ctx: Awaited<ReturnType<typeof requireMasterOrAdminContext>>, orderId: number,
): Promise<RepeatOrderSource> {
  // Use the signed-in user's RLS context. Never load payments, movements or financial history.
  const [orderResult, itemsResult] = await Promise.all([
    ctx.supabase.from("orders").select(`
      id, source, attributed_advisor_id, fulfillment, receiver_name, receiver_phone, delivery_address, extra_fields,
      client:clients!orders_client_id_fkey (
        id, full_name, phone, client_type, fund_balance_usd, recent_addresses,
        billing_company_name, billing_tax_id, billing_address, billing_phone,
        delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone
      )
    `).eq("id", orderId).single(),
    ctx.supabase.from("order_items").select("product_id, product_name_snapshot, qty, notes")
      .eq("order_id", orderId).order("id", { ascending: true }),
  ]);
  if (orderResult.error || itemsResult.error) {
    throw new Error(orderResult.error?.message ?? itemsResult.error?.message ?? "No se pudo cargar el pedido base.");
  }
  if (!orderResult.data) throw new Error("No se pudo acceder al pedido base.");
  const row = orderResult.data;
  const extra = asOpsRecord(row.extra_fields);
  const delivery = asOpsRecord(extra.delivery);
  const receiver = asOpsRecord(extra.receiver);
  const client = one(row.client);
  return {
    id: Number(row.id), source: String(row.source), attributedAdvisorUserId: row.attributed_advisor_id,
    client: client ? mapClient(client) : null, fulfillment: String(row.fulfillment),
    receiverName: cleanText(receiver.name, cleanText(row.receiver_name)),
    receiverPhone: cleanText(receiver.phone, cleanText(row.receiver_phone)),
    deliveryAddress: cleanText(delivery.address, cleanText(row.delivery_address)),
    deliveryGpsUrl: cleanText(delivery.gps_url),
    items: (itemsResult.data ?? []).map(item => ({ productId: Number(item.product_id),
      productName: cleanText(item.product_name_snapshot, "Producto"), qty: Number(item.qty), notes: item.notes })),
  };
}

export async function loadMasterOpsOrderEditDataAction(orderIdInput: number): Promise<MasterOpsEditData> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
