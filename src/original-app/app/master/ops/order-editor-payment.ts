export const MASTER_OPS_ORDER_PAYMENT_METHODS = [
  "cash_usd",
  "cash_ves",
  "payment_mobile",
  "transfer",
  "pos",
  "zelle",
  "wallet_usd",
  "retention",
] as const;

const MASTER_OPS_ORDER_PAYMENT_METHOD_SET = new Set<string>([
  "",
  ...MASTER_OPS_ORDER_PAYMENT_METHODS,
]);

export function normalizeMasterOpsOrderPaymentMethod(value: unknown) {
  const method = String(value ?? "").trim();

  // Advisor orders historically used "pending" to mean that no payment
  // method had been defined yet. Master Ops presents that state as
  // "Sin definir" and must preserve it as an empty method when saving.
  return method === "pending" ? "" : method;
}

export function isMasterOpsOrderPaymentMethod(value: unknown) {
  return MASTER_OPS_ORDER_PAYMENT_METHOD_SET.has(
    normalizeMasterOpsOrderPaymentMethod(value)
  );
}
