export type OrderClientFundPayout = {
  id: number;
  orderId: number;
  currencyCode: string;
  amount: number;
  amountUsd: number;
  moneyAccountId: number | null;
  moneyAccountName: string;
  notes: string | null;
  createdAt: string;
  actorUserId: string | null;
  actorName: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function optionalPositiveInteger(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function mapOrderClientFundPayouts(value: unknown): OrderClientFundPayout[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawValue) => {
    const raw = asRecord(rawValue);
    const id = optionalPositiveInteger(raw.id);
    const orderId = optionalPositiveInteger(raw.order_id);
    const createdAt = cleanText(raw.created_at, "");
    if (!id || !orderId || !createdAt) return [];

    return [{
      id,
      orderId,
      currencyCode: cleanText(raw.currency_code, "USD").toUpperCase(),
      amount: finiteNumber(raw.amount),
      amountUsd: finiteNumber(raw.amount_usd),
      moneyAccountId: optionalPositiveInteger(raw.money_account_id),
      moneyAccountName: cleanText(raw.money_account_name, "Cuenta"),
      notes: cleanText(raw.notes, "") || null,
      createdAt,
      actorUserId: cleanText(raw.actor_user_id, "") || null,
      actorName: cleanText(raw.actor_name, "Usuario"),
    } satisfies OrderClientFundPayout];
  });
}
