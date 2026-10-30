import "server-only";
import { requireAdminContext } from "@/lib/auth";
import {
  paymentReportFilters,
  paymentReportWindow,
} from "./payment-reports-model";
type Related = {
  full_name?: string | null;
  name?: string | null;
  client?: Related | Related[] | null;
};
export type PaymentReportListRow = {
  id: number;
  order_id: number;
  status: string;
  operation_date: string | null;
  reported_currency_code: string;
  reported_amount: number | string;
  reference_code: string | null;
  payer_name: string | null;
  notes: string | null;
  created_at: string;
  created_by_user_id: string | null;
  account: Related | Related[] | null;
  order: Related | Related[] | null;
  reporter: Related | Related[] | null;
};
export const paymentRelation = (v: Related | Related[] | null) =>
  Array.isArray(v) ? (v[0] ?? {}) : (v ?? {});
export async function loadAdminPaymentReports(
  params: Record<string, string | string[] | undefined>,
  asOf = new Date(),
) {
  const { supabase } = await requireAdminContext(),
    filters = paymentReportFilters(params, asOf);
  if (params.consultar !== "1")
    return {
      queried: false,
      filters,
      rows: [] as PaymentReportListRow[],
      hasMore: false,
    };
  const window = paymentReportWindow(filters);
  // One combined OR filter gives stable pagination, no global count or client-side search.
  let q = supabase
    .from("payment_reports")
    .select(
      "id,order_id,status,operation_date,reported_currency_code,reported_amount,reference_code,payer_name,notes,created_at,created_by_user_id,account:money_accounts!payment_reports_reported_money_account_id_fkey(name),order:orders!payment_reports_order_id_fkey(client:clients!orders_client_id_fkey(full_name))",
    )
    .or(
      `and(operation_date.gte.${filters.from},operation_date.lte.${filters.to}),and(operation_date.is.null,created_at.gte.${window.start},created_at.lt.${window.end})`,
    );
  if (filters.status !== "all") q = q.eq("status", filters.status);
  if (filters.orderId) q = q.eq("order_id", filters.orderId);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((filters.page - 1) * 25, (filters.page - 1) * 25 + 25);
  if (error)
    throw new Error(
      "No se pudieron consultar los reportes de pago del período.",
    );
  const result = (data ?? []) as unknown as PaymentReportListRow[],
    rows = result.slice(0, 25);
  if (
    rows.some(
      (r) =>
        !Number.isSafeInteger(Number(r.id)) ||
        Number(r.id) <= 0 ||
        !Number.isSafeInteger(Number(r.order_id)) ||
        Number(r.order_id) <= 0 ||
        !["USD", "VES"].includes(r.reported_currency_code) ||
        !["pending", "confirmed", "rejected"].includes(r.status) ||
        !Number.isFinite(Date.parse(r.created_at)) ||
        (typeof r.reported_amount !== "number" &&
          typeof r.reported_amount !== "string") ||
        String(r.reported_amount).trim() === "" ||
        !Number.isFinite(Number(r.reported_amount)) ||
        Number(r.reported_amount) < 0,
    )
  )
    throw new Error(
      "Hay un reporte con datos incompletos; revisa el registro antes de operar.",
    );
  const ids = [
    ...new Set(
      rows.map((r) => r.created_by_user_id).filter((v): v is string => !!v),
    ),
  ];
  const people = ids.length
    ? await supabase.from("profiles").select("id,full_name").in("id", ids)
    : { data: [], error: null };
  if (people.error)
    throw new Error("No se pudieron identificar los reportantes.");
  const names = new Map((people.data ?? []).map((p) => [p.id, p.full_name]));
  return {
    queried: true,
    filters,
    rows: rows.map((r) => ({
      ...r,
      reporter: { full_name: names.get(r.created_by_user_id) ?? "Usuario" },
    })),
    hasMore: result.length > 25,
  };
}
