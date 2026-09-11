export type OrderCancellationPreview = {
  orderId: number;
  cashAvailableUsd: number;
  fundUsedUsd: number;
  alreadyStoredUsd: number;
  fingerprint: string;
};

export type OrderCancellationInput = {
  requestId: string;
  orderId: number;
  fingerprint: string;
  reason: string;
  paidHandling?: 'store_fund' | 'refund' | null;
  requireExactRefund?: boolean;
  refundLines?: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{32}$/;
const validId = (value: number) => Number.isSafeInteger(value) && value > 0;
const validMoney = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;

export function readOrderCancellationPreview(value: unknown): OrderCancellationPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No se pudo calcular la cancelación.');
  const row = value as Record<string, unknown>;
  const result = {
    orderId: Number(row.orderId), cashAvailableUsd: Number(row.cashAvailableUsd),
    fundUsedUsd: Number(row.fundUsedUsd), alreadyStoredUsd: Number(row.alreadyStoredUsd),
    fingerprint: String(row.fingerprint ?? ''),
  };
  if (!validId(result.orderId) || !fingerprintPattern.test(result.fingerprint) ||
    ['cashAvailableUsd', 'fundUsedUsd', 'alreadyStoredUsd'].some((key) => row[key] == null || row[key] === '') ||
    ![result.cashAvailableUsd, result.fundUsedUsd, result.alreadyStoredUsd].every(validMoney)) {
    throw new Error('El resumen de cancelación no es válido. Actualízalo.');
  }
  return result;
}

export function buildOrderCancellationCommand(input: OrderCancellationInput) {
  if (!uuidPattern.test(input.requestId ?? '') || !validId(input.orderId) || !fingerprintPattern.test(input.fingerprint ?? '')) {
    throw new Error('Actualiza el resumen de cancelación antes de confirmar.');
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason || reason.length > 1000) throw new Error('Indica un motivo de hasta 1000 caracteres.');
  const lines = input.refundLines ?? [];
  if (!Array.isArray(lines) || lines.length > 12) throw new Error('Usa hasta 12 líneas de devolución.');
  if (input.paidHandling != null && !['store_fund', 'refund'].includes(input.paidHandling)) throw new Error('Opción de devolución inválida.');
  if (input.paidHandling !== 'refund' && lines.length) throw new Error('No incluyas devoluciones al enviar todo al fondo.');
  const refundLines = lines.map((line) => {
    const currencyCode = String(line.currencyCode ?? '').trim().toUpperCase();
    const rate = line.exchangeRateVesPerUsd ?? null;
    if (!validId(line.moneyAccountId) || !['USD', 'VES'].includes(currencyCode) || !validMoney(line.amount) || line.amount <= 0 ||
      Math.abs(line.amount * 100 - Math.round(line.amount * 100)) > 0.00001 ||
      (currencyCode === 'VES' && (rate == null || !validMoney(rate) || rate <= 0))) {
      throw new Error('Revisa la cuenta, moneda, monto y tasa de cada devolución.');
    }
    return { moneyAccountId: line.moneyAccountId, currencyCode, amount: line.amount,
      exchangeRateVesPerUsd: currencyCode === 'VES' ? rate : null, notes: String(line.notes ?? '').trim() || reason };
  });
  return { p_request_id: input.requestId, p_input: { orderId: input.orderId, fingerprint: input.fingerprint,
    reason, paidHandling: input.paidHandling ?? null, requireExactRefund: input.requireExactRefund === true, refundLines } };
}

export function readOrderCancellationReceipt(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No se recibió el comprobante de cancelación.');
  const row = value as Record<string, unknown>;
  if (!validId(Number(row.orderId)) || !validId(Number(row.eventId)) || typeof row.replayed !== 'boolean' ||
    !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw new Error('Comprobante de cancelación inválido.');
  return { orderId: Number(row.orderId), eventId: Number(row.eventId), replayed: row.replayed, payload: row.payload as Record<string, unknown> };
}
