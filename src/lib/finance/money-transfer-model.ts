export type MoneyTransferInput = {
  requestId: string;
  sourceMoneyAccountId: number;
  targetMoneyAccountId: number;
  sourceAmount: number;
  targetAmount: number;
  feeAmount?: number | null;
  movementDate: string;
  sourceExchangeRateVesPerUsd: number | null;
  targetExchangeRateVesPerUsd: number | null;
  referenceCode: string;
  counterpartyName: string;
  description: string;
  notes: string;
};

export type MoneyTransferReceipt = {
  movementGroupId: string;
  sourceMovementId: number;
  targetMovementId: number;
  feeMovementId: number | null;
  replayed: boolean;
};

export type MoneyTransferResult =
  | { status: 'confirmed'; receipt: MoneyTransferReceipt }
  | { status: 'rejected' | 'uncertain'; message: string };

export function validTransferRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseMoneyTransferReceipt(data: unknown, input: MoneyTransferInput): MoneyTransferReceipt | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (row.movementGroupId !== input.requestId.toLowerCase() || typeof row.replayed !== 'boolean'
    || !id(row.sourceMovementId) || !id(row.targetMovementId) || row.sourceMovementId === row.targetMovementId) return null;
  if (Number(input.feeAmount ?? 0) > 0) {
    if (!id(row.feeMovementId) || row.feeMovementId === row.sourceMovementId || row.feeMovementId === row.targetMovementId) return null;
  } else if (row.feeMovementId !== null) return null;
  return row as MoneyTransferReceipt;
}

// Only explicit database rejection codes certify that this call did not commit.
// A network/proxy failure or an invalid receipt must be retried with the same input.
export function isDefinitiveTransferRejection(code: unknown) {
  return typeof code === 'string' && (/^(22|23)[A-Z0-9]{3}$/.test(code) || code === '42501' || code === 'P0001');
}
