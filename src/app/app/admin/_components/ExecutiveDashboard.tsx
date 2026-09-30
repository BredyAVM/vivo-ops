import Link from 'next/link';
import type { AdminExecutiveKpiDomain } from '@/lib/admin-finance/executive-data';
import type { AdminFinancialOverview } from '@/lib/admin-finance/model';
import ExecutiveTrendChart from './ExecutiveTrendChart';
import { adminMovementHref } from '@/lib/admin-finance/movement-navigation';

type ExecutiveDashboardProps = {
  executive: AdminExecutiveKpiDomain;
  finance: AdminFinancialOverview;
};

type Shortcut = {
  label: string;
  marker: string;
  href: string;
};

const shortcuts: Shortcut[] = [
  { label: 'Ingreso / Egreso', marker: '$', href: '/app/admin/finanzas/cuentas/movimiento' },
  { label: 'Pendientes', marker: 'PD', href: '/app/admin/tareas' },
  { label: 'Delivery', marker: 'DE', href: '/app/admin/finanzas/delivery' },
  { label: 'Reportes', marker: 'RE', href: '/app/admin/reportes' },
  { label: 'Herramientas', marker: 'HE', href: '/app/admin/herramientas' },
  { label: 'Cuentas', marker: 'CU', href: '/app/admin/finanzas/cuentas' },
  { label: 'Cobranzas', marker: 'CA', href: '/app/admin/finanzas/cobranzas' },
  { label: 'Por entregar', marker: 'PE', href: '/app/admin/finanzas/pedidos' },
  { label: 'Órdenes', marker: 'OR', href: '/app/master/ops' },
  { label: 'Pagos', marker: 'PA', href: '/app/master/ops/finance?status=pending' },
  { label: 'Inventario', marker: 'IV', href: '/app/inventory' },
  { label: 'Productos', marker: 'PR', href: '/app/inventory/configure?view=edit' },
  { label: 'Comisiones', marker: 'CO', href: '/app/admin/finanzas/comisiones' },
  { label: 'Metas', marker: 'ME', href: '/app/commissions/goals' },
  { label: 'Eventos', marker: 'EV', href: '/app/events' },
  { label: 'Jugadas', marker: 'JU', href: '/app/master/plays' },
];

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('es-VE', {
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Caracas',
});

const timeFormatter = new Intl.DateTimeFormat('es-VE', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'America/Caracas',
});

function money(value: number | null) {
  return value === null ? '—' : moneyFormatter.format(value);
}

function percentage(value: number | null, total: number) {
  if (value === null || total <= 0) return null;
  return Number(((value / total) * 100).toFixed(0));
}

