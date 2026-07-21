"use server";

import { requireMasterOrAdminContext } from "@/lib/auth";

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
  order_number: string | null;
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
      orderNumber: cleanText(orderRow.order_number, String(orderRow.id)),
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
