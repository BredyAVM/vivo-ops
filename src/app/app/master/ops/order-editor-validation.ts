import { parseEditableDetailLines } from "@/lib/orders/order-composer";

export type MasterOpsOrderEditorValidationIssue = {
  code:
    | "advisor"
    | "client"
    | "date"
    | "time"
    | "items"
    | "catalog"
    | "quantity"
    | "configuration"
    | "delivery_address"
    | "delivery_item"
    | "rate"
    | "discount"
    | "tax"
    | "payment_change"
    | "client_fund"
    | "price_override"
    | "price_protection"
    | "edit_reason";
  message: string;
};

type ValidationCatalogItem = {
  id: number;
  name: string;
  isActive: boolean;
  isDetailEditable?: boolean;
  detailUnitsLimit?: number;
  internalRiderPayUsd?: number | null;
};

type ValidationComponent = {
  parentProductId: number;
  componentProductId: number;
  componentName: string;
  componentMode?: "fixed" | "selectable";
  isRequired?: boolean;
  countsTowardDetailLimit: boolean;
};

type ValidationItem = {
  productId: number;
  productNameSnapshot: string;
  qty: number;
  editableDetailLines?: string[];
  adminPriceOverrideUsd?: number | null;
  adminPriceOverrideReason?: string | null;
  validateConfiguration?: boolean;
  allowInactiveCatalog?: boolean;
};

export type MasterOpsOrderEditorValidationInput = {
  source: string;
  attributedAdvisorUserId?: string | null;
  selectedClientId?: number | null;
  newClientName?: string | null;
  newClientPhone?: string | null;
  fulfillment: string;
  deliveryDate?: string | null;
  deliveryHour12?: string | null;
  deliveryMinute?: string | null;
  deliveryAmPm?: string | null;
  deliveryAddress?: string | null;
  items: ValidationItem[];
  catalogItems: ValidationCatalogItem[];
  productComponents?: ValidationComponent[];
  fxRate: unknown;
  discountEnabled?: boolean;
  discountPct?: unknown;
  hasInvoice?: boolean;
  invoiceTaxPct?: unknown;
  paymentRequiresChange?: boolean;
  paymentChangeFor?: unknown;
  useClientFund?: boolean;
  clientFundAmountUsd?: unknown;
  clientFundAvailableUsd?: number | null;
  orderTotalUsd?: number | null;
  isAdmin?: boolean;
  isPriceProtected?: boolean;
  pricingChanged?: boolean;
  isAdvancedEdit?: boolean;
  adminEditReason?: string | null;
};

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function hasValidDate(value: unknown) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isMasterOpsDeliveryCatalogItem(item: {
  name?: string | null;
  internalRiderPayUsd?: number | null;
} | null | undefined) {
  if (!item) return false;
  return (
    Number(item.internalRiderPayUsd || 0) > 0 ||
    String(item.name || "").trim().toLowerCase().includes("delivery")
  );
}

function getConfigurationIssue(
  item: ValidationItem,
  catalogItem: ValidationCatalogItem,
  components: ValidationComponent[]
) {
  if (!catalogItem.isDetailEditable || item.validateConfiguration === false) return null;
  if (Number(item.qty) !== 1) {
    return `${catalogItem.name} debe cargarse y configurarse una unidad a la vez.`;
  }

  const detailUnitsLimit = Math.max(0, Number(catalogItem.detailUnitsLimit || 0));
  if (detailUnitsLimit <= 0) return null;

  const allowedComponents = components.filter((component) => component.parentProductId === item.productId);
  const allowedById = new Map(allowedComponents.map((component) => [component.componentProductId, component] as const));
  const allowedByName = new Map(
    allowedComponents.map((component) => [component.componentName.trim().toLowerCase(), component] as const)
  );
  const parsed = parseEditableDetailLines(item.editableDetailLines ?? []);
  let selectedUnits = 0;

  for (const selection of parsed.selections) {
    if (!Number.isInteger(Number(selection.qty)) || Number(selection.qty) <= 0) {
      return `${catalogItem.name} contiene una cantidad de piezas inválida.`;
    }
    const component =
      (selection.componentProductId != null ? allowedById.get(selection.componentProductId) : null) ??
      allowedByName.get(selection.componentName.trim().toLowerCase());
    if (!component) {
      return `${catalogItem.name} contiene una selección que ya no pertenece a su configuración.`;
    }
    if (component.componentMode === "fixed" && component.isRequired) continue;
    if (component.countsTowardDetailLimit) selectedUnits += Number(selection.qty || 0);
  }

  return selectedUnits === detailUnitsLimit
    ? null
    : `${catalogItem.name} requiere exactamente ${detailUnitsLimit} piezas configuradas.`;
}

