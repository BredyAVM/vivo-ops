'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext, requireMasterOrAdminContext } from '@/lib/auth';
import { notifyCanonicalCatalogPriceChangeAction } from '@/app/app/master/dashboard/actions';
import { sendPushToRoleDevices } from '@/lib/push';

type CountLineInput = {
  inventoryItemId: number;
  countedQuantityUnits: number;
  note?: string | null;
};

type ReceiptCaptureInput = {
  quantityUnknown?: boolean;
  sourceName?: string | null;
  looseUnits?: number | null;
  presentations?: Array<{
    presentationId: number;
    quantity: number;
    baseUnitsPerPresentation?: number | null;
  }>;
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

function normalizeOptionalText(value: unknown, label: string, maxLength: number) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} no puede superar ${maxLength.toLocaleString('es-VE')} caracteres.`);
  }
  return normalized || null;
}

function normalizeReceiptCapture(value: unknown, allowUnknown: boolean) {
  const capture = (value ?? {}) as ReceiptCaptureInput;
  if (typeof capture !== 'object' || Array.isArray(capture)) {
    throw new Error('La captura de presentaciones no es válida.');
  }

  const quantityUnknown = capture.quantityUnknown === true;
  if (quantityUnknown && !allowUnknown) {
    throw new Error('La recepción real requiere una cantidad exacta.');
  }

  const sourceName = normalizeOptionalText(capture.sourceName, 'La fuente', 160);
  const looseUnits = Number(capture.looseUnits ?? 0);
  if (!Number.isFinite(looseUnits) || looseUnits < 0) {
    throw new Error('Las unidades sueltas deben ser mayores o iguales a cero.');
  }

  const rawPresentations = capture.presentations ?? [];
  if (!Array.isArray(rawPresentations) || rawPresentations.length > 20) {
    throw new Error('La captura admite hasta 20 presentaciones.');
  }

  const seenPresentationIds = new Set<number>();
  const presentations = rawPresentations.map((line) => {
    const presentationId = Number(line.presentationId);
    const quantity = Number(line.quantity);
    const conversion = line.baseUnitsPerPresentation == null
      ? null
      : Number(line.baseUnitsPerPresentation);
    if (!Number.isSafeInteger(presentationId) || presentationId <= 0) {
      throw new Error('La captura contiene una presentación inválida.');
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Cada cantidad de presentación debe ser mayor que cero.');
    }
    if (conversion != null && (!Number.isFinite(conversion) || conversion <= 0)) {
      throw new Error('Cada conversión debe ser mayor que cero.');
    }
    if (seenPresentationIds.has(presentationId)) {
      throw new Error('Una presentación no puede repetirse.');
    }
    seenPresentationIds.add(presentationId);
    return {
      presentation_id: presentationId,
      quantity,
      base_units_per_presentation: conversion,
    };
  });

  if (quantityUnknown && (looseUnits !== 0 || presentations.length !== 0)) {
    throw new Error('Una cantidad desconocida no puede mezclarse con cantidades capturadas.');
  }
  if (!quantityUnknown && looseUnits === 0 && presentations.length === 0) {
    throw new Error('Indica presentaciones, unidades sueltas o marca la cantidad como desconocida.');
  }

  return {
    quantity_unknown: quantityUnknown,
    source_name: sourceName,
    loose_units: looseUnits,
    presentations,
  };
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

export async function saveInventoryCatalogDraftAction(input: { configuration: unknown }) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede guardar borradores del catálogo de inventario.');
  }

  if (!input || typeof input.configuration !== 'object' || input.configuration == null) {
    throw new Error('La configuración del borrador no es válida.');
  }

  let serializedConfiguration: string;
  try {
    serializedConfiguration = JSON.stringify(input.configuration);
  } catch {
    throw new Error('La configuración contiene datos que no se pueden guardar.');
  }

  if (serializedConfiguration.length > 200_000) {
    throw new Error('La configuración supera el tamaño permitido.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_save_catalog_draft_v1', {
    p_configuration: JSON.parse(serializedConfiguration),
  });

  if (error) {
    throw new Error(error.message);
  }

  const result = data as {
    entry_kind?: unknown;
    product_id?: unknown;
    inventory_item_id?: unknown;
    reused_product?: unknown;
  } | null;
  const entryKind: 'product' | 'item' = result?.entry_kind === 'product' ? 'product' : 'item';
  const productId = result?.product_id == null ? null : Number(result.product_id);
  const inventoryItemId = result?.inventory_item_id == null ? null : Number(result.inventory_item_id);

  if (entryKind === 'product' && (!Number.isSafeInteger(productId) || Number(productId) <= 0)) {
    throw new Error('Supabase no devolvió el producto configurado.');
  }
  if (entryKind === 'item' && (!Number.isSafeInteger(inventoryItemId) || Number(inventoryItemId) <= 0)) {
    throw new Error('Supabase no devolvió el ítem configurado.');
  }

  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/products');
  revalidatePath('/app/inventory/configure');

  return {
    entryKind,
    productId,
    inventoryItemId,
    reusedProduct: result?.reused_product === true,
  };
}

function revalidateInventoryConfigurationRoutes() {
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/products');
  revalidatePath('/app/inventory/configure');
  revalidatePath('/app/inventory/recipes');
  revalidatePath('/app/inventory/readiness');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
}

export async function updateInventoryProductIdentityAction(input: {
  productId: number;
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
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede modificar productos activos.');
  }

  const productId = normalizeCountId(input.productId);
  const name = normalizeOptionalText(input.name, 'El nombre', 160);
  const sku = normalizeOptionalText(input.sku, 'El SKU', 64);
  const unitsPerService = Number(input.unitsPerService);
  const detailUnitsLimit = Number(input.detailUnitsLimit);
  if (!name) throw new Error('El nombre es obligatorio.');
  if (!sku) throw new Error('El SKU es obligatorio.');
  if (!Number.isSafeInteger(unitsPerService) || unitsPerService < 0) {
    throw new Error('Las unidades por servicio deben ser un entero mayor o igual a cero.');
  }
  if (!Number.isSafeInteger(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('El límite seleccionable debe ser un entero mayor o igual a cero.');
  }
  const sourcePriceAmount = Number(input.sourcePriceAmount);
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El precio fuente debe ser mayor o igual a cero.');
  }
  if (!['USD', 'VES'].includes(input.sourcePriceCurrency)) {
    throw new Error('La moneda del precio fuente no es válida.');
  }
  if (!['default', 'fixed_item', 'fixed_order'].includes(input.commissionMode)) {
    throw new Error('La modalidad de comisión no es válida.');
  }
  const commissionValue = input.commissionMode === 'default'
    ? null
    : input.commissionValue == null
      ? null
      : Number(input.commissionValue);
  if (
    input.commissionMode !== 'default' &&
    (commissionValue == null ||
      !Number.isFinite(commissionValue) ||
      commissionValue < 0 ||
      commissionValue > 100)
  ) {
    throw new Error('La comisión específica debe ser un porcentaje entre 0 y 100.');
  }
  const commissionNotes = normalizeOptionalText(input.commissionNotes, 'La nota de comisión', 1000);
  const normalizeOptionalNonnegative = (value: number | null, label: string) => {
    if (value == null) return null;
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0) {
      throw new Error(`${label} debe ser mayor o igual a cero.`);
    }
    return normalized;
  };
  const advisorGiftCostUsd = normalizeOptionalNonnegative(
    input.advisorGiftCostUsd,
    'El costo para el asesor',
  );
  const internalRiderPayUsd = normalizeOptionalNonnegative(
    input.internalRiderPayUsd,
    'El pago interno de delivery',
  );

  const { data, error } = await ctx.supabase.rpc('inventory_update_product_identity_v1', {
    p_configuration: {
      product_id: productId,
      name,
      sku,
      units_per_service: unitsPerService,
      allows_half_service: input.allowsHalfService === true,
      is_temporary: input.isTemporary === true,
      detail_units_limit: detailUnitsLimit,
      source_price_amount: sourcePriceAmount,
      source_price_currency: input.sourcePriceCurrency,
      commission_mode: input.commissionMode,
      commission_value: commissionValue,
      commission_notes: commissionNotes,
      advisor_gift_cost_usd: advisorGiftCostUsd,
      internal_rider_pay_usd: internalRiderPayUsd,
    },
  });

  if (error) throw new Error(error.message);
  const result = data as {
    status?: string;
    product_id?: number;
    product_name?: string;
    previous_source_price_amount?: number | string;
    previous_source_price_currency?: string;
    source_price_amount?: number | string;
    source_price_currency?: string;
  } | null;

  await notifyCanonicalCatalogPriceChangeAction({
    productId,
    productName: String(result?.product_name || name),
    previousCurrency: result?.previous_source_price_currency === 'VES' ? 'VES' : 'USD',
    previousAmount: Number(result?.previous_source_price_amount ?? sourcePriceAmount),
    nextCurrency: result?.source_price_currency === 'VES' ? 'VES' : 'USD',
    nextAmount: Number(result?.source_price_amount ?? sourcePriceAmount),
  });
  revalidateInventoryConfigurationRoutes();
  return result;
}

export async function updateInventoryProductPhysicalConfigurationAction(input: {
  productId: number;
  inventoryPolicy: 'self' | 'direct' | 'components' | 'none';
  detailUnitsLimit: number;
  changeNote: string | null;
  links: Array<{
    inventoryItemId: number;
    quantityUnits: number;
    deductionStage: 'kitchen' | 'production' | 'packing' | 'fulfillment' | null;
  }>;
  components: Array<{
    componentProductId: number;
    componentMode: 'fixed' | 'selectable';
    quantity: number;
    countsTowardDetailLimit: boolean;
    isRequired: boolean;
  }>;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede versionar la configuración física.');
  }

  const productId = normalizeCountId(input.productId);
  if (!['self', 'direct', 'components', 'none'].includes(input.inventoryPolicy)) {
    throw new Error('La política física no es válida.');
  }
  const detailUnitsLimit = Number(input.detailUnitsLimit);
  if (!Number.isSafeInteger(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('El límite seleccionable debe ser un entero mayor o igual a cero.');
  }
  if (!Array.isArray(input.links) || input.links.length > 50) {
    throw new Error('La configuración admite hasta 50 consumos directos.');
  }
  if (!Array.isArray(input.components) || input.components.length > 100) {
    throw new Error('La configuración admite hasta 100 componentes.');
  }

  const seenItems = new Set<number>();
  const links = input.links.map((line) => {
    const inventoryItemId = normalizeCountId(line.inventoryItemId);
    if (seenItems.has(inventoryItemId)) {
      throw new Error('Un ítem físico no puede repetirse.');
    }
    seenItems.add(inventoryItemId);
    if (line.deductionStage != null && !['kitchen', 'production', 'packing', 'fulfillment'].includes(line.deductionStage)) {
      throw new Error('La etapa de descuento no es válida.');
    }
    return {
      inventory_item_id: inventoryItemId,
      quantity_units: normalizePositiveQuantity(line.quantityUnits, 'La cantidad descontada'),
      deduction_stage: line.deductionStage,
    };
  });

  const seenComponents = new Set<string>();
  const components = input.components.map((line) => {
    const componentProductId = normalizeCountId(line.componentProductId);
    if (!['fixed', 'selectable'].includes(line.componentMode)) {
      throw new Error('El modo del componente no es válido.');
    }
    const key = `${componentProductId}:${line.componentMode}`;
    if (seenComponents.has(key)) {
      throw new Error('Un componente no puede repetirse con el mismo modo.');
    }
    seenComponents.add(key);
    return {
      component_product_id: componentProductId,
      component_mode: line.componentMode,
      quantity: normalizePositiveQuantity(line.quantity, 'La cantidad del componente'),
      counts_toward_detail_limit: line.countsTowardDetailLimit === true,
      is_required: line.isRequired === true,
    };
  });

  const { data, error } = await ctx.supabase.rpc(
    'inventory_update_product_physical_configuration_v1',
    {
      p_configuration: {
        product_id: productId,
        inventory_policy: input.inventoryPolicy,
        detail_units_limit: detailUnitsLimit,
        change_note: normalizeNotes(input.changeNote),
        links: input.inventoryPolicy === 'self' || input.inventoryPolicy === 'direct' ? links : [],
        components: input.inventoryPolicy === 'components' ? components : [],
      },
    },
  );

  if (error) throw new Error(error.message);
  revalidateInventoryConfigurationRoutes();
  return data as {
    status?: string;
    product_id?: number;
    previous_revision?: number;
    revision?: number;
    inventory_policy?: string;
    orders_blocked?: boolean;
    committed_orders_keep_snapshot?: boolean;
  } | null;
}

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
  notes: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede modificar controles de inventario.');
  }

  const inventoryItemId = normalizeCountId(input.inventoryItemId);
  const name = normalizeOptionalText(input.name, 'El nombre', 160);
  const notes = normalizeNotes(input.notes);
  if (!name) throw new Error('El nombre es obligatorio.');

  const optionalNonnegative = (value: number | null, label: string) => {
    if (value == null) return null;
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0) {
      throw new Error(`${label} debe ser mayor o igual a cero.`);
    }
    return normalized;
  };

  const lowStockThreshold = optionalNonnegative(input.lowStockThreshold, 'La alerta mínima');
  const targetStockUnits = optionalNonnegative(input.targetStockUnits, 'El stock objetivo');
  const shelfLifeDays = optionalNonnegative(input.shelfLifeDays, 'La vida útil');
  if (shelfLifeDays != null && !Number.isSafeInteger(shelfLifeDays)) {
    throw new Error('La vida útil debe expresarse en días enteros.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_update_item_controls_v1', {
    p_configuration: {
      inventory_item_id: inventoryItemId,
      name,
      availability_mode: input.availabilityMode,
      low_stock_threshold: lowStockThreshold,
      low_stock_inclusive: input.lowStockInclusive === true,
      target_stock_units: targetStockUnits,
      shelf_life_days: shelfLifeDays,
      primary_count_frequency: input.primaryCountFrequency,
      primary_count_role: input.primaryCountRole,
      notes,
    },
  });

  if (error) throw new Error(error.message);
  revalidateInventoryConfigurationRoutes();
  return data as { status?: string; inventory_item_id?: number } | null;
}

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
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede guardar versiones de recetas.');
  }

  const draftRecipeId = input.draftRecipeId == null
    ? null
    : normalizeCountId(input.draftRecipeId);
  const sourceRecipeId = input.sourceRecipeId == null
    ? null
    : normalizeCountId(input.sourceRecipeId);
  const outputInventoryItemId = normalizeCountId(input.outputInventoryItemId);
  if (!['production', 'packaging'].includes(input.recipeKind)) {
    throw new Error('El tipo de receta no es válido.');
  }

  const outputQuantityUnits = normalizePositiveQuantity(
    input.outputQuantityUnits,
    'La salida de la receta',
  );
  const productionMultiple = normalizePositiveQuantity(
    input.productionMultiple,
    'El múltiplo de producción',
  );
  const leadTimeMinutes = Number(input.leadTimeMinutes);
  if (!Number.isSafeInteger(leadTimeMinutes) || leadTimeMinutes < 0 || leadTimeMinutes > 43_200) {
    throw new Error('El tiempo debe ser un entero entre 0 y 43.200 minutos.');
  }
  const notes = normalizeNotes(input.notes);

  if (!Array.isArray(input.components) || input.components.length < 1 || input.components.length > 50) {
    throw new Error('La receta requiere entre 1 y 50 insumos.');
  }
  const seenItemIds = new Set<number>();
  const components = input.components.map((component) => {
    const inputInventoryItemId = normalizeCountId(component.inputInventoryItemId);
    const quantityUnits = normalizePositiveQuantity(component.quantityUnits, 'La cantidad del insumo');
    if (inputInventoryItemId === outputInventoryItemId) {
      throw new Error('La receta no puede consumir su propio ítem de salida.');
    }
    if (seenItemIds.has(inputInventoryItemId)) {
      throw new Error('Un insumo no puede repetirse en la misma receta.');
    }
    seenItemIds.add(inputInventoryItemId);
    return {
      input_inventory_item_id: inputInventoryItemId,
      quantity_units: quantityUnits,
    };
  });

  const { data, error } = await ctx.supabase.rpc('inventory_save_recipe_draft_v1', {
    p_configuration: {
      draft_recipe_id: draftRecipeId,
      source_recipe_id: sourceRecipeId,
      output_inventory_item_id: outputInventoryItemId,
      recipe_kind: input.recipeKind,
      output_quantity_units: outputQuantityUnits,
      lead_time_minutes: leadTimeMinutes,
      production_multiple: productionMultiple,
      notes,
      components,
    },
  });

  if (error) throw new Error(error.message);
  revalidateInventoryConfigurationRoutes();
  return data as {
    status?: string;
    recipe_id?: number;
    version?: number;
    operational_recipe_unchanged?: boolean;
  } | null;
}

export async function submitInventoryDraftOpeningAction(input: {
  operationId: string;
  inventoryItemId: number;
  countedQuantityUnits: number;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede presentar la apertura incremental de un borrador.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeCountId(input.inventoryItemId);
  const countedQuantityUnits = Number(input.countedQuantityUnits);
  const notes = normalizeNotes(input.notes);

  if (!Number.isFinite(countedQuantityUnits) || countedQuantityUnits < 0) {
    throw new Error('La existencia inicial debe ser mayor o igual a cero.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_submit_draft_opening_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_counted_quantity_units: countedQuantityUnits,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  const countId = normalizeCountId(
    (data as { inventory_count_id?: unknown } | null)?.inventory_count_id,
  );
  revalidateInventoryCountRoutes(countId);
  revalidatePath('/app/inventory/configure');
  return { countId };
}

export async function activateInventoryDraftAction(input: {
  productId?: number | null;
  inventoryItemId?: number | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede activar borradores de inventario.');
  }

  const hasProduct = input.productId != null;
  const hasItem = input.inventoryItemId != null;
  if (hasProduct === hasItem) {
    throw new Error('Indica exactamente un producto o un ítem para activar.');
  }

  const rpcName = hasProduct
    ? 'inventory_activate_product_draft_v1'
    : 'inventory_activate_item_draft_v1';
  const rpcArguments = hasProduct
    ? { p_product_id: normalizeCountId(input.productId) }
    : { p_inventory_item_id: normalizeCountId(input.inventoryItemId) };
  const { data, error } = await ctx.supabase.rpc(rpcName, rpcArguments);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/products');
  revalidatePath('/app/inventory/configure');
  revalidatePath('/app/inventory/opening');

  return data as {
    status?: string;
    product_id?: number;
    inventory_item_id?: number;
  } | null;
}

export async function submitInventoryOpeningAction(input: {
  operationId: string;
  lines: CountLineInput[];
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede presentar el conteo físico de apertura.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const lines = normalizeLines(input.lines);
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_submit_count_v1', {
    p_operation_id: operationId,
    p_count_kind: 'opening',
    p_lines: serializeLines(lines),
    p_notes: notes,
    p_parent_count_id: null,
    p_existing_count_id: null,
  });

  if (error) {
    throw new Error(error.message);
  }

  const countId = normalizeCountId((data as { inventory_count_id?: unknown } | null)?.inventory_count_id);
  revalidateInventoryCountRoutes(countId);
  return { countId };
}

export async function submitInventoryAdministrativeCountAction(input: {
  operationId: string;
  lines: CountLineInput[];
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede registrar este conteo físico puntual.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const lines = normalizeLines(input.lines);
  const notes = normalizeNotes(input.notes);
  const { data, error } = await ctx.supabase.rpc('inventory_submit_count_v1', {
    p_operation_id: operationId,
    p_count_kind: 'requested',
    p_lines: serializeLines(lines),
    p_notes: notes,
    p_parent_count_id: null,
    p_existing_count_id: null,
  });

  if (error) throw new Error(error.message);

  const countId = normalizeCountId(
    (data as { inventory_count_id?: unknown } | null)?.inventory_count_id,
  );
  revalidateInventoryCountRoutes(countId);
  revalidatePath('/app/inventory/adjustments');
  return { countId };
}

export async function adjustInventoryStockAction(input: {
  operationId: string;
  inventoryItemId: number;
  targetQuantityUnits: number;
  reasonCode: string;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede crear ajustes directos de inventario.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeCountId(input.inventoryItemId);
  const targetQuantityUnits = Number(input.targetQuantityUnits);
  if (!Number.isFinite(targetQuantityUnits) || targetQuantityUnits < 0) {
    throw new Error('La existencia objetivo debe ser un número mayor o igual a cero.');
  }
  const reasonCode = String(input.reasonCode ?? '').trim();
  if (!reasonCode || reasonCode.length > 80) {
    throw new Error('Selecciona un motivo válido para el ajuste.');
  }
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_adjust_stock_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_target_quantity_units: targetQuantityUnits,
    p_reason_code: reasonCode,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);

  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/adjustments');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
  revalidatePath('/app/master/ops/inventory');
  return data as Record<string, unknown> | null;
}

export async function submitInventoryOpenCountAction(input: {
  operationId: string;
  countId: number;
  countKind: 'recount' | 'requested' | 'periodic' | 'shift_change';
  lines: CountLineInput[];
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Este conteo abierto debe registrarlo administración desde el Centro de Inventario.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const countId = normalizeCountId(input.countId);
  const lines = normalizeLines(input.lines);
  const notes = normalizeNotes(input.notes);
  const allowedKinds = new Set(['recount', 'requested', 'periodic', 'shift_change']);
  if (!allowedKinds.has(input.countKind)) {
    throw new Error('El tipo de conteo abierto no es válido.');
  }

  const { data, error } = input.countKind === 'recount'
    ? await ctx.supabase.rpc('inventory_submit_staged_recount_v1', {
        p_operation_id: operationId,
        p_existing_count_id: countId,
        p_lines: serializeLines(lines),
        p_notes: notes,
      })
    : await ctx.supabase.rpc('inventory_submit_count_v1', {
        p_operation_id: operationId,
        p_count_kind: input.countKind,
        p_lines: serializeLines(lines),
        p_notes: notes,
        p_parent_count_id: null,
        p_existing_count_id: countId,
      });

  if (error) {
    throw new Error(error.message);
  }

  const returnedCountId = normalizeCountId(
    (data as { inventory_count_id?: unknown } | null)?.inventory_count_id,
  );
  revalidateInventoryCountRoutes(returnedCountId);
  return { countId: returnedCountId };
}

export async function reviewInventoryCountAction(input: {
  countId: number;
  action: 'accept' | 'request_recount';
  lineIds?: number[];
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const countId = normalizeCountId(input.countId);
  const notes = normalizeNotes(input.notes);
  if (!['accept', 'request_recount'].includes(input.action)) {
    throw new Error('La acción de revisión no es válida.');
  }

  let lineIds: number[] | null = null;
  if (input.action === 'request_recount') {
    if (!Array.isArray(input.lineIds) || input.lineIds.length === 0) {
      throw new Error('Selecciona al menos un ítem para solicitar el reconteo.');
    }
    lineIds = Array.from(new Set(input.lineIds.map(normalizeCountId)));
    if (lineIds.length !== input.lineIds.length) {
      throw new Error('Una línea no puede repetirse en la solicitud de reconteo.');
    }
  }

  const { data, error } = await ctx.supabase.rpc('inventory_review_count_v1', {
    p_inventory_count_id: countId,
    p_action: input.action,
    p_line_ids: lineIds,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rawRecountId = (data as { recount_inventory_count_id?: unknown } | null)
    ?.recount_inventory_count_id;
  const recountCountId = rawRecountId == null ? null : normalizeCountId(rawRecountId);
  revalidateInventoryCountRoutes(countId);
  if (recountCountId != null) {
    revalidateInventoryCountRoutes(recountCountId);
    try {
      await sendPushToRoleDevices({
        roles: ['kitchen'],
        title: 'Reconteo solicitado',
        body: `Master solicito revisar nuevamente el conteo #${countId}.`,
        url: '/app/kitchen/inventory/counts',
        tag: `kitchen-inventory-recount-${recountCountId}`,
        tone: 'warning',
        requireInteraction: true,
      });
    } catch (pushError) {
      console.warn(
        'kitchen inventory recount push skipped',
        pushError instanceof Error ? pushError.message : 'unknown push error',
      );
    }
  }

  return { countId, recountCountId };
}

