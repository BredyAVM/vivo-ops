'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext, requireMasterOrAdminContext } from '@/lib/auth';
import { notifyCanonicalCatalogPriceChangeAction } from '@/app/app/master/dashboard/actions';
import { sendPushToRoleDevices } from '@/lib/push';
import { normalizeReceiptCapture, receiptActionFailure, type ReceiptCaptureInput } from '@/lib/inventory/receipt-validation';

type CountLineInput = {
  inventoryItemId: number;
  countedQuantityUnits: number;
  note?: string | null;
};


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOperationId(value: unknown) {
  const operationId = String(value ?? '').trim();
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error('La clave de idempotencia de la operación no es válida.');
  }
  return operationId;
}

function normalizeCountId(value: unknown) {
  const countId = Number(value);
  if (!Number.isSafeInteger(countId) || countId <= 0) {
    throw new Error('El conteo indicado no es válido.');
  }
  return countId;
}

function normalizePositiveQuantity(value: unknown, label: string) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`${label} debe ser mayor que cero.`);
  }
  return quantity;
}

function normalizeNotes(value: unknown) {
  const notes = String(value ?? '').trim();
  if (notes.length > 1000) {
    throw new Error('La nota no puede superar 1.000 caracteres.');
  }
  return notes || null;
}

function inventoryProductionErrorMessage(error: unknown) {
  const message = error instanceof Error
    ? error.message.trim()
    : typeof error === 'string'
      ? error.trim()
      : '';
  const safePrefixes = [
    'Stock insuficiente en ',
    'Autenticación requerida.',
    'No autenticado.',
    'Solo cocina o administración ',
    'La clave de idempotencia ',
    'El conteo indicado ',
    'El multiplicador ',
    'La salida real ',
    'La nota ',
    'Receta no encontrada.',
    'La receta ',
    'Falta activación o apertura aceptada en:',
    'operation_id y recipe_id ',
  ];

  if (safePrefixes.some((prefix) => message.startsWith(prefix))) {
    return message;
  }
  return 'No se pudo registrar la producción. Intenta nuevamente o consulta a Administración.';
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} no puede superar ${maxLength.toLocaleString('es-VE')} caracteres.`);
  }
  return normalized || null;
}


function normalizeDateTime(value: unknown, label: string) {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} no es válida.`);
  }
  return date.toISOString();
}

function revalidateInventoryReceiptRoutes() {
  revalidatePath('/app/kitchen');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/kitchen/inventory/receipts');
}

function revalidateInventoryProductionRoutes() {
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/recipes');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/kitchen/inventory/production');
}

function normalizeLines(value: unknown): CountLineInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error('El conteo debe incluir entre 1 y 200 ítems.');
  }

  const seenItemIds = new Set<number>();
  return value.map((rawLine) => {
    const line = rawLine as Partial<CountLineInput>;
    const inventoryItemId = Number(line.inventoryItemId);
    const countedQuantityUnits = Number(line.countedQuantityUnits);

    if (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0) {
      throw new Error('El conteo contiene un ítem inválido.');
    }
    if (!Number.isFinite(countedQuantityUnits) || countedQuantityUnits < 0) {
      throw new Error('Las cantidades contadas deben ser números mayores o iguales a cero.');
    }
    if (seenItemIds.has(inventoryItemId)) {
      throw new Error('Un ítem no puede repetirse dentro del mismo conteo.');
    }

    seenItemIds.add(inventoryItemId);
    const note = normalizeNotes(line.note);
    return { inventoryItemId, countedQuantityUnits, note };
  });
}

function serializeLines(lines: CountLineInput[]) {
  return lines.map((line) => ({
    inventory_item_id: line.inventoryItemId,
    counted_quantity_units: line.countedQuantityUnits,
    note: line.note ?? null,
  }));
}

function revalidateInventoryCountRoutes(countId: number) {
  revalidatePath('/app/kitchen');
  revalidatePath('/app/kitchen/inventory/counts');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/opening');
  revalidatePath('/app/inventory/counts');
  revalidatePath(`/app/inventory/counts/${countId}`);
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/master/ops/inventory');
}

