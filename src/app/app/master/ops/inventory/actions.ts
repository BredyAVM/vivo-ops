'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

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
  revalidatePath('/app/kitchen/inventory/counts');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/counts');
  revalidatePath(`/app/inventory/counts/${countId}`);
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
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

  revalidateMasterInventory(countId);
  return { countId };
}