export async function saveInventoryExpectedReceiptAction(input: {
  operationId: string;
  inventoryItemId: number;
  effectiveAt: string;
  capture: ReceiptCaptureInput;
  notes?: string | null;
  replacesFlowId?: number | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeCountId(input.inventoryItemId);
  const effectiveAt = normalizeDateTime(input.effectiveAt, 'La fecha esperada');
  const capture = normalizeReceiptCapture(input.capture, true);
  const notes = normalizeNotes(input.notes);
  const replacesFlowId = input.replacesFlowId == null
    ? null
    : normalizeCountId(input.replacesFlowId);

  const { data, error } = await ctx.supabase.rpc('inventory_save_expected_receipt_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_effective_at: effectiveAt,
    p_capture: capture,
    p_notes: notes,
    p_replaces_flow_id: replacesFlowId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const expectedFlowId = normalizeCountId(
    (data as { expected_flow_id?: unknown } | null)?.expected_flow_id,
  );
  try {
    await sendPushToRoleDevices({
      roles: ['kitchen'],
      title: 'Mercancia esperada',
      body: 'Master registro una recepcion pendiente para Cocina.',
      url: '/app/kitchen/inventory/receipts',
      tag: `kitchen-inventory-receipt-${expectedFlowId}`,
      tone: 'info',
      requireInteraction: false,
    });
  } catch (pushError) {
    console.warn(
      'kitchen expected receipt push skipped',
      pushError instanceof Error ? pushError.message : 'unknown push error',
    );
  }
  revalidateInventoryReceiptRoutes();
  return { expectedFlowId };
}

export async function cancelInventoryExpectedReceiptAction(input: {
  expectedFlowId: number;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const expectedFlowId = normalizeCountId(input.expectedFlowId);
  const notes = normalizeNotes(input.notes);

  const { error } = await ctx.supabase.rpc('inventory_cancel_expected_receipt_v1', {
    p_expected_flow_id: expectedFlowId,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryReceiptRoutes();
  return { expectedFlowId };
}

export async function receiveInventoryStockAction(input: {
  operationId: string;
  inventoryItemId: number;
  expectedFlowId?: number | null;
  capture: ReceiptCaptureInput;
  lotCode?: string | null;
  receivedAt?: string | null;
  expiresAt?: string | null;
  notes?: string | null;
}) {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    throw new Error('Solo cocina o administración pueden registrar mercancía recibida.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeCountId(input.inventoryItemId);
  const expectedFlowId = input.expectedFlowId == null
    ? null
    : normalizeCountId(input.expectedFlowId);
  const capture = normalizeReceiptCapture(input.capture, false);
  const lotCode = normalizeOptionalText(input.lotCode, 'El código de lote', 120);
  const receivedAt = input.receivedAt
    ? normalizeDateTime(input.receivedAt, 'La fecha de recepción')
    : new Date().toISOString();
  const expiresAt = input.expiresAt
    ? normalizeDateTime(input.expiresAt, 'La fecha de vencimiento')
    : null;
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_reconcile_receipt_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_capture: capture,
    p_expected_flow_id: expectedFlowId,
    p_lot_code: lotCode,
    p_received_at: receivedAt,
    p_expires_at: expiresAt,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  const result = data as {
    inventory_lot_id?: unknown;
    received_quantity_units?: unknown;
    difference_quantity_units?: unknown;
    expected_flow_status?: unknown;
  } | null;
  const inventoryLotId = normalizeCountId(result?.inventory_lot_id);
  revalidateInventoryReceiptRoutes();

  return {
    inventoryLotId,
    receivedQuantityUnits: Number(result?.received_quantity_units ?? 0),
    differenceQuantityUnits: result?.difference_quantity_units == null
      ? null
      : Number(result.difference_quantity_units),
    expectedFlowStatus: result?.expected_flow_status == null
      ? null
      : String(result.expected_flow_status),
  };
}

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
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const orderId = normalizeCountId(input.orderId);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new Error('El despacho debe incluir entre 1 y 100 ítems.');
  }
  const seenItems = new Set<number>();
  const lines = input.lines.map((line) => {
    const inventoryItemId = normalizeCountId(line.inventoryItemId);
    if (seenItems.has(inventoryItemId)) throw new Error('Un ítem no puede repetirse en el despacho.');
    seenItems.add(inventoryItemId);
    return {
      inventory_item_id: inventoryItemId,
      quantity_units: normalizePositiveQuantity(line.quantityUnits, 'La cantidad despachada'),
    };
  });

  const { data, error } = await ctx.supabase.rpc(
    'inventory_dispatch_event_stock_v1',
    {
      p_operation_id: operationId,
      p_order_id: orderId,
      p_lines: lines,
      p_notes: normalizeNotes(input.notes),
    },
  );
  if (error) throw new Error(error.message);
  revalidateInventoryEventRoutes(orderId);
  return data as { status?: string; event_id?: number; order_id?: number; lines?: unknown[] } | null;
}

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
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const dispatchOperationId = normalizeOperationId(input.dispatchOperationId);
  const orderId = normalizeCountId(input.orderId);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new Error('La conciliación debe incluir todos los ítems despachados.');
  }
  const seenItems = new Set<number>();
  const lines = input.lines.map((line) => {
    const inventoryItemId = normalizeCountId(line.inventoryItemId);
    if (seenItems.has(inventoryItemId)) throw new Error('Un ítem no puede repetirse en la conciliación.');
    seenItems.add(inventoryItemId);
    const returned = Number(line.returnedQuantityUnits);
    const lost = Number(line.lossQuantityUnits);
    if (!Number.isFinite(returned) || returned < 0 || !Number.isFinite(lost) || lost < 0) {
      throw new Error('Las cantidades devueltas y perdidas deben ser mayores o iguales a cero.');
    }
    if (!['damage', 'waste'].includes(line.lossKind)) throw new Error('El tipo de pérdida no es válido.');
    return {
      inventory_item_id: inventoryItemId,
      returned_quantity_units: returned,
      loss_quantity_units: lost,
      loss_kind: line.lossKind,
    };
  });

  const { data, error } = await ctx.supabase.rpc('inventory_reconcile_event_stock_v1', {
    p_operation_id: operationId,
    p_dispatch_operation_id: dispatchOperationId,
    p_lines: lines,
    p_notes: normalizeNotes(input.notes),
  });
  if (error) throw new Error(error.message);
  revalidateInventoryEventRoutes(orderId);
  return data as {
    status?: string;
    event_id?: number;
    order_id?: number;
    commitment_mismatch?: boolean;
    orders_blocked?: boolean;
  } | null;
}

export async function activateInventoryRecipeAction(input: { recipeId: number }) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede activar recetas de inventario.');
  }

  const recipeId = normalizeCountId(input.recipeId);
  const { data, error } = await ctx.supabase.rpc('inventory_activate_recipe_v1', {
    p_recipe_id: recipeId,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryProductionRoutes();
  revalidatePath('/app/inventory/configure');
  revalidatePath('/app/inventory/readiness');
  revalidatePath('/app/inventory/reports');
  return data as { status?: string; recipe_id?: number } | null;
}

export async function activateAllCanonicalInventoryRecipesAction() {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede activar todas las recetas canónicas.');
  }

  const { data, error } = await ctx.supabase.rpc(
    'inventory_activate_canonical_recipes_v1',
  );

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryProductionRoutes();
  revalidatePath('/app/inventory/readiness');
  revalidatePath('/app/inventory/opening');
  revalidatePath('/app/inventory/reports');
  return data as {
    status?: string;
    canonical_recipe_count?: number;
    active_recipe_count?: number;
    activated_recipe_count?: number;
  } | null;
}

export async function startInventoryProductionAction(input: {
  operationId: string;
  recipeId: number;
  batchMultiplier: number;
  declaredOutputUnits?: number | null;
  notes?: string | null;
}) {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    throw new Error('Solo cocina o administración pueden iniciar preparaciones.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const recipeId = normalizeCountId(input.recipeId);
  const batchMultiplier = normalizePositiveQuantity(
    input.batchMultiplier,
    'El multiplicador de producción',
  );
  const declaredOutputUnits = input.declaredOutputUnits == null
    ? null
    : normalizePositiveQuantity(input.declaredOutputUnits, 'La salida real');
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_start_recipe_v2', {
    p_operation_id: operationId,
    p_recipe_id: recipeId,
    p_batch_multiplier: batchMultiplier,
    p_declared_output_units: declaredOutputUnits,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryProductionRoutes();
  return data as {
    status?: string;
    availability_mode?: 'immediate' | 'scheduled';
    production_flow_id?: number;
    inventory_lot_id?: number;
  } | null;
}

export async function completeInventoryProductionAction(input: {
  operationId: string;
  productionFlowId: number;
  actualOutputUnits: number;
  notes?: string | null;
}) {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    throw new Error('Solo cocina o administración pueden terminar preparaciones.');
  }

  const operationId = normalizeOperationId(input.operationId);
  const productionFlowId = normalizeCountId(input.productionFlowId);
  const actualOutputUnits = normalizePositiveQuantity(
    input.actualOutputUnits,
    'La salida real',
  );
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_complete_production_v1', {
    p_operation_id: operationId,
    p_production_flow_id: productionFlowId,
    p_actual_output_units: actualOutputUnits,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryProductionRoutes();
  return data as { status?: string; inventory_lot_id?: number } | null;
}

export async function resolveInventoryProductionAction(input: {
  productionFlowId: number;
  resolution: 'failed' | 'cancelled';
  notes?: string | null;
}) {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    throw new Error('Solo cocina o administración pueden resolver preparaciones.');
  }
  if (input.resolution === 'cancelled' && !ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede anular una preparación iniciada.');
  }

  const productionFlowId = normalizeCountId(input.productionFlowId);
  const notes = normalizeNotes(input.notes);
  const { data, error } = await ctx.supabase.rpc('inventory_resolve_production_v1', {
    p_production_flow_id: productionFlowId,
    p_resolution: input.resolution,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidateInventoryProductionRoutes();
  return data as { status?: string; resolution?: string } | null;
}

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

export async function refreshInventoryAlertsAction() {
  const ctx = await requireMasterOrAdminContext();
  const { data, error } = await ctx.supabase.rpc('inventory_refresh_alerts_v1');
  if (error) throw new Error(error.message);
  revalidateInventoryAlertRoutes();
  return data as {
    detected_or_updated?: number;
    automatically_resolved?: number;
    refreshed_at?: string;
  } | null;
}

export async function saveInventoryAlertPolicyAction(input: {
  category: InventoryAlertCategory;
  inventoryItemId?: number | null;
  isEnabled: boolean;
  routes: InventoryAlertRouteInput[];
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede configurar alertas de inventario.');
  }

  const category = normalizeInventoryAlertCategory(input.category);
  const inventoryItemId = input.inventoryItemId == null
    ? null
    : normalizeCountId(input.inventoryItemId);
  const routes = normalizeInventoryAlertRoutes(input.routes);
  if (input.isEnabled && routes.length === 0) {
    throw new Error('Una política activa requiere al menos una ruta.');
  }
  if (!input.isEnabled && routes.length > 0) {
    throw new Error('Una política desactivada no debe conservar rutas.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_save_alert_policy_v1', {
    p_alert_category: category,
    p_inventory_item_id: inventoryItemId,
    p_is_enabled: input.isEnabled,
    p_routes: routes.map((route) => ({
      target_role: route.targetRole,
      surface: route.surface,
    })),
  });
  if (error) throw new Error(error.message);
  revalidateInventoryAlertRoutes();
  return data as { status?: string; policy_id?: number } | null;
}

export async function deleteInventoryAlertPolicyOverrideAction(input: {
  category: InventoryAlertCategory;
  inventoryItemId: number;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede eliminar excepciones de alertas.');
  }

  const { data, error } = await ctx.supabase.rpc(
    'inventory_delete_alert_policy_override_v1',
    {
      p_alert_category: normalizeInventoryAlertCategory(input.category),
      p_inventory_item_id: normalizeCountId(input.inventoryItemId),
    },
  );
  if (error) throw new Error(error.message);
  revalidateInventoryAlertRoutes();
  return data as { status?: string } | null;
}

export async function updateInventoryItemAlertSettingsAction(input: {
  inventoryItemId: number;
  lowStockThreshold?: number | string | null;
  lowStockInclusive: boolean;
  targetStockUnits?: number | string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede cambiar umbrales y objetivos.');
  }

  const lowStockThreshold = normalizeNullableNonnegativeNumber(
    input.lowStockThreshold,
    'El umbral',
  );
  const targetStockUnits = normalizeNullableNonnegativeNumber(
    input.targetStockUnits,
    'El objetivo',
  );
  if (
    lowStockThreshold != null
    && targetStockUnits != null
    && targetStockUnits < lowStockThreshold
  ) {
    throw new Error('El objetivo no puede ser menor que el umbral.');
  }

  const { data, error } = await ctx.supabase.rpc(
    'inventory_update_item_alert_settings_v1',
    {
      p_inventory_item_id: normalizeCountId(input.inventoryItemId),
      p_low_stock_threshold: lowStockThreshold,
      p_low_stock_inclusive: input.lowStockInclusive === true,
      p_target_stock_units: targetStockUnits,
    },
  );
  if (error) throw new Error(error.message);
  revalidateInventoryAlertRoutes();
  return data as { status?: string } | null;
}

export async function updateInventoryAlertStatusAction(input: {
  alertId: number;
  action: 'manage' | 'resolve' | 'reopen';
  note?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  if (!['manage', 'resolve', 'reopen'].includes(input.action)) {
    throw new Error('La acción de alerta no es válida.');
  }
  if ((input.action === 'resolve' || input.action === 'reopen') && !ctx.roles.includes('admin')) {
    throw new Error('Solo administración puede resolver o reabrir manualmente una alerta.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_update_alert_status_v1', {
    p_alert_id: normalizeCountId(input.alertId),
    p_action: input.action,
    p_note: normalizeNotes(input.note),
  });
  if (error) throw new Error(error.message);
  revalidateInventoryAlertRoutes();
  return data as { status?: string; alert_status?: string } | null;
}

export type InventoryKardexCursor = {
  beforeCreatedAt: string;
  beforeId: number;
};

export async function loadInventoryKardexPageAction(input: {
  inventoryItemId?: number | null;
  cursor?: InventoryKardexCursor | null;
  limit?: number;
}) {
  const ctx = await requireMasterOrAdminContext();
  const inventoryItemId = input.inventoryItemId == null
    ? null
    : normalizeCountId(input.inventoryItemId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('El límite del kardex debe estar entre 1 y 200.');
  }

  let beforeCreatedAt: string | null = null;
  let beforeId: number | null = null;
  if (input.cursor) {
    const parsedDate = new Date(input.cursor.beforeCreatedAt);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error('La fecha del cursor del kardex no es válida.');
    }
    beforeCreatedAt = parsedDate.toISOString();
    beforeId = normalizeCountId(input.cursor.beforeId);
  }

  const { data, error } = await ctx.supabase.rpc('inventory_kardex_page_v1', {
    p_inventory_item_id: inventoryItemId,
    p_before_created_at: beforeCreatedAt,
    p_before_id: beforeId,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  return data as {
    items?: Array<Record<string, unknown>>;
    next_cursor?: {
      before_created_at?: string;
      before_id?: number;
    } | null;
  } | null;
}