export async function saveInventoryCatalogDraftAction(input: { configuration: unknown }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function revalidateInventoryConfigurationRoutes() {
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/products');
  revalidatePath('/app/inventory/configure');
  revalidatePath('/app/inventory/recipes');
  revalidatePath('/app/inventory/readiness');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
  revalidatePath('/app/master/dashboard');
  revalidatePath('/app/master/ops');
  revalidatePath('/app/advisor/new');
  revalidatePath('/app/counter');
}

export async function updateInventoryProductIdentityAction(input: {
  productId: number;
  productType: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  catalogAccessScope?: string;
  name: string;
  sku: string;
  unitsPerService: number;
  allowsHalfService: boolean;
  isTemporary: boolean;
  detailUnitsLimit: number;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'USD' | 'VES';
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  advisorGiftCostUsd: number | null;
  internalRiderPayUsd: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

type InventoryProductCommercialTermsInput = {
  productId: number;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'USD' | 'VES';
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  advisorGiftCostUsd: number | null;
  internalRiderPayUsd: number | null;
};

function normalizeProductSourcePrice(input: {
  productId: number;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'USD' | 'VES';
}) {
  const productId = normalizeCountId(input.productId);
  const sourcePriceAmount = Number(input.sourcePriceAmount);
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El precio fuente debe ser mayor o igual a cero.');
  }
  if (!['USD', 'VES'].includes(input.sourcePriceCurrency)) {
    throw new Error('La moneda del precio fuente no es válida.');
  }

  return {
    productId,
    sourcePriceAmount,
    sourcePriceCurrency: input.sourcePriceCurrency,
  };
}

export async function updateInventoryProductCommercialTermsAction(
  input: InventoryProductCommercialTermsInput,
) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryProductPricesBulkAction(input: {
  items: Array<{
    productId: number;
    sourcePriceAmount: number;
    sourcePriceCurrency: 'USD' | 'VES';
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryProductPhysicalConfigurationAction(input: {
  productId: number;
  inventoryPolicy: 'self' | 'direct' | 'components' | 'none';
  detailUnitsLimit: number;
  changeNote: string | null;
  routes: Array<{
    key: string;
    name: string;
    mode: 'primary' | 'master_fallback';
    links: Array<{
      inventoryItemId: number;
      quantityUnits: number;
      halfQuantityUnits: number | null;
      deductionStage: 'kitchen' | 'production' | 'packing' | 'fulfillment' | null;
    }>;
  }>;
  components: Array<{
    componentProductId: number;
    componentMode: 'fixed' | 'selectable';
    quantity: number;
    countsTowardDetailLimit: boolean;
    isRequired: boolean;
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryItemControlsAction(input: {
  inventoryItemId: number;
  name: string;
  availabilityMode: 'on_hand_only' | 'immediate_recipe' | 'scheduled_recipe' | null;
  lowStockThreshold: number | null;
  lowStockInclusive: boolean;
  targetStockUnits: number | null;
  shelfLifeDays: number | null;
  primaryCountFrequency: 'per_shift' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  primaryCountRole: 'admin' | 'master' | 'kitchen' | 'counter' | null;
  primaryCountLocationCode: 'beverage_pepsi' | 'beverage_coca_cola' | 'beverage_reserve' | null;
  notes: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function setInventoryItemActiveStatusAction(input: {
  inventoryItemId: number;
  nextIsActive: boolean;
  note: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function setInventoryProductActiveStatusAction(input: {
  productId: number;
  nextIsActive: boolean;
  note: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveInventoryRecipeDraftAction(input: {
  draftRecipeId: number | null;
  sourceRecipeId: number | null;
  outputInventoryItemId: number;
  recipeKind: 'production' | 'packaging';
  outputQuantityUnits: number;
  leadTimeMinutes: number;
  productionMultiple: number;
  notes: string | null;
  components: Array<{
    inputInventoryItemId: number;
    quantityUnits: number;
  }>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitInventoryDraftOpeningAction(input: {
  operationId: string;
  inventoryItemId: number;
  countedQuantityUnits: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function activateInventoryDraftAction(input: {
  productId?: number | null;
  inventoryItemId?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitInventoryOpeningAction(input: {
  operationId: string;
  lines: CountLineInput[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitInventoryAdministrativeCountAction(input: {
  operationId: string;
  lines: CountLineInput[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function adjustInventoryStockAction(input: {
  operationId: string;
  inventoryItemId: number;
  targetQuantityUnits: number;
  reasonCode: string;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitInventoryOpenCountAction(input: {
  operationId: string;
  countId: number;
  countKind: 'recount' | 'requested' | 'periodic' | 'shift_change';
  lines: CountLineInput[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelInventoryOpenCountAction(input: {
  countId: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reviewInventoryCountAction(input: {
  countId: number;
  action: 'accept' | 'request_recount';
  lineIds?: number[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function requestSupplementalInventoryRecountAction(input: {
  countId: number;
  lineIds: number[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveInventoryExpectedReceiptAction(input: {
  operationId: string;
  inventoryItemId: number;
  effectiveAt: string;
  capture: ReceiptCaptureInput;
  notes?: string | null;
  replacesFlowId?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelInventoryExpectedReceiptAction(input: {
  expectedFlowId: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function receiveInventoryStockAction(input: {
  operationId: string;
  inventoryItemId: number;
  expectedFlowId?: number | null;
  capture: ReceiptCaptureInput;
  lotCode?: string | null;
  receivedAt?: string | null;
  expiresAt?: string | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function revalidateInventoryEventRoutes(orderId?: number) {
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
  revalidatePath('/app/master/ops/inventory');
  if (orderId != null) {
    revalidatePath('/app/master/ops');
    revalidatePath(`/orders/${orderId}`);
  }
}

export async function dispatchInventoryForEventAction(input: {
  operationId: string;
  orderId: number;
  lines: Array<{ inventoryItemId: number; quantityUnits: number }>;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reconcileInventoryEventAction(input: {
  operationId: string;
  dispatchOperationId: string;
  orderId: number;
  lines: Array<{
    inventoryItemId: number;
    returnedQuantityUnits: number;
    lossQuantityUnits: number;
    lossKind: 'damage' | 'waste';
  }>;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function activateInventoryRecipeAction(input: { recipeId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function activateAllCanonicalInventoryRecipesAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function startInventoryProductionAction(input: {
  operationId: string;
  recipeId: number;
  batchMultiplier: number;
  declaredOutputUnits?: number | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function completeInventoryProductionAction(input: {
  operationId: string;
  productionFlowId: number;
  actualOutputUnits: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function resolveInventoryProductionAction(input: {
  productionFlowId: number;
  resolution: 'failed' | 'cancelled';
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export type InventoryAlertCategory =
  | 'availability'
  | 'commitment'
  | 'production'
  | 'control'
  | 'procurement'
  | 'system';

export type InventoryAlertRouteInput = {
  targetRole: 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter';
  surface:
    | 'inventory_center'
    | 'advisor_availability'
    | 'master_inventory'
    | 'kitchen_inventory'
    | 'counter_inventory'
    | 'admin_inventory';
};

const INVENTORY_ALERT_CATEGORIES = new Set<InventoryAlertCategory>([
  'availability',
  'commitment',
  'production',
  'control',
  'procurement',
  'system',
]);

const INVENTORY_ALERT_ROUTE_KEYS = new Set([
  'admin:inventory_center',
  'admin:admin_inventory',
  'master:inventory_center',
  'master:master_inventory',
  'advisor:advisor_availability',
  'kitchen:kitchen_inventory',
  'counter:counter_inventory',
]);

function normalizeInventoryAlertCategory(value: unknown): InventoryAlertCategory {
  const category = String(value ?? '') as InventoryAlertCategory;
  if (!INVENTORY_ALERT_CATEGORIES.has(category)) {
    throw new Error('La categoría de alerta no es válida.');
  }
  return category;
}

function normalizeInventoryAlertRoutes(value: unknown): InventoryAlertRouteInput[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('La configuración admite hasta 20 rutas.');
  }

  const seen = new Set<string>();
  return value.map((rawRoute) => {
    const route = rawRoute as Partial<InventoryAlertRouteInput>;
    const targetRole = String(route.targetRole ?? '') as InventoryAlertRouteInput['targetRole'];
    const surface = String(route.surface ?? '') as InventoryAlertRouteInput['surface'];
    const key = `${targetRole}:${surface}`;
    if (!INVENTORY_ALERT_ROUTE_KEYS.has(key)) {
      throw new Error('La configuración contiene una combinación de rol y ubicación no válida.');
    }
    if (seen.has(key)) {
      throw new Error('Una ruta de alerta no puede repetirse.');
    }
    seen.add(key);
    return { targetRole, surface };
  });
}

function normalizeNullableNonnegativeNumber(value: unknown, label: string) {
  if (value == null || String(value).trim() === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`${label} debe ser mayor o igual a cero.`);
  }
  return numberValue;
}

function revalidateInventoryAlertRoutes() {
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/alerts');
}

export async function refreshInventoryAlertsAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveInventoryAlertPolicyAction(input: {
  category: InventoryAlertCategory;
  inventoryItemId?: number | null;
  isEnabled: boolean;
  routes: InventoryAlertRouteInput[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deleteInventoryAlertPolicyOverrideAction(input: {
  category: InventoryAlertCategory;
  inventoryItemId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryItemAlertSettingsAction(input: {
  inventoryItemId: number;
  lowStockThreshold?: number | string | null;
  lowStockInclusive: boolean;
  targetStockUnits?: number | string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function updateInventoryAlertStatusAction(input: {
  alertId: number;
  action: 'manage' | 'resolve' | 'reopen';
  note?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export type InventoryKardexCursor = {
  beforeCreatedAt: string;
  beforeId: number;
};

export async function loadInventoryKardexPageAction(input: {
  inventoryItemId?: number | null;
  cursor?: InventoryKardexCursor | null;
  limit?: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
