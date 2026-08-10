import Link from "next/link";
import { unstable_noStore as noStore } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from "@/lib/auth";
import { formatOrderDisplayNumber } from "@/lib/orders/order-labels";
import type { MasterOrderPaymentReport } from "../../_components/MasterOrderDetailCore";
import PaymentVerificationCopyButton from "../PaymentVerificationCopyButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PaymentStatus = "pending" | "confirmed" | "rejected";
type StatusFilter = PaymentStatus | "all";

type PaymentReportRow = {
  id: number | string;
  order_id: number | string;
  status: PaymentStatus;
  operation_date: string | null;
  reported_currency_code: string;
  reported_amount: number | string;
  reported_exchange_rate_ves_per_usd: number | string | null;
  reported_amount_usd_equivalent: number | string;
  reported_money_account_id: number | string | null;
  reference_code: string | null;
  payer_name: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

type OrderRow = {
  id: number | string;
  status: string;
  fulfillment: string;
  total_usd: number | string;
  client: Record<string, unknown> | Record<string, unknown>[] | null;
};

type FinanceReport = {
  orderId: number;
  orderStatus: string;
  fulfillment: string;
  orderTotalUsd: number;
  clientName: string;
  report: MasterOrderPaymentReport;
};

const statusOptions: Array<{ key: StatusFilter; label: string }> = [
  { key: "pending", label: "Por revisar" },
  { key: "confirmed", label: "Confirmados" },
  { key: "rejected", label: "Rechazados" },
  { key: "all", label: "Todos" },
];

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-VE")
    .trim();
}

