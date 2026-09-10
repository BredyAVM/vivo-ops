import Link from 'next/link';
import {
  filterAdminFinanceReceivables,
  type AdminFinanceReceivablesFilters,
  type AdminFinanceReceivablesOverview,
} from '@/lib/admin-finance/receivables-model';

type Props = {
  overview: AdminFinanceReceivablesOverview;
  filters: AdminFinanceReceivablesFilters;
  basePath: string;
};

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Caracas',
});

const dateTimeFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'America/Caracas',
});

function money(value: number) {
  return moneyFormatter.format(value);
}

function date(value: string) {
  const parsed = new Date(`${value}T12:00:00-04:00`);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function percentage(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function hrefFor(
  basePath: string,
  filters: AdminFinanceReceivablesFilters,
  overrides: Partial<AdminFinanceReceivablesFilters>
) {
  const next = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (next.period !== 'month') params.set('period', next.period);
  if (next.q) params.set('q', next.q);
  if (next.status !== 'all') params.set('estado', next.status);
  if (next.sort !== 'age_desc') params.set('orden', next.sort);
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function Kpi({ label, value, detail, warning = false }: {
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <article className={`rounded-xl border px-3 py-3 sm:px-4 ${warning ? 'border-orange-300/25 bg-orange-300/[0.04]' : 'border-[#292937] bg-[#111117]'}`}>
      <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${warning ? 'text-orange-200' : 'text-[#92929E]'}`}>{label}</p>
      <p className="mt-1.5 whitespace-nowrap text-[clamp(1.05rem,4vw,1.75rem)] font-semibold leading-none tracking-[-0.035em] text-white tabular-nums">
        {value}
      </p>
      <p className={`mt-1.5 truncate text-[11px] ${warning ? 'text-orange-100/80' : 'text-[#858592]'}`}>{detail}</p>
    </article>
  );
}

function PerformanceBar({ label, value, total, tone }: {
  label: string;
  value: number;
  total: number;
  tone: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
}) {
  const pct = percentage(value, total);
  const colors = {
    green: 'bg-emerald-300',
    yellow: 'bg-[#FEEF00]',
    orange: 'bg-orange-300',
    red: 'bg-red-300',
    gray: 'bg-[#72727F]',
  } as const;
  return (
    <div className="grid grid-cols-[minmax(92px,1fr)_minmax(100px,2fr)_56px] items-center gap-2 text-xs">
      <span className="truncate text-[#B6B6C0]">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-[#242431]">
        <div className={`h-full rounded-full ${colors[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right font-semibold text-white tabular-nums">{value} · {pct}%</span>
    </div>
  );
}

function StatusBadge({ overdue }: { overdue: boolean }) {
  return overdue ? (
    <span className="inline-flex rounded-full bg-red-300/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-red-200">Vencido</span>
  ) : (
    <span className="inline-flex rounded-full bg-[#FEEF00]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#FFF57A]">En plazo</span>
  );
}

export default function ReceivablesOverview({ overview, filters, basePath }: Props) {
  const result = filterAdminFinanceReceivables(overview.openOrders, filters);
  const paidOrders = overview.period.punctualPaid + overview.period.creditPaid + overview.period.overduePaid;
  const visiblePerformanceOrders = paidOrders + overview.period.creditOpen + overview.period.overdueOpen + overview.period.missingRegistration;
  const coveredPct = percentage(overview.period.coveredUsd, overview.period.billedUsd);
  const hasFilters = Boolean(filters.q) || filters.status !== 'all' || filters.sort !== 'age_desc';

  return (
    <div className="space-y-4" data-definition-version={overview.definitionVersion}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Cartera</h1>
          <p className="mt-1 text-xs text-[#81818E]">{overview.portfolio.openOrders} órdenes por cobrar</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#898996]">
          <Link href="/app/admin/finanzas" prefetch={false} className="rounded-lg px-2 py-1 font-semibold text-[#CFCFD7] hover:text-white">Finanzas</Link>
          <time dateTime={overview.asOf}>{dateTimeFormatter.format(new Date(overview.asOf))}</time>
        </div>
      </header>

      <section aria-label="Cartera actual" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label="Por cobrar" value={money(overview.portfolio.receivableUsd)} detail={`${overview.portfolio.openOrders} órdenes abiertas`} />
        <Kpi label="Vencido" value={money(overview.portfolio.overdueUsd)} detail={`${overview.portfolio.overdueOrders} órdenes · más de 5 días`} warning={overview.portfolio.overdueOrders > 0} />
        <Kpi label="En plazo" value={money(overview.portfolio.graceUsd)} detail={`${overview.portfolio.graceOrders} órdenes · hasta 5 días`} />
        <Kpi label="Por revisar" value={String(overview.portfolio.pendingReports)} detail={`${money(overview.portfolio.pendingReportsUsd)} reportados`} warning={overview.portfolio.pendingReports > 0} />
      </section>

      <section className="rounded-xl border border-[#292937] bg-[#111117] p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Comportamiento de pago</h2>
            <p className="mt-0.5 text-[11px] text-[#7F7F8C]">{date(overview.period.from)} – {date(overview.period.to)}</p>
          </div>
          <nav aria-label="Período de cartera" className="flex rounded-lg border border-[#30303D] bg-[#17171F] p-1 text-xs">
            {([
              ['today', 'Hoy'],
              ['week', 'Semana'],
              ['month', 'Mes'],
            ] as const).map(([key, label]) => (
              <Link
                key={key}
                href={hrefFor(basePath, filters, { period: key, page: 1 })}
                prefetch={false}
                aria-current={filters.period === key ? 'page' : undefined}
                className={`rounded-md px-2.5 py-1.5 font-semibold ${filters.period === key ? 'bg-[#FEEF00] text-[#0B0B0D]' : 'text-[#A9A9B4] hover:text-white'}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(210px,0.75fr)_minmax(300px,1.25fr)]">
          <dl className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-[#17171F] p-2.5">
              <dt className="text-[10px] uppercase tracking-[0.08em] text-[#81818D]">Facturado</dt>
              <dd className="mt-1 text-sm font-semibold text-white tabular-nums">{money(overview.period.billedUsd)}</dd>
            </div>
            <div className="rounded-lg bg-[#17171F] p-2.5">
              <dt className="text-[10px] uppercase tracking-[0.08em] text-[#81818D]">Cubierto</dt>
              <dd className="mt-1 text-sm font-semibold text-emerald-200 tabular-nums">{coveredPct}%</dd>
            </div>
            <div className="rounded-lg bg-[#17171F] p-2.5">
              <dt className="text-[10px] uppercase tracking-[0.08em] text-[#81818D]">Pendiente</dt>
              <dd className="mt-1 text-sm font-semibold text-orange-200 tabular-nums">{money(overview.period.pendingUsd)}</dd>
            </div>
          </dl>
          <div className="space-y-2">
            <PerformanceBar label="Puntual" value={overview.period.punctualPaid} total={visiblePerformanceOrders} tone="green" />
            <PerformanceBar label="Pagó ≤ 5 días" value={overview.period.creditPaid} total={visiblePerformanceOrders} tone="yellow" />
            <PerformanceBar label="Pagó tarde" value={overview.period.overduePaid} total={visiblePerformanceOrders} tone="orange" />
            <PerformanceBar label="Aún abierta" value={overview.period.creditOpen + overview.period.overdueOpen} total={visiblePerformanceOrders} tone="red" />
            {overview.period.missingRegistration > 0 ? (
              <PerformanceBar label="Sin fecha trazable" value={overview.period.missingRegistration} total={visiblePerformanceOrders} tone="gray" />
            ) : null}
          </div>
        </div>
      </section>

      <form action={basePath} method="get" className="grid gap-2 rounded-xl border border-[#292937] bg-[#111117] p-2 sm:grid-cols-[minmax(180px,1fr)_160px_160px_auto]">
        <input type="hidden" name="period" value={filters.period} />
        <label>
          <span className="sr-only">Buscar orden, cliente o asesor</span>
          <input name="q" type="search" defaultValue={filters.q} placeholder="Orden, cliente o asesor" className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-3 text-sm text-white outline-none placeholder:text-[#6F6F7C] focus:border-[#FEEF00]/60" />
        </label>
        <label>
          <span className="sr-only">Estado de cartera</span>
          <select name="estado" defaultValue={filters.status} className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60">
            <option value="all">Toda la cartera</option>
            <option value="overdue_open">Vencida</option>
            <option value="credit_open">En plazo</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Ordenar cartera</span>
          <select name="orden" defaultValue={filters.sort} className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60">
            <option value="age_desc">Más antiguo</option>
            <option value="pending_desc">Mayor saldo</option>
            <option value="client">Cliente</option>
          </select>
        </label>
        <button type="submit" className="h-10 rounded-lg bg-[#FEEF00] px-4 text-xs font-black text-[#0B0B0D] hover:bg-[#fff45a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]">Aplicar</button>
      </form>

      <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-[#848491]">
        <span>{result.total} órdenes · antigüedad máxima {overview.portfolio.oldestAgeDays} días</span>
        {hasFilters ? <Link href={hrefFor(basePath, filters, { q: '', status: 'all', sort: 'age_desc', page: 1 })} prefetch={false} className="font-semibold text-[#CFCFD7] hover:text-white">Limpiar filtros</Link> : null}
      </div>

      {result.orders.length === 0 ? (
        <section className="rounded-xl border border-dashed border-[#333341] px-4 py-8 text-center text-sm text-[#BDBDC7]">Sin órdenes para estos filtros.</section>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-[#292937] bg-[#111117] lg:block">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="border-b border-[#292937] bg-[#15151C] text-[10px] font-bold uppercase tracking-[0.1em] text-[#81818D]">
                <tr><th className="w-[12%] px-3 py-2.5">Orden</th><th className="w-[23%] px-3 py-2.5">Cliente</th><th className="w-[18%] px-3 py-2.5">Entrega</th><th className="w-[15%] px-3 py-2.5">Total</th><th className="w-[15%] px-3 py-2.5">Abonado</th><th className="w-[17%] px-3 py-2.5">Pendiente</th></tr>
              </thead>
              <tbody className="divide-y divide-[#252531]">
                {result.orders.map((order) => {
                  const overdue = order.collectionStatus === 'overdue_open';
                  return (
                    <tr key={order.id} className="transition hover:bg-[#17171F]">
                      <td className="px-3 py-3"><Link href={`/app/master/ops?openOrder=${order.id}&tab=pagos`} prefetch={false} className="font-semibold text-white hover:text-[#FEEF00]">{order.orderNumber}</Link></td>
                      <td className="px-3 py-3"><p className="truncate font-semibold text-[#E3E3E9]">{order.clientName}</p><p className="mt-0.5 truncate text-[11px] text-[#777784]">{order.advisorName}</p></td>
                      <td className="px-3 py-3"><StatusBadge overdue={overdue} /><p className="mt-1 text-[11px] text-[#8D8D99]">{date(order.deliveryDate)} · {order.ageDays} días</p></td>
                      <td className="px-3 py-3 font-semibold text-white tabular-nums">{money(order.totalUsd)}</td>
                      <td className="px-3 py-3 text-emerald-200 tabular-nums">{money(order.confirmedPaidUsd)}</td>
                      <td className="px-3 py-3"><p className={`font-semibold tabular-nums ${overdue ? 'text-red-200' : 'text-orange-200'}`}>{money(order.pendingUsd)}</p>{order.pendingReportsCount > 0 ? <p className="mt-0.5 text-[11px] text-orange-100/75">{order.pendingReportsCount} por revisar</p> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 lg:hidden">
            {result.orders.map((order) => {
              const overdue = order.collectionStatus === 'overdue_open';
              return (
                <Link key={order.id} href={`/app/master/ops?openOrder=${order.id}&tab=pagos`} prefetch={false} className="rounded-xl border border-[#292937] bg-[#111117] p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold text-white">{order.orderNumber}</p><p className="mt-0.5 truncate text-xs text-[#A1A1AC]">{order.clientName}</p></div><StatusBadge overdue={overdue} /></div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#272734] pt-2.5 text-xs"><div><p className="text-[10px] uppercase text-[#777784]">Pendiente</p><p className={`mt-0.5 font-semibold tabular-nums ${overdue ? 'text-red-200' : 'text-orange-200'}`}>{money(order.pendingUsd)}</p></div><div><p className="text-[10px] uppercase text-[#777784]">Abonado</p><p className="mt-0.5 font-semibold text-emerald-200 tabular-nums">{money(order.confirmedPaidUsd)}</p></div><div><p className="text-[10px] uppercase text-[#777784]">Antigüedad</p><p className="mt-0.5 font-semibold text-white tabular-nums">{order.ageDays} días</p></div></div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {result.totalPages > 1 ? (
        <nav aria-label="Paginación de cartera" className="flex items-center justify-between text-xs">
          {result.page > 1 ? <Link href={hrefFor(basePath, filters, { page: result.page - 1 })} prefetch={false} className="rounded-lg border border-[#30303D] px-3 py-2 font-semibold text-white">← Anterior</Link> : <span />}
          <span className="text-[#888894]">{result.page} / {result.totalPages}</span>
          {result.page < result.totalPages ? <Link href={hrefFor(basePath, filters, { page: result.page + 1 })} prefetch={false} className="rounded-lg border border-[#30303D] px-3 py-2 font-semibold text-white">Siguiente →</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
