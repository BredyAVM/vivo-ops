'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';
import { sendPushToRoleDevices } from '@/lib/push';

function normalizeOperationId(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('La clave de operación no es válida. Actualiza la página e inténtalo nuevamente.');
  }
  return normalized;
}

function normalizeItemIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error('Selecciona entre 1 y 200 ítems.');
  }

  const itemIds = value.map((rawItemId) => {
    const itemId = Number(rawItemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new Error('La selección contiene un ítem inválido.');
    }
    return itemId;
  });

  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error('Un ítem no puede repetirse en la misma solicitud.');
  }

  return itemIds;
}

function normalizeItemId(value: unknown) {
  const itemId = Number(value);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error('El ítem seleccionado no es válido.');
  }
  return itemId;
}

function normalizePositiveQuantity(value: unknown) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('La cantidad esperada debe ser mayor que cero.');
  }
  return quantity;
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} admite hasta ${maxLength.toLocaleString('es-VE')} caracteres.`);
  }
  return normalized || null;
}

function normalizeDueAt(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  const dueAt = new Date(normalized);
  if (!Number.isFinite(dueAt.getTime())) {
    throw new Error('La fecha límite no es válida.');
  }
  if (dueAt.getTime() < Date.now()) {
    throw new Error('La fecha límite no puede estar en el pasado.');
  }
  return dueAt.toISOString();
}

function normalizeNotes(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > 1000) {
    throw new Error('La nota admite hasta 1.000 caracteres.');
  }
  return normalized;
}

function revalidateMasterInventory(countId: number) {
  revalidatePath('/app/master/ops/inventory');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/kitchen/inventory/counts');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/counts');
  revalidatePath(`/app/inventory/counts/${countId}`);
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
}

function revalidateMasterInventoryWorkspace() {
  revalidatePath('/app/master/ops');
  revalidatePath('/app/master/ops/inventory');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/kitchen/inventory/receipts');
}

export async function requestMasterInventoryCountAction(input: {
  operationId: string;
  inventoryItemIds: number[];
  dueAt?: string | null;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemIds = normalizeItemIds(input.inventoryItemIds);
  const dueAt = normalizeDueAt(input.dueAt);
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_request_count_v1', {
    p_operation_id: operationId,
    p_inventory_item_ids: inventoryItemIds,
    p_due_at: dueAt,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);

  const countId = Number((data as { inventory_count_id?: unknown } | null)?.inventory_count_id);
  if (!Number.isSafeInteger(countId) || countId <= 0) {
    throw new Error('Supabase no devolvió el conteo solicitado.');
  }

  try {
    await sendPushToRoleDevices({
      roles: ['kitchen'],
      title: 'Nuevo conteo solicitado',
      body: `Master solicito contar ${inventoryItemIds.length} item${inventoryItemIds.length === 1 ? '' : 's'}.`,
      url: '/app/kitchen/inventory/counts',
      tag: `kitchen-inventory-count-${countId}`,
      tone: 'warning',
      requireInteraction: true,
    });
  } catch (pushError) {
    console.warn(
      'kitchen inventory count push skipped',
      pushError instanceof Error ? pushError.message : 'unknown push error',
    );
  }

  revalidateMasterInventory(countId);
  return { countId };
}

export async function saveMasterInventoryExpectedReceiptAction(input: {
  operationId: string;
  inventoryItemId: number;
  effectiveAt: string;
  quantityUnits?: number | null;
  quantityUnknown?: boolean;
  sourceName?: string | null;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeItemId(input.inventoryItemId);
  const effectiveAt = normalizeDueAt(input.effectiveAt);
  if (!effectiveAt) throw new Error('Indica cuándo se espera la mercancía.');

  const quantityUnknown = input.quantityUnknown === true;
  const quantityUnits = quantityUnknown ? null : normalizePositiveQuantity(input.quantityUnits);
  const sourceName = normalizeOptionalText(input.sourceName, 'La fuente', 160);
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_save_expected_receipt_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_effective_at: effectiveAt,
    p_capture: {
      quantity_unknown: quantityUnknown,
      source_name: sourceName,
      loose_units: quantityUnits ?? 0,
      presentations: [],
    },
    p_notes: notes,
    p_replaces_flow_id: null,
  });

  if (error) throw new Error(error.message);

  const expectedFlowId = normalizeItemId(
    (data as { expected_flow_id?: unknown } | null)?.expected_flow_id,
  );

  try {
    await sendPushToRoleDevices({
      roles: ['kitchen'],
      title: 'Mercancía esperada',
      body: 'Máster registró una recepción pendiente para Cocina.',
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

  revalidateMasterInventoryWorkspace();
  return { expectedFlowId };
}

export async function cancelMasterInventoryExpectedReceiptAction(input: {
  expectedFlowId: number;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const expectedFlowId = normalizeItemId(input.expectedFlowId);
  const notes = normalizeNotes(input.notes);

  const { error } = await ctx.supabase.rpc('inventory_cancel_expected_receipt_v1', {
    p_expected_flow_id: expectedFlowId,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);
  revalidateMasterInventoryWorkspace();
  return { expectedFlowId };
}

export async function saveMasterInventorySuspensionAction(input: {
  operationId: string;
  inventoryItemId: number;
  availableFrom?: string | null;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const operationId = normalizeOperationId(input.operationId);
  const inventoryItemId = normalizeItemId(input.inventoryItemId);
  const availableFrom = input.availableFrom == null || String(input.availableFrom).trim() === ''
    ? null
    : normalizeDueAt(input.availableFrom);
  const notes = normalizeNotes(input.notes);

  const { data, error } = await ctx.supabase.rpc('inventory_save_declared_unavailability_v1', {
    p_operation_id: operationId,
    p_inventory_item_id: inventoryItemId,
    p_available_from: availableFrom,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);
  const suspensionId = normalizeItemId(
    (data as { unavailability_flow_id?: unknown } | null)?.unavailability_flow_id,
  );
  revalidateMasterInventoryWorkspace();
  revalidatePath('/app/advisor/new');
  revalidatePath('/app/counter');
  return { suspensionId };
}

export async function cancelMasterInventorySuspensionAction(input: {
  suspensionId: number;
  notes?: string | null;
}) {
  const ctx = await requireMasterOrAdminContext();
  const suspensionId = normalizeItemId(input.suspensionId);
  const notes = normalizeNotes(input.notes);

  const { error } = await ctx.supabase.rpc('inventory_cancel_declared_unavailability_v1', {
    p_unavailability_flow_id: suspensionId,
    p_notes: notes,
  });

  if (error) throw new Error(error.message);
  revalidateMasterInventoryWorkspace();
  revalidatePath('/app/advisor/new');
  revalidatePath('/app/counter');
  return { suspensionId };
}
