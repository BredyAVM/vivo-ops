/** Blank means unknown. Only an explicitly entered zero is a recorded zero. */
export function parseDeliveryCostInput(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Costo de delivery inválido.');
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Costo de delivery inválido.');
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 999999999.99) throw new Error('Costo de delivery inválido.');
  return number;
}

export function deliveryCostSourceLabel(source: string | null): string {
  if (source === 'internal_assignment_input') return 'Registrado al asignar · interno';
  if (source === 'external_partner_manual_v1') return 'Registrado al asignar · externo';
  if (source?.startsWith('admin_delivered_correction_')) return 'Corrección administrativa';
  return source ? 'Registro anterior · sin trazabilidad completa' : 'Sin fuente de costo';
}

/** Readers must not substitute a current catalog tariff for historical cost. */
export function readStoredDeliveryCost(value: unknown): number | null {
  try { return parseDeliveryCostInput(value); } catch { return null; }
}

export function readDeliveryCorrectionReceipt(value: unknown): { eventId: number; payload: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Respuesta de corrección inválida. Actualiza la orden antes de reintentar.');
  const row = value as Record<string, unknown>;
  if (typeof row.eventId !== 'number' || !Number.isSafeInteger(row.eventId) || row.eventId <= 0 ||
      !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('No se pudo verificar el historial. Actualiza la orden antes de reintentar.');
  }
  return { eventId: row.eventId, payload: row.payload as Record<string, unknown> };
}
