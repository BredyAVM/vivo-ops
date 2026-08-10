export type OrderFinancialActivityType =
  | "payment_received"
  | "change_given"
  | "fund_stored"
  | "fund_paid_out"
  | "fund_applied"
  | "fund_restored"
  | "fund_reversed"
  | "refund_paid";

export type OrderFinancialActivity = {
  key: string;
  type: OrderFinancialActivityType;
  sequence: number;
  occurredAt: string;
  operationDate: string | null;
  currencyCode: string;
  amount: number;
  amountUsd: number;
  moneyAccountId: number | null;
  moneyAccountName: string | null;
  referenceCode: string | null;
  notes: string | null;
  actorUserId: string | null;
  actorName: string;
};

const ACTIVITY_TYPES = new Set<OrderFinancialActivityType>([
  "payment_received",
  "change_given",
  "fund_stored",
  "fund_paid_out",
  "fund_applied",
  "fund_restored",
  "fund_reversed",
  "refund_paid",
]);

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

function cleanText(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function activityType(value: unknown): OrderFinancialActivityType | null {
  const type = cleanText(value) as OrderFinancialActivityType;
  return ACTIVITY_TYPES.has(type) ? type : null;
}

export function mapOrderFinancialActivity(value: unknown): OrderFinancialActivity[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawValue) => {
    const raw = asRecord(rawValue);
    const key = cleanText(raw.activity_key);
    const type = activityType(raw.activity_type);
    const occurredAt = cleanText(raw.occurred_at);
    if (!key || !type || !occurredAt) return [];

    return [{
      key,
      type,
      sequence: Math.trunc(finiteNumber(raw.activity_sequence)),
      occurredAt,
      operationDate: cleanText(raw.operation_date) || null,
      currencyCode: cleanText(raw.currency_code, "USD").toUpperCase(),
      amount: finiteNumber(raw.amount),
      amountUsd: finiteNumber(raw.amount_usd),
      moneyAccountId: optionalPositiveInteger(raw.money_account_id),
      moneyAccountName: cleanText(raw.money_account_name) || null,
      referenceCode: cleanText(raw.reference_code) || null,
      notes: cleanText(raw.notes) || null,
      actorUserId: cleanText(raw.actor_user_id) || null,
      actorName: cleanText(raw.actor_name, "Usuario"),
    } satisfies OrderFinancialActivity];
  });
}
