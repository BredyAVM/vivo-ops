'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

type KitchenCountKind = 'shift_change' | 'requested' | 'recount' | 'periodic';
type KitchenCountFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';
type KitchenLossKind = 'damage' | 'waste' | 'quality_taste';

type CountLineInput = {
  inventoryItemId: number;
  countedQuantityUnits: number;
  note?: string | null;
};

function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} no es válido.`);
  }
  return parsed;
}

function operationId(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('La clave de operación no es válida. Actualiza la página e inténtalo nuevamente.');
  }
  return normalized;
}

function optionalNote(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > 1000) {
    throw new Error('La nota admite hasta 1.000 caracteres.');
  }
  return normalized;
}

function businessDate(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error('La fecha operativa no es valida.');
  }
  const date = new Date(`${normalized}T12:00:00-04:00`);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('La fecha operativa no es valida.');
  }
  return normalized;
}

function countLines(value: unknown): CountLineInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error('El conteo debe incluir entre 1 y 200 ítems.');
  }

  const seen = new Set<number>();
  return value.map((rawLine) => {
    const line = (rawLine ?? {}) as Partial<CountLineInput>;
    const inventoryItemId = positiveInteger(line.inventoryItemId, 'El ítem');
    const countedQuantityUnits = Number(line.countedQuantityUnits);
    if (!Number.isFinite(countedQuantityUnits) || countedQuantityUnits < 0) {
      throw new Error('Todas las cantidades contadas deben ser mayores o iguales a cero.');
    }
    if (seen.has(inventoryItemId)) {
      throw new Error('Un ítem no puede repetirse en el mismo conteo.');
    }
    seen.add(inventoryItemId);
    return {
      inventoryItemId,
      countedQuantityUnits,
      note: optionalNote(line.note),
    };
  });
}

async function requireKitchenInventoryContext() {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin') && !ctx.roles.includes('kitchen')) {
    throw new Error('Esta operación requiere permisos de Cocina o Administración.');
  }
  return ctx;
}

function revalidateKitchenInventory() {
  revalidatePath('/app/kitchen');
  revalidatePath('/app/kitchen/inventory');
  revalidatePath('/app/kitchen/inventory/receipts');
  revalidatePath('/app/kitchen/inventory/production');
  revalidatePath('/app/kitchen/inventory/counts');
  revalidatePath('/app/kitchen/inventory/losses');
  revalidatePath('/app/inventory');
  revalidatePath('/app/inventory/operations');
  revalidatePath('/app/inventory/counts');
  revalidatePath('/app/inventory/reports');
  revalidatePath('/app/inventory/alerts');
  revalidatePath('/app/master/ops/inventory');
}

export async function openKitchenInventoryShiftAction(input: {
  operationId: string;
  businessDate: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelKitchenInventoryOpenCountAction(input: {
  countId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function submitKitchenInventoryCountAction(input: {
  operationId: string;
  countKind: KitchenCountKind;
  countFrequency?: KitchenCountFrequency | null;
  countId?: number | null;
  lines: CountLineInput[];
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function recordKitchenInventoryLossAction(input: {
  operationId: string;
  inventoryItemId: number;
  lossKind: KitchenLossKind;
  quantityUnits: number;
  notes?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
