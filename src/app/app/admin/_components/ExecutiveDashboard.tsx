import Link from 'next/link';
import type { AdminExecutiveKpiDomain } from '@/lib/admin-finance/executive-data';
import type { AdminFinancialOverview } from '@/lib/admin-finance/model';
import ExecutiveTrendChart from './ExecutiveTrendChart';

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
  { label: 'Órdenes', marker: 'OR', href: '/app/master/ops' },
  { label: 'Pagos', marker: 'PA', href: '/app/master/ops/finance?status=pending' },
  { label: 'Inventario', marker: 'IV', href: '/app/inventory' },
  { label: 'Productos', marker: 'PR', href: '/app/inventory/configure?view=edit' },
  { label: 'Comisiones', marker: 'CO', href: '/app/commissions' },
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
      className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-3.5 sm:p-4"
      title={help}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#A3A3AE]">{label}</p>
        {warning ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-orange-300"
            title="Esta cifra tiene cobertura parcial"
            aria-label="Cobertura parcial"
          />
        ) : null}
      </div>
      <p className="mt-2 whitespace-nowrap text-[clamp(1.25rem,4.5vw,2rem)] font-semibold leading-none tracking-[-0.035em] text-white tabular-nums">
        {today}
      </p>
      <div className="mt-3 flex flex-col gap-1 border-t border-[#272734] pt-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-xs tabular-nums text-[#CFCFD7]">Semana <strong className="font-semibold text-white">{week}</strong></p>
        <p className={`text-[11px] font-semibold ${signalClass}`}>{signal}</p>
      </div>
    </article>
  );
}

function AttentionItem({ label, value, href, urgent = false }: { label: string; value: number; href: string; urgent?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#2B2B38] bg-[#17171F] px-3 transition hover:border-[#FEEF00]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
    >
      <span className="text-xs font-semibold text-[#BDBDC7]">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${urgent && value > 0 ? 'text-orange-200' : 'text-white'}`}>
        {value}
      </span>
    </Link>
  );
}

function Shortcuts() {
  return (
    <section id="centros" className="scroll-mt-24">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Accesos rápidos</h2>
        <Link href="/app/master/dashboard" prefetch={false} className="text-xs font-semibold text-[#9B9BA7] hover:text-white">
          Panel anterior →
        </Link>
      </div>
      <div className="grid auto-cols-[minmax(132px,1fr)] grid-flow-col gap-2 overflow-x-auto pb-1 sm:grid-flow-row sm:grid-cols-4 sm:overflow-visible sm:pb-0 xl:grid-cols-8">
        {shortcuts.map((shortcut) => (
          <Link
            key={shortcut.label}
            href={shortcut.href}
            prefetch={false}
            className="group flex min-h-14 items-center gap-2.5 rounded-xl border border-[#292937] bg-[#111117] px-3 transition hover:border-[#FEEF00]/45 hover:bg-[#15151D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            <span className="flex h-7 min-w-7 items-center justify-center rounded-lg bg-[#FEEF00]/10 px-1 text-[9px] font-black text-[#FEEF00] group-hover:bg-[#FEEF00] group-hover:text-[#0B0B0D]">
              {shortcut.marker}
            </span>
            <span className="min-w-0 text-xs font-semibold text-[#D8D8DF]">{shortcut.label}</span>
          </Link>
        ))}
      </div>
    </section>
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
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold capitalize text-[#90909C]">{dateFormatter.format(new Date(data.asOf))}</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-white sm:text-2xl">Visión general</h1>
        </div>
        <div className="flex items-center gap-2">
          {position?.activeRateBsPerUsd ? (
            <span className="hidden rounded-full border border-[#2D2D3A] bg-[#14141B] px-3 py-1.5 text-xs tabular-nums text-[#BDBDC7] sm:inline-flex">
              Tasa {numberFormatter.format(position.activeRateBsPerUsd)} Bs
            </span>
          ) : null}
          <span className="text-xs text-[#777784]">{timeFormatter.format(new Date(data.asOf))}</span>
          <Link
            href="/app/admin/finanzas"
            prefetch={false}
            className="inline-flex min-h-10 items-center rounded-xl border border-[#3A3A48] px-3 text-xs font-semibold text-white hover:border-[#FEEF00]/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            Ver finanzas
          </Link>
        </div>
      </header>

      <section aria-label="Indicadores principales" className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
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

      <Shortcuts />

      <section className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(280px,0.8fr)]">
        <ExecutiveTrendChart points={data.trend} todayKey={data.todayKey} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <section className="rounded-2xl border border-[#292937] bg-[#111117] p-4">
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
              <span className="text-2xl font-semibold tabular-nums text-white">{data.today.deliveries}</span>
            </div>
            <p className="mt-1 text-xs tabular-nums text-[#8E8E9A]">Semana {data.week.deliveries}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-emerald-400/8 px-3 py-2.5">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-100/70">Entregados</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-emerald-200">{data.today.deliveriesCompleted}</dd>
              </div>
              <div className="rounded-xl bg-orange-400/8 px-3 py-2.5">
                <dt
                  className="text-[10px] font-semibold uppercase tracking-[0.1em] text-orange-100/70"
                  title="Deliveries programados que todavía no figuran como entregados"
                >
                  Por completar
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-orange-200">{data.today.deliveriesPending}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-2xl border border-[#292937] bg-[#111117] p-4">
            <h2 className="text-sm font-semibold text-white">Por atender</h2>
            <div className="mt-3 grid gap-2">
              <AttentionItem
                label="Pagos por revisar"
                value={treasury?.pendingPaymentReports ?? 0}
                href="/app/master/ops/finance?status=pending"
                urgent
              />
              <AttentionItem
                label="Movimientos"
                value={treasury?.pendingMovementOperations ?? 0}
                href="/app/master/dashboard"
                urgent
              />
              <AttentionItem
                label="Conciliaciones"
                value={position?.openReconciliations ?? 0}
                href="/app/master/dashboard"
                urgent
              />
            </div>
          </section>
        </div>
      </section>

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
