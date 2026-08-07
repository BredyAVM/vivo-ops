'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

type CountLineInput = {
  inventoryItemId: number;
  countedQuantityUnits: number;
  note?: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOperationId(value: unknown) {
  const operationId = String(value ?? '').trim();
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error('La clave de operación del conteo no es válida.');
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

  const { data, error } = await ctx.supabase.rpc('inventory_submit_count_v1', {
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