function relation(value: OrderRow["client"]) {
  if (Array.isArray(value)) return value[0] ?? {};
  return value ?? {};
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatAmount(currency: string, value: number) {
  if (currency === "USD") return formatUsd(value);
  return `${currency} ${new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("es-VE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Caracas",
  }).format(date);
}

function statusLabel(status: PaymentStatus) {
  if (status === "pending") return "POR REVISAR";
  if (status === "confirmed") return "CONFIRMADO";
  return "RECHAZADO";
}

function statusClass(status: PaymentStatus) {
  if (status === "pending") return "border-orange-400/40 bg-orange-400/10 text-orange-200";
  if (status === "confirmed") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  return "border-red-400/40 bg-red-400/10 text-red-200";
}

function filterHref(status: StatusFilter, query: string) {
  const params = new URLSearchParams();
  params.set("status", status);
  if (query) params.set("q", query);
  return `/app/master/ops/finance?${params.toString()}`;
}

export default async function MasterOpsFinancePage({ searchParams }: { searchParams?: SearchParams }) {
  noStore();
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!isMasterOrAdminRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const params = (await searchParams) ?? {};
  const requestedStatus = firstParam(params.status);
  const status: StatusFilter = statusOptions.some((option) => option.key === requestedStatus)
    ? requestedStatus as StatusFilter
    : "pending";
  const query = firstParam(params.q).trim().slice(0, 80);

  let reportsQuery = ctx.supabase
    .from("payment_reports")
    .select(
      "id,order_id,status,operation_date,reported_currency_code,reported_amount,reported_exchange_rate_ves_per_usd,reported_amount_usd_equivalent,reported_money_account_id,reference_code,payer_name,notes,created_by_user_id,created_at"
    )
    .order("created_at", { ascending: false })
    .limit(status === "all" ? 400 : 320);
  if (status !== "all") reportsQuery = reportsQuery.eq("status", status);

  const [pendingCountResult, confirmedCountResult, rejectedCountResult, reportsResult] = await Promise.all([
    ctx.supabase.from("payment_reports").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ctx.supabase.from("payment_reports").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    ctx.supabase.from("payment_reports").select("id", { count: "exact", head: true }).eq("status", "rejected"),
    reportsQuery,
  ]);

  const countError = pendingCountResult.error ?? confirmedCountResult.error ?? rejectedCountResult.error;
  if (countError) throw new Error(`No se pudo cargar el resumen financiero: ${countError.message}`);
  if (reportsResult.error) throw new Error(`No se pudieron cargar los reportes: ${reportsResult.error.message}`);

  const reportRows = (reportsResult.data ?? []) as PaymentReportRow[];
  const orderIds = Array.from(new Set(reportRows.map((report) => Number(report.order_id)).filter((id) => id > 0)));
  const accountIds = Array.from(
    new Set(reportRows.map((report) => Number(report.reported_money_account_id)).filter((id) => id > 0))
  );
  const reporterIds = Array.from(
    new Set(reportRows.map((report) => report.created_by_user_id).filter((id): id is string => Boolean(id)))
  );

  const [ordersResult, accountsResult, profilesResult] = await Promise.all([
    orderIds.length
      ? ctx.supabase
          .from("orders")
          .select("id,status,fulfillment,total_usd,client:clients!orders_client_id_fkey(full_name)")
          .in("id", orderIds)
      : Promise.resolve({ data: [] as OrderRow[], error: null }),
    accountIds.length
      ? ctx.supabase.from("money_accounts").select("id,name").in("id", accountIds)
      : Promise.resolve({ data: [] as Array<{ id: number; name: string }>, error: null }),
    reporterIds.length
      ? ctx.supabase.from("profiles").select("id,full_name").in("id", reporterIds)
      : Promise.resolve({ data: [] as Array<{ id: string; full_name: string }>, error: null }),
  ]);

  const relationError = ordersResult.error ?? accountsResult.error ?? profilesResult.error;
  if (relationError) throw new Error(`No se pudo completar el historial financiero: ${relationError.message}`);

  const orderById = new Map((ordersResult.data ?? []).map((order) => [Number(order.id), order as OrderRow] as const));
  const accountNameById = new Map(
    (accountsResult.data ?? []).map((account) => [Number(account.id), String(account.name || "Cuenta")] as const)
  );
  const reporterNameById = new Map(
    (profilesResult.data ?? []).map((profile) => [String(profile.id), String(profile.full_name || "Usuario")] as const)
  );

  const financeReports: FinanceReport[] = reportRows.map((row) => {
    const orderId = Number(row.order_id);
    const order = orderById.get(orderId);
    const client = relation(order?.client ?? null);
    const accountId = Number(row.reported_money_account_id);
    return {
      orderId,
      orderStatus: String(order?.status || "--"),
      fulfillment: String(order?.fulfillment || "--"),
      orderTotalUsd: numberValue(order?.total_usd),
      clientName: String(client.full_name || "Sin cliente"),
      report: {
        id: Number(row.id),
        status: row.status,
        createdAt: row.created_at,
        operationDate: row.operation_date,
        reporterName: reporterNameById.get(String(row.created_by_user_id || "")) ?? "Usuario",
        currencyCode: String(row.reported_currency_code || "--").toUpperCase(),
        amount: numberValue(row.reported_amount),
        exchangeRate:
          row.reported_exchange_rate_ves_per_usd == null
            ? null
            : numberValue(row.reported_exchange_rate_ves_per_usd),
        usdEquivalent: numberValue(row.reported_amount_usd_equivalent),
        moneyAccountId: accountId > 0 ? accountId : null,
        moneyAccountName: accountNameById.get(accountId) ?? (accountId > 0 ? `Cuenta #${accountId}` : "Cuenta"),
        referenceCode: row.reference_code,
        payerName: row.payer_name,
        notes: row.notes,
      },
    };
  });

  const normalizedQuery = normalizeText(query);
  const visibleReports = normalizedQuery
    ? financeReports.filter((item) =>
        normalizeText([
          item.orderId,
          formatOrderDisplayNumber(item.orderId),
          item.clientName,
          item.report.referenceCode,
          item.report.moneyAccountName,
          item.report.payerName,
          item.report.reporterName,
        ].join(" ")).includes(normalizedQuery)
      )
    : financeReports;
  const pendingVisibleUsd = visibleReports
    .filter((item) => item.report.status === "pending")
    .reduce((sum, item) => sum + item.report.usdEquivalent, 0);
  const counts = {
    pending: pendingCountResult.count ?? 0,
    confirmed: confirmedCountResult.count ?? 0,
    rejected: rejectedCountResult.count ?? 0,
  };

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <header className="border-b border-[#242433] bg-[#101014]">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">Vivo Ops · Máster</div>
            <h1 className="mt-1 text-2xl font-black">Pagos operativos</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A6A6B2]">
              Cola de verificación e historial reciente. La confirmación y el rechazo siguen ejecutándose en el detalle canónico de la orden.
            </p>
          </div>
          <Link
            href="/app/master/ops"
            prefetch={false}
            className="w-fit rounded-xl border border-[#FEEF00]/50 bg-[#181812] px-4 py-2.5 text-sm font-semibold text-[#FEEF00]"
          >
            Volver a Máster
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-orange-400/30 bg-orange-400/5 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-orange-200/70">Por revisar</div>
            <div className="mt-1 text-2xl font-black text-orange-100">{counts.pending}</div>
          </div>
          <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-emerald-200/70">Confirmados</div>
            <div className="mt-1 text-2xl font-black text-emerald-100">{counts.confirmed}</div>
          </div>
          <div className="rounded-2xl border border-red-400/25 bg-red-400/5 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-red-200/70">Rechazados</div>
            <div className="mt-1 text-2xl font-black text-red-100">{counts.rejected}</div>
          </div>
          <div className="rounded-2xl border border-[#FEEF00]/25 bg-[#FEEF00]/5 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#FEEF00]/70">Monto visible por revisar</div>
            <div className="mt-1 text-2xl font-black text-[#FEEF00]">{formatUsd(pendingVisibleUsd)}</div>
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-[#242433] bg-[#121218] p-3">
          <form className="flex flex-col gap-2 sm:flex-row" action="/app/master/ops/finance" method="get">
            <input type="hidden" name="status" value={status} />
            <input
              className="min-w-0 flex-1 rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#71717D] focus:border-[#FEEF00]/60"
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Orden, cliente, referencia, cuenta, pagador o reportante"
            />
            <button className="rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-[#0B0B0D]" type="submit">
              Buscar
            </button>
            {query ? (
              <Link className="rounded-xl border border-[#343442] px-4 py-2.5 text-center text-sm text-[#B7B7C2]" href={filterHref(status, "")}>
                Limpiar
              </Link>
            ) : null}
          </form>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {statusOptions.map((option) => {
              const optionCount = option.key === "all"
                ? counts.pending + counts.confirmed + counts.rejected
                : counts[option.key];
              return (
                <Link
                  key={option.key}
                  href={filterHref(option.key, query)}
                  className={[
                    "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold",
                    status === option.key
                      ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                      : "border-[#343442] bg-[#0B0B0D] text-[#B7B7C2]",
                  ].join(" ")}
                >
                  {option.label} · {optionCount}
                </Link>
              );
            })}
          </div>
        </section>

        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-[#8A8A96]">
          <span>{visibleReports.length} reporte(s) visible(s)</span>
          <span>Ventana ligera: últimos {status === "all" ? 400 : 320} reportes del filtro</span>
        </div>

        <section className="mt-3 space-y-2">
          {visibleReports.length === 0 ? (
            <div className="rounded-2xl border border-[#242433] bg-[#121218] px-5 py-8 text-center text-sm text-[#B7B7C2]">
              No hay reportes que coincidan con este filtro.
            </div>
          ) : visibleReports.map((item) => (
            <article key={item.report.id} className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-[#F5F5F7]">
                      Orden #{formatOrderDisplayNumber(item.orderId)} · {item.clientName}
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClass(item.report.status)}`}>
                      {statusLabel(item.report.status)}
                    </span>
                    <span className="rounded-full border border-[#343442] px-2 py-0.5 text-[10px] text-[#8A8A96]">
                      {item.fulfillment === "delivery" ? "Delivery" : "Pickup"}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-lg font-black text-[#FEEF00]">
                      {formatAmount(item.report.currencyCode, item.report.amount)}
                    </span>
                    <span className="text-sm font-semibold text-[#B7B7C2]">· {formatUsd(item.report.usdEquivalent)}</span>
                    <span className="text-xs text-[#8A8A96]">Orden {formatUsd(item.orderTotalUsd)}</span>
                  </div>
                  <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-[#B7B7C2] sm:grid-cols-2 xl:grid-cols-4">
                    <div><span className="text-[#7A7A86]">Cuenta:</span> {item.report.moneyAccountName}</div>
                    <div><span className="text-[#7A7A86]">Referencia:</span> {item.report.referenceCode || "--"}</div>
                    <div><span className="text-[#7A7A86]">Banco/pagador:</span> {item.report.payerName || "--"}</div>
                    <div><span className="text-[#7A7A86]">Reporta:</span> {item.report.reporterName}</div>
                  </div>
                  <div className="mt-2 text-[11px] text-[#7A7A86]">
                    Registrado {formatDateTime(item.report.createdAt || "")} · operación {item.report.operationDate || "--"}
                  </div>
                  {item.report.notes ? <div className="mt-2 text-xs text-[#9A9AA6]">Notas: {item.report.notes}</div> : null}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <PaymentVerificationCopyButton
                    input={{ orderId: item.orderId, clientName: item.clientName, report: item.report }}
                    className="px-3 py-2 text-xs"
                  />
                  <Link
                    href={`/app/master/ops?openOrder=${item.orderId}&tab=pagos`}
                    prefetch={false}
                    className="rounded-lg border border-[#FEEF00]/55 bg-[#FEEF00]/10 px-3 py-2 text-xs font-bold text-[#FEEF00]"
                  >
                    {item.report.status === "pending" ? "Revisar pago" : "Abrir orden"}
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
