import Link from "@/components/navigation/ContextLink";
import WorkspaceForm from "@/components/navigation/WorkspaceForm";
import { queryControl, queryPrimary, queryPanel } from "@/components/ui/QueryControls";
import {
  loadAdminPaymentReports,
  paymentRelation,
} from "@/lib/admin-finance/payment-reports-data";
import { paymentReportsHref } from "@/lib/admin-finance/payment-reports-model";
import { AdminReadError } from "../../_components/AdminReadUi";
import PaymentReportReview from "./PaymentReportReview";
import { formatOrderDisplayNumber } from "@/lib/orders/order-labels";
export const dynamic = "force-dynamic";
const input = queryControl;
const statusLabel: Record<string, string> = {
  pending: "Por revisar",
  confirmed: "Confirmado",
  rejected: "Rechazado",
};
const amountFormat = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let data;
  try {
    data = await loadAdminPaymentReports(params);
  } catch (error) {
    return (
      <AdminReadError
        title="Pagos de clientes"
        message={
          error instanceof Error ? error.message : "No se pudo consultar."
        }
      />
    );
  }
  const { filters } = data;
  return (
    <section className="min-w-0 space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[#DEDEE6]">
          Pagos de clientes
        </h1>
        <Link
          href="/app/admin/finanzas/cuentas/movimiento"
          prefetch={false}
          className="text-xs text-[#FFFF00]"
        >
          Ingreso / Egreso
        </Link>
      </header>
      <WorkspaceForm
        method="get"
        action="/app/admin/finanzas/pagos"
        className={`${queryPanel} grid grid-cols-2 items-end gap-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]`}
      >
        <input type="hidden" name="consultar" value="1" />
        <label className="grid gap-1 text-[11px] text-[#B7B7C2]">
          Desde
          <input
            required
            type="date"
            name="from"
            defaultValue={filters.from}
            className={input}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-[#B7B7C2]">
          Hasta
          <input
            required
            type="date"
            name="to"
            defaultValue={filters.to}
            className={input}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-[#B7B7C2]">
          Estado
          <select name="status" defaultValue={filters.status} className={input}>
            <option value="pending">Por revisar</option>
            <option value="confirmed">Confirmados</option>
            <option value="rejected">Rechazados</option>
            <option value="all">Todos</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] text-[#B7B7C2]">
          Orden corta
          <input
            type="number"
            name="order"
            min="1"
            defaultValue={filters.orderId ?? ""}
            className={input + " w-28"}
          />
        </label>
        <button className={queryPrimary}>
          Consultar pagos
        </button>
      </WorkspaceForm>
      <p className="text-[11px] text-[#9B9BA7]">
        Por fecha de operación; si falta, fecha de registro. Abre el reporte para
        confirmar o rechazar el pago aquí mismo.
      </p>
      {!data.queried ? (
        <p className="text-xs text-[#BDBDC7]">
          Selecciona el período y pulsa Consultar. No se carga el historial al
          entrar.
        </p>
      ) : (
        <>
          <p className="text-xs text-[#9B9BA7]">
            {data.rows.length} reportes en esta página
          </p>
          <div className="space-y-1">
            {data.rows.map((row) => (
              <article
                key={row.id}
                className="min-w-0 rounded-lg border border-[#292937] bg-[#111117] px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Link
                      href={`/app/admin/ordenes?openOrder=${row.order_id}&tab=pagos`}
                      prefetch={false}
                      className="font-semibold text-[#FFFF00]"
                    >
                      Orden #{formatOrderDisplayNumber(row.order_id)}
                    </Link>
                    <span
                      className={
                        row.status === "pending"
                          ? "text-orange-200"
                          : "text-[#BDBDC7]"
                      }
                    >
                      {statusLabel[row.status] ?? row.status}
                    </span>
                    <span className="font-semibold tabular-nums text-[#DEDEE6]">
                      {row.reported_currency_code === "VES" ? "Bs" : "USD"}{" "}
                      {amountFormat.format(Number(row.reported_amount))}
                    </span>
                  </div>
                </div>
                <p className="break-words text-[11px] text-[#9B9BA7]">
                  {paymentRelation(paymentRelation(row.order).client ?? null)
                    .full_name ?? "Cliente"}{" "}
                  · {paymentRelation(row.account).name ?? "Cuenta no indicada"}{" "}
                  ·{" "}
                  {row.operation_date ??
                    new Intl.DateTimeFormat("es-VE", {
                      timeZone: "America/Caracas",
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    }).format(new Date(row.created_at))}{" "}
                  · Ref. {row.reference_code ?? "—"}
                </p>
                <PaymentReportReview reportId={Number(row.id)} orderId={Number(row.order_id)}>
                  <dl className="space-y-1 break-words text-xs text-[#BDBDC7]">
                    <div>
                      <dt className="inline text-[#9B9BA7]">Reportante: </dt>
                      <dd className="inline">
                        {paymentRelation(row.reporter).full_name ?? "Usuario"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-[#9B9BA7]">Pagador: </dt>
                      <dd className="inline">{row.payer_name ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline text-[#9B9BA7]">Notas: </dt>
                      <dd className="inline">{row.notes ?? "—"}</dd>
                    </div>
                  </dl>
                </PaymentReportReview>
              </article>
            ))}
            {data.rows.length === 0 ? (
              <p className="text-xs text-[#BDBDC7]">
                Sin reportes para este filtro.
              </p>
            ) : null}
          </div>
          <nav
            className="flex flex-wrap gap-3 text-xs"
            aria-label="Páginas de pagos"
          >
            {filters.page > 1 ? (
              <Link
                href={paymentReportsHref(filters, filters.page - 1)}
                prefetch={false}
              >
                Anterior
              </Link>
            ) : null}
            <span>Página {filters.page}</span>
            {data.hasMore ? (
              <Link
                href={paymentReportsHref(filters, filters.page + 1)}
                prefetch={false}
              >
                Siguiente
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </section>
  );
}
