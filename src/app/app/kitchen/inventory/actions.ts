'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

type KitchenCountKind = 'shift_change' | 'requested' | 'recount' | 'periodic';
type KitchenShiftCode = 'shift_1' | 'shift_2';
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

function shiftCode(value: unknown): KitchenShiftCode {
  if (value !== 'shift_1' && value !== 'shift_2') {
    throw new Error('Selecciona Turno 1 o Turno 2.');
  }
  return value;
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
  businessDate: string;
  shiftCode: KitchenShiftCode;
}) {
  const ctx = await requireKitchenInventoryContext();
  const { data, error } = await ctx.supabase.rpc('inventory_open_shift_count_v1', {
    p_business_date: businessDate(input.businessDate),
    p_shift_code: shiftCode(input.shiftCode),
    p_notes: null,
  });

  if (error) throw new Error(error.message);

  const countId = positiveInteger(
    (data as { inventory_count_id?: unknown } | null)?.inventory_count_id,
    'El conteo abierto',
  );
  revalidateKitchenInventory();
  return { countId };
}

export async function submitKitchenInventoryCountAction(input: {
  operationId: string;
  countKind: KitchenCountKind;
  countId?: number | null;
  lines: CountLineInput[];
  notes?: string | null;
}) {
  const ctx = await requireKitchenInventoryContext();
  const normalizedOperationId = operationId(input.operationId);
  const normalizedLines = countLines(input.lines);
  const notes = optionalNote(input.notes);
  const allowedKinds = new Set<KitchenCountKind>([
    'shift_change',
    'requested',
    'recount',
    'periodic',
  ]);
  if (!allowedKinds.has(input.countKind)) {
    throw new Error('El tipo de conteo no es válido.');
  }

  const countId = input.countId == null ? null : positiveInteger(input.countId, 'El conteo');
  if (countId == null && !['shift_change', 'requested'].includes(input.countKind)) {
    throw new Error('Los conteos solicitados deben partir de una solicitud abierta.');
  }

  const serializedLines = normalizedLines.map((line) => ({
    inventory_item_id: line.inventoryItemId,
    counted_quantity_units: line.countedQuantityUnits,
    note: line.note,
  }));

  const { data, error } = countId != null && input.countKind === 'recount'
    ? await ctx.supabase.rpc('inventory_submit_staged_recount_v1', {
        p_operation_id: normalizedOperationId,
        p_existing_count_id: countId,
        p_lines: serializedLines,
        p_notes: notes,
      })
    : await ctx.supabase.rpc('inventory_submit_count_v1', {
        p_operation_id: normalizedOperationId,
        p_count_kind: input.countKind,
        p_lines: serializedLines,
        p_notes: notes,
        p_parent_count_id: null,
        p_existing_count_id: countId,
      });

  if (error) throw new Error(error.message);

  const returnedCountId = positiveInteger(
    (data as { inventory_count_id?: unknown } | null)?.inventory_count_id,
    'El conteo registrado',
  );
  revalidateKitchenInventory();
  revalidatePath(`/app/inventory/counts/${returnedCountId}`);
  return { countId: returnedCountId };
}

export async function recordKitchenInventoryLossAction(input: {
  operationId: string;
  inventoryItemId: number;
  lossKind: KitchenLossKind;
  quantityUnits: number;
  notes?: string | null;
}) {
  const ctx = await requireKitchenInventoryContext();
  const normalizedOperationId = operationId(input.operationId);
  const inventoryItemId = positiveInteger(input.inventoryItemId, 'El ítem');
  const quantityUnits = Number(input.quantityUnits);
  if (!['damage', 'waste', 'quality_taste'].includes(input.lossKind)) {
    throw new Error('El tipo de salida no es válido.');
  }
  if (!Number.isFinite(quantityUnits) || quantityUnits <= 0) {
    throw new Error('La cantidad debe ser mayor que cero.');
  }

  const { data, error } = await ctx.supabase.rpc('inventory_record_loss_v1', {
    p_operation_id: normalizedOperationId,
    p_inventory_item_id: inventoryItemId,
    p_loss_kind: input.lossKind,
    p_quantity_units: quantityUnits,
    p_reason_code: input.lossKind,
    p_notes: optionalNote(input.notes),
    p_inventory_lot_id: null,
  });

  if (error) throw new Error(error.message);
  revalidateKitchenInventory();
  return data as { status?: string; total_quantity_units?: number } | null;
}
