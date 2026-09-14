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

/** Distance is optional at dispatch, but an entered value must be usable. */
export function parseDeliveryDistanceInput(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  let number: number | null;
  try { number = parseDeliveryCostInput(value); } catch { throw new Error('Distancia de delivery inválida.'); }
  if (number === null || number <= 0 || number > 999999) throw new Error('Distancia de delivery inválida.');
  return number;
}

export function deliveryCostSourceLabel(source: string | null): string {
  if (source === 'admin_payment_tariff_confirmation_v1') return 'Tarifa confirmada al pagar';
  if (source === 'internal_product_tariff_v1') return 'Tarifa interna al asignar';
  if (source === 'internal_assignment_input') return 'Registrado al asignar · interno';
  if (source === 'external_partner_manual_v1') return 'Registrado al asignar · externo';
  if (source === 'external_partner_tariff_v1') return 'Tabulador al asignar';
  if (source === 'external_partner_pending_v1') return 'Pendiente de completar';
  if (source?.startsWith('admin_delivered_correction_')) return 'Corrección administrativa';
  return source ? 'Registro anterior · sin trazabilidad completa' : 'Sin fuente de costo';
}

/** Readers must not substitute a current catalog tariff for historical cost. */
export function readStoredDeliveryCost(value: unknown): number | null {
  try { return parseDeliveryCostInput(value); } catch { return null; }
}

/** An explicitly labelled estimate for legacy reports; never replaces a snapshot. */
export function deliveryCostEstimate(stored: unknown, mode: string, proposed: unknown) {
  const saved = readStoredDeliveryCost(stored);
  const estimate = mode === 'internal' ? readStoredDeliveryCost(proposed) : null;
  return { amount: saved ?? estimate, estimated: saved === null && estimate !== null };
}

export function estimateInternalDeliveryCost(lines: { qty: number; rate: unknown; isDelivery: boolean }[]): number | null {
  const relevant = lines.filter(line => line.isDelivery || line.rate != null);
  if (!relevant.length) return null;
  let total = 0;
  for (const line of relevant) {
    const rate = readStoredDeliveryCost(line.rate);
    if (rate === null || !Number.isFinite(line.qty) || line.qty <= 0) return null;
    total += rate * line.qty;
  }
  return total <= 999999999.99 ? Math.round((total + Number.EPSILON) * 100) / 100 : null;
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