function deltaLabel(current: number, baseline: number) {
  if (baseline <= 0) return 'Sin referencia';
  const delta = ((current - baseline) / baseline) * 100;
  if (Math.abs(delta) < 0.5) return 'Igual al promedio';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)}% vs promedio`;
}

function deltaClass(current: number, baseline: number) {
  if (baseline <= 0 || Math.abs(current - baseline) < 0.005) return 'text-[#9B9BA7]';
  return current > baseline ? 'text-emerald-300' : 'text-orange-200';
}

function KpiTile({
  label,
  help,
  today,
  week,
  signal,
  signalClass = 'text-[#9B9BA7]',
  warning,
}: {
  label: string;
  help: string;
  today: string;
  week: string;
  signal: string;
  signalClass?: string;
  warning?: boolean;
}) {
  return (
    <article
      className="min-w-0 rounded-xl border border-[#292937] bg-[#111117] p-3"
      title={help}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[#BDBDC7]">{label}</p>
        {warning ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-orange-300"
            title="Esta cifra tiene cobertura parcial"
            aria-label="Cobertura parcial"
          />
        ) : null}
      </div>
      <p className="mt-1 break-words text-lg font-semibold leading-tight text-white tabular-nums sm:text-xl">
        {today}
      </p>
      <div className="mt-2 flex flex-col gap-1 border-t border-[#272734] pt-2">
        <p className="text-xs tabular-nums text-[#CFCFD7]">Semana <strong className="font-semibold text-white">{week}</strong></p>
        <p className={`text-[11px] font-semibold ${signalClass}`}>{signal}</p>
      </div>
    </article>
  );
}

function AttentionItem({ label, value, href, urgent = false }: { label: string; value: number | null; href: string; urgent?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#2B2B38] bg-[#17171F] px-3 transition hover:border-[#FEEF00]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
    >
      <span className="text-xs font-semibold text-[#BDBDC7]">{label}</span>
      <span title={value === null ? 'No disponible' : undefined} className={`text-sm font-bold tabular-nums ${urgent && value !== null && value > 0 ? 'text-orange-200' : 'text-white'}`}>
        {value ?? '—'}
      </span>
    </Link>
  );
}

function Shortcuts() {
  return (
    <details id="centros" className="scroll-mt-24 rounded-xl border border-[#292937] bg-[#111117] px-3">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-[#FEEF00]">Todos los módulos</summary>
      <div className="mb-2 flex justify-end">
        <Link href="/app/master/dashboard" prefetch={false} className="text-xs font-semibold text-[#9B9BA7] hover:text-white">
          Panel anterior →
        </Link>
      </div>
      <nav aria-label="Todos los módulos administrativos" className="grid grid-cols-2 gap-2 pb-3 sm:grid-cols-3 xl:grid-cols-4">
        {shortcuts.map((shortcut) => (
          <Link
            key={shortcut.label}
            href={shortcut.href}
            prefetch={false}
            className="group flex min-h-11 items-center gap-2 rounded-lg border border-[#292937] px-2 transition hover:border-[#FEEF00]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            <span className="flex h-7 min-w-7 items-center justify-center rounded-lg bg-[#FEEF00]/10 px-1 text-[9px] font-black text-[#FEEF00] group-hover:bg-[#FEEF00] group-hover:text-[#0B0B0D]">
              {shortcut.marker}
            </span>
            <span className="min-w-0 text-xs font-semibold text-[#D8D8DF]">{shortcut.label}</span>
          </Link>
        ))}
      </nav>
    </details>
  );
}

export default function ExecutiveDashboard({ executive, finance }: ExecutiveDashboardProps) {
  if (executive.status === 'error') {
    return (
      <div className="space-y-5">
        <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
          <h1 className="text-lg font-semibold text-white">Indicadores no disponibles</h1>
          <p className="mt-1 text-sm text-red-100/75">{executive.message}</p>
        </section>
        <Shortcuts />
      </div>
    );
  }

  const data = executive.data;
  const treasury = finance.treasury.status === 'ready' ? finance.treasury.data : null;
  const position = finance.position.status === 'ready' ? finance.position.data : null;
  const todayCoveredPct = percentage(data.today.coveredUsd, data.today.billedUsd);
  const weekCoveredPct = percentage(data.week.coveredUsd, data.week.billedUsd);
  const todayPendingPct = percentage(data.today.pendingUsd, data.today.billedUsd);
  const weekPendingPct = percentage(data.week.pendingUsd, data.week.billedUsd);
  const hasCoverageWarning =
    data.quality.deliveryRowsTruncated || !data.quality.financialStatesComplete;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold capitalize text-[#90909C]">{dateFormatter.format(new Date(data.asOf))}</p>
          <h1 className="mt-0.5 text-lg font-semibold text-white">Visión general</h1>
        </div>
        <div className="flex items-center gap-2">
          {position?.activeRateBsPerUsd ? (
            <span className="hidden rounded-full border border-[#2D2D3A] bg-[#14141B] px-3 py-1.5 text-xs tabular-nums text-[#BDBDC7] sm:inline-flex">
              Tasa {numberFormatter.format(position.activeRateBsPerUsd)} Bs
            </span>
          ) : null}
          <span className="text-xs text-[#9B9BA7]">Al corte {timeFormatter.format(new Date(data.asOf))}</span>
          <a href="/app/admin" className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-[#CFCFD7] underline focus-visible:outline-2 focus-visible:outline-[#FEEF00]">Actualizar</a>
          <Link
            href="/app/admin/finanzas"
            prefetch={false}
            className="inline-flex min-h-10 items-center rounded-xl border border-[#3A3A48] px-3 text-xs font-semibold text-white hover:border-[#FEEF00]/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            Ver finanzas
          </Link>
        </div>
      </header>

      <section aria-label="Indicadores principales" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile
          label="Facturado hoy"
          help="Total contractual de las órdenes entregadas hoy, incluido el impuesto cuando aplica."
          today={money(data.today.billedUsd)}
          week={money(data.week.billedUsd)}
          signal={deltaLabel(data.today.billedUsd, data.historicalAverage.todayBilledUsd)}
          signalClass={deltaClass(data.today.billedUsd, data.historicalAverage.todayBilledUsd)}
        />
        <KpiTile
          label="Cierres hoy"
          help="Órdenes con valor que alcanzaron el estado entregado hoy."
          today={String(data.today.closures)}
          week={String(data.week.closures)}
          signal={deltaLabel(data.today.closures, data.historicalAverage.todayClosures)}
          signalClass={deltaClass(data.today.closures, data.historicalAverage.todayClosures)}
        />
        <KpiTile
          label="Cubierto hoy"
          help="Cobertura actual de las órdenes entregadas hoy; incluye anticipos o fondos aplicados anteriormente."
          today={money(data.today.coveredUsd)}
          week={money(data.week.coveredUsd)}
          signal={todayCoveredPct === null ? 'No disponible' : `${todayCoveredPct}% de lo facturado`}
          signalClass="text-emerald-300"
          warning={!data.quality.financialStatesComplete}
        />
        <KpiTile
          label="Por cobrar hoy"
          help="Saldo actual pendiente de las órdenes entregadas hoy."
          today={money(data.today.pendingUsd)}
          week={money(data.week.pendingUsd)}
          signal={todayPendingPct === null ? 'Sin cobertura' : `${todayPendingPct}% de lo facturado`}
          signalClass={(todayPendingPct ?? 0) === 0 ? 'text-emerald-300' : 'text-orange-200'}
          warning={!data.quality.financialStatesComplete}
        />
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <ExecutiveTrendChart points={data.trend} todayKey={data.todayKey} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <section className="rounded-xl border border-[#292937] bg-[#111117] p-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                Deliveries hoy
                {data.quality.deliveryRowsTruncated ? (
                  <span
                    className="h-2 w-2 rounded-full bg-orange-300"
                    title="El conteo de deliveries tiene cobertura parcial"
                    aria-label="Cobertura parcial"
                  />
                ) : null}
              </h2>
              <span className="text-lg font-semibold tabular-nums text-white">{data.today.deliveries}</span>
            </div>
            <p className="mt-1 text-xs tabular-nums text-[#8E8E9A]">Semana {data.week.deliveries}</p>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-emerald-400/8 px-2 py-1.5">
                <dt className="text-xs text-emerald-100/70">Entregados</dt>
                <dd className="text-base font-semibold tabular-nums text-emerald-200">{data.today.deliveriesCompleted}</dd>
              </div>
              <div className="rounded-lg bg-orange-400/8 px-2 py-1.5">
                <dt
                  className="text-xs text-orange-100/70"
                  title="Deliveries programados que todavía no figuran como entregados"
                >
                  Por completar
                </dt>
                <dd className="text-base font-semibold tabular-nums text-orange-200">{data.today.deliveriesPending}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-[#292937] bg-[#111117] p-3">
            <h2 className="text-sm font-semibold text-white">Por atender</h2>
            <div className="mt-2 grid gap-1.5">
              <AttentionItem
                label="Pagos por revisar"
                value={treasury?.pendingPaymentReports ?? null}
                href="/app/master/ops/finance?status=pending"
                urgent
              />
              <AttentionItem
                label="Movimientos"
                value={treasury?.pendingMovementOperations ?? null}
                href="/app/admin/finanzas/cuentas?state=pending_movements"
                urgent
              />
              <AttentionItem
                label="Conciliaciones"
                value={position?.openReconciliations ?? null}
                href="/app/admin/finanzas/cuentas?state=open_reconciliation"
                urgent
              />
            </div>
          </section>
        </div>
      </section>

      <section aria-label="Flujo de caja semanal" className="rounded-xl border border-[#292937] bg-[#111117] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">Flujo de esta semana</h2>
          <span className="text-xs text-[#9B9BA7]">USD equivalente · sin traspasos internos</span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-[#BDBDC7]">
          <div><dt>Entradas</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums text-white">{money(treasury ? treasury.confirmedCollectionsUsd + treasury.otherExternalIncomeUsd : null)}</dd></div>
          <div><dt>Salidas</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums text-white">{money(treasury?.externalOutflowsUsd ?? null)}</dd></div>
          <div><dt>Movimiento neto</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums text-white">{money(treasury?.netExternalCashFlowUsd ?? null)}</dd></div>
        </dl>
        {!treasury || treasury.outflowQuality === 'Q3_incomplete' || treasury.netCashFlowQuality === 'Q4_blocked' ? (
          <p className="mt-2 text-xs text-orange-200">{treasury ? 'Flujo parcial: hay movimientos por aclarar.' : 'Flujo no disponible.'}</p>
        ) : null}
      </section>

      <nav aria-label="Operaciones frecuentes" className="flex flex-wrap gap-2">
        {[
          { label: '+ Ingreso', href: adminMovementHref('inflow') },
          { label: '− Egreso', href: adminMovementHref('outflow') },
          { label: 'Cierre de caja', href: '/app/admin/finanzas/cuentas/cierre' },
          { label: 'Cobranzas', href: '/app/admin/finanzas/cobranzas' },
          { label: 'Cuentas y saldos', href: '/app/admin/finanzas/cuentas' },
          { label: 'Jugadas / CRM', href: '/app/master/plays' },
        ].map((action) => (
          <Link key={action.href} href={action.href} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs font-semibold text-[#E0E0E7] hover:border-[#FEEF00]/50 focus-visible:outline-2 focus-visible:outline-[#FEEF00]">
            {action.label}
          </Link>
        ))}
      </nav>

      <Shortcuts />

      {hasCoverageWarning ? (
        <p className="rounded-xl border border-orange-300/20 bg-orange-300/5 px-3 py-2 text-xs text-orange-100/80">
          Algunas cifras tienen cobertura parcial. El detalle financiero conserva el diagnóstico completo.
        </p>
      ) : null}

      <div className="sr-only">
        Cobertura semanal: {weekCoveredPct === null ? 'sin cobertura' : `${weekCoveredPct}%`}. Pendiente semanal:{' '}
        {weekPendingPct === null ? 'sin cobertura' : `${weekPendingPct}%`}.
      </div>
    </div>
  );
}
