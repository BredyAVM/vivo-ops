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

function normalizeNonNegativeQuantity(value: unknown, label: string) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`${label} debe ser cero o una cantidad positiva.`);
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
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveMasterInventoryExpectedReceiptAction(input: {
  operationId: string;
  inventoryItemId: number;
  effectiveAt: string;
  quantityUnits?: number | null;
  quantityUnknown?: boolean;
  sourceName?: string | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelMasterInventoryExpectedReceiptAction(input: {
  expectedFlowId: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveMasterInventoryProtectedBalanceAction(input: {
  operationId: string;
  primaryInventoryItemId: number;
  expectedFlowId?: number | null;
  safetyReserveUnits?: number | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveMasterInventorySuspensionAction(input: {
  operationId: string;
  inventoryItemId: number;
  availableFrom?: string | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveMasterInventoryProductSuspensionAction(input: {
  operationId: string;
  productId: number;
  availableFrom?: string | null;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelMasterInventorySuspensionAction(input: {
  suspensionId: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
