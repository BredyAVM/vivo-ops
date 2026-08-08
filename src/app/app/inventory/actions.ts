'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext, requireMasterOrAdminContext } from '@/lib/auth';

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
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/operations');
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
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/opening');
  revalidatePath('/app/inventory/counts');
  revalidatePath(`/app/inventory/counts/${countId}`);
  revalidatePath('/app/inventory/operations');
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