export function getMasterOpsOrderEditorValidationIssues(
  input: MasterOpsOrderEditorValidationInput
): MasterOpsOrderEditorValidationIssue[] {
  const issues: MasterOpsOrderEditorValidationIssue[] = [];
  const catalogById = new Map(input.catalogItems.map((item) => [item.id, item] as const));

  if (input.source === "advisor" && !String(input.attributedAdvisorUserId || "").trim()) {
    issues.push({ code: "advisor", message: "Selecciona el asesor atribuido." });
  }

  const hasSelectedClient = Number(input.selectedClientId || 0) > 0;
  const newClientName = String(input.newClientName || "").trim();
  const newClientPhoneDigits = String(input.newClientPhone || "").replace(/\D/g, "");
  if (!hasSelectedClient && (newClientName.length < 2 || newClientPhoneDigits.length < 5)) {
    issues.push({ code: "client", message: "Selecciona un cliente o completa nombre y teléfono." });
  }

  if (!hasValidDate(input.deliveryDate)) {
    issues.push({ code: "date", message: "Selecciona una fecha de entrega válida." });
  }

  const hour = numberValue(input.deliveryHour12);
  const minute = numberValue(input.deliveryMinute);
  if (
    !Number.isInteger(hour) ||
    hour < 1 ||
    hour > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    !["AM", "PM"].includes(String(input.deliveryAmPm || ""))
  ) {
    issues.push({ code: "time", message: "La hora debe estar entre 1:00 y 12:59, con AM o PM." });
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    issues.push({ code: "items", message: "Agrega al menos un producto al pedido." });
  }

  for (const item of input.items ?? []) {
    const catalogItem = catalogById.get(Number(item.productId));
    if ((!catalogItem || !catalogItem.isActive) && !item.allowInactiveCatalog) {
      issues.push({
        code: "catalog",
        message: `${String(item.productNameSnapshot || "El producto")} ya no está activo en el catálogo.`,
      });
      continue;
    }

    if (!catalogItem) continue;

    const qty = numberValue(item.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) {
      issues.push({ code: "quantity", message: `Revisa la cantidad de ${catalogItem.name}.` });
    }

    const configurationIssue = getConfigurationIssue(
      item,
      catalogItem,
      input.productComponents ?? []
    );
    if (configurationIssue) {
      issues.push({ code: "configuration", message: configurationIssue });
    }

    if (item.adminPriceOverrideUsd != null) {
      const overrideAmount = numberValue(item.adminPriceOverrideUsd);
      if (!input.isAdmin) {
        issues.push({ code: "price_override", message: "Solo admin puede crear o cambiar ajustes de precio." });
      } else if (!Number.isFinite(overrideAmount) || overrideAmount < 0) {
        issues.push({ code: "price_override", message: `El ajuste de precio de ${catalogItem.name} es inválido.` });
      } else if (String(item.adminPriceOverrideReason || "").trim().length < 4) {
        issues.push({ code: "price_override", message: `Indica el motivo del ajuste de precio de ${catalogItem.name}.` });
      }
    }
  }

  if (input.fulfillment === "delivery") {
    if (!String(input.deliveryAddress || "").trim()) {
      issues.push({ code: "delivery_address", message: "La dirección es obligatoria para delivery." });
    }
    const hasDeliveryItem = input.items.some((item) => isMasterOpsDeliveryCatalogItem(catalogById.get(item.productId)));
    if (!hasDeliveryItem) {
      issues.push({ code: "delivery_item", message: "Agrega el producto de delivery al pedido." });
    }
  }

  const fxRate = numberValue(input.fxRate);
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    issues.push({ code: "rate", message: "No hay una tasa válida para calcular la orden." });
  }

  if (input.discountEnabled) {
    const discountPct = numberValue(input.discountPct);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
      issues.push({ code: "discount", message: "El descuento debe estar entre 0% y 100%." });
    }
  }

  if (input.hasInvoice) {
    const invoiceTaxPct = numberValue(input.invoiceTaxPct);
    if (!Number.isFinite(invoiceTaxPct) || invoiceTaxPct < 0 || invoiceTaxPct > 100) {
      issues.push({ code: "tax", message: "El IVA debe estar entre 0% y 100%." });
    }
  }

  if (input.paymentRequiresChange) {
    const paymentChangeFor = numberValue(input.paymentChangeFor);
    if (!Number.isFinite(paymentChangeFor) || paymentChangeFor <= 0) {
      issues.push({ code: "payment_change", message: "Indica un monto válido para calcular el cambio." });
    }
  }

  if (input.useClientFund) {
    const requestedFund = numberValue(input.clientFundAmountUsd);
    const availableFund = Math.max(0, Number(input.clientFundAvailableUsd || 0));
    const orderTotal = Math.max(0, Number(input.orderTotalUsd || 0));
    const maximumFund = Math.min(availableFund, orderTotal);
    if (!hasSelectedClient) {
      issues.push({ code: "client_fund", message: "Selecciona un cliente existente para aplicar su fondo." });
    } else if (!Number.isFinite(requestedFund) || requestedFund <= 0) {
      issues.push({ code: "client_fund", message: "Indica cuánto fondo del cliente se aplicará." });
    } else if (requestedFund > maximumFund + 0.005) {
      issues.push({
        code: "client_fund",
        message: `El fondo aplicable no puede superar $${maximumFund.toFixed(2)}.`,
      });
    }
  }

  if (input.isPriceProtected && input.pricingChanged && !input.isAdmin) {
    issues.push({
      code: "price_protection",
      message: "El precio está protegido; solo admin puede cambiar productos, cantidades o totales.",
    });
  }

  if (input.isAdvancedEdit && String(input.adminEditReason || "").trim().length < 4) {
    issues.push({ code: "edit_reason", message: "Indica el motivo de la modificación operativa." });
  }

  return issues.filter(
    (issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code && candidate.message === issue.message) === index
  );
}
