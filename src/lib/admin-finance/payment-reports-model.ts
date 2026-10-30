import {
  addDateKeyDays,
  getCaracasDateKey,
  caracasDateKeyToUtcIso,
} from "./period.ts";
const STATUS = ["pending", "confirmed", "rejected", "all"] as const;
export type PaymentReportFilters = {
  from: string;
  to: string;
  status: (typeof STATUS)[number];
  orderId: number | null;
  page: number;
};
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
export function paymentReportFilters(
  params: Record<string, string | string[] | undefined>,
  asOf = new Date(),
): PaymentReportFilters {
  const today = getCaracasDateKey(asOf);
  const from = first(params.from) ?? addDateKeyDays(today, -6),
    to = first(params.to) ?? today;
  const valid = (v: string) => {
    const d = new Date(`${v}T12:00:00Z`);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === v
    );
  };
  if (
    !valid(from) ||
    !valid(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    throw new Error(
      "Selecciona fechas válidas, de menor a mayor, hasta un año.",
    );
  const status = first(params.status) ?? "pending";
  if (!STATUS.includes(status as PaymentReportFilters["status"]))
    throw new Error("Estado de pago inválido.");
  const rawOrder = first(params.order),
    orderId = rawOrder ? Number(rawOrder) : null;
  if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0))
    throw new Error("Usa el número corto de la orden.");
  const page = Number(first(params.page) ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 10000)
    throw new Error("Página inválida.");
  return {
    from,
    to,
    status: status as PaymentReportFilters["status"],
    orderId,
    page,
  };
}
export function paymentReportsHref(
  filters: PaymentReportFilters,
  page = filters.page,
) {
  const q = new URLSearchParams({
    consultar: "1",
    from: filters.from,
    to: filters.to,
    status: filters.status,
    page: String(page),
  });
  if (filters.orderId) q.set("order", String(filters.orderId));
  return "/app/admin/finanzas/pagos?" + q;
}
export function paymentReportWindow(filters: PaymentReportFilters) {
  return {
    start: caracasDateKeyToUtcIso(filters.from),
    end: caracasDateKeyToUtcIso(addDateKeyDays(filters.to, 1)),
  };
}
