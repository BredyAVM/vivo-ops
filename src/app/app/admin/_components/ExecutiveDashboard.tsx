import Link from '@/components/navigation/ContextLink';
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
  { label: 'Órdenes', marker: 'OR', href: '/app/admin/ordenes' },
  { label: 'Pagos', marker: 'PA', href: '/app/master/ops/finance?status=pending' },
  { label: 'Inventario', marker: 'IV', href: '/app/inventory' },
  { label: 'Productos', marker: 'PR', href: '/app/inventory/configure?view=edit' },
  { label: 'Comisiones', marker: 'CO', href: '/app/admin/finanzas/comisiones' },
  { label: 'Metas', marker: 'ME', href: '/app/commissions/goals' },
  { label: 'Proyecciones', marker: 'PY', href: '/app/admin/proyecciones' },
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

function AttentionItem({ label, value, href, urgent = false }: { label: string; value: number | null; href: string; urgent?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#2B2B38] bg-[#17171F] px-3 transition hover:border-[#FFFF00]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]"
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
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-[#FFFF00]">Todos los módulos</summary>
      <nav aria-label="Todos los módulos administrativos" className="grid grid-cols-2 gap-2 pb-3 sm:grid-cols-3 xl:grid-cols-4">
        {shortcuts.map((shortcut) => (
          <Link
            key={shortcut.label}
            href={shortcut.href}
            prefetch={false}
            className="group flex min-h-11 items-center gap-2 rounded-lg border border-[#292937] px-2 transition hover:border-[#FFFF00]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]"
          >
            <span className="flex h-7 min-w-7 items-center justify-center rounded-lg bg-[#FFFF00]/10 px-1 text-[9px] font-black text-[#FFFF00] group-hover:bg-[#FFFF00] group-hover:text-[#0B0B0D]">
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
  const operational = data.operational;
  const hasCoverageWarning =
    data.quality.deliveryRowsTruncated || !operational.week.financialStatesComplete;

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
          <a href="/app/admin" className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-[#CFCFD7] underline focus-visible:outline-2 focus-visible:outline-[#FFFF00]">Actualizar</a>
          <Link
            href="/app/admin/finanzas"
            prefetch={false}
            className="inline-flex min-h-10 items-center rounded-xl border border-[#3A3A48] px-3 text-xs font-semibold text-white hover:border-[#FFFF00]/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]"
          >
            Ver finanzas
          </Link>
        </div>
      </header>

      <section aria-label="Indicadores principales" className="rounded-xl border border-[#292937] bg-[#111117] p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">Estado</h2>
          <span className="text-[10px] text-[#9B9BA7]">Fecha programada · USD</span>
        </div>
        <table className="w-full text-xs tabular-nums [&_td]:py-1.5 [&_th]:py-1.5">
          <caption className="sr-only">Estado operativo por fecha programada. Semana de lunes a domingo, incluye órdenes ya registradas para próximos días.</caption>
          <thead className="text-[10px] text-[#9B9BA7]"><tr><th scope="col" className="text-left">Indicador</th><th scope="col" className="text-right">Hoy</th><th scope="col" className="text-right">Semana</th></tr></thead>
          <tbody className="divide-y divide-[#272734]">
            {[
              { label: 'Cierres', help: 'Órdenes con valor, incluidas las creadas; excluye canceladas y obsequios sin valor.', today: String(operational.today.closures), week: String(operational.week.closures), color: 'text-white' },
              { label: 'Fact. neta', help: 'Órdenes que salieron de Creada, netas de descuentos y sin impuesto.', today: money(operational.today.commercialNetUsd), week: money(operational.week.commercialNetUsd), color: 'text-white' },
              { label: 'Abonado', help: 'Abonos confirmados de esas órdenes; no equivale al dinero que entró hoy a las cuentas.', today: money(operational.today.confirmedPaidUsd), week: money(operational.week.confirmedPaidUsd), color: 'text-emerald-300' },
              { label: 'Pendiente', help: 'Saldo canónico actual de las órdenes facturadas del período.', today: money(operational.today.pendingUsd), week: money(operational.week.pendingUsd), color: 'text-orange-200' },
            ].map((row) => <tr key={row.label} title={row.help}><th scope="row" className="text-left font-medium text-[#BDBDC7]">{row.label}</th><td className={`text-right text-[13px] font-semibold ${row.color}`}>{row.today}</td><td className={`text-right text-[13px] font-semibold ${row.color}`}>{row.week}</td></tr>)}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-[#9B9BA7]">Semana: lunes a domingo, incluidos pedidos registrados para próximos días.</p>
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <ExecutiveTrendChart points={operational.trend} todayKey={data.todayKey} historyWeeks={operational.historyWeeks} />

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
              <span className="text-sm font-semibold tabular-nums text-white">{data.today.deliveries}</span>
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
          { label: 'Órdenes', href: '/app/admin/ordenes' },
          { label: '+ Ingreso', href: adminMovementHref('inflow') },
          { label: '− Egreso', href: adminMovementHref('outflow') },
          { label: 'Cierre de caja', href: '/app/admin/finanzas/cuentas/cierre' },
          { label: 'Cobranzas', href: '/app/admin/finanzas/cobranzas' },
          { label: 'Cuentas y saldos', href: '/app/admin/finanzas/cuentas' },
          { label: 'Jugadas / CRM', href: '/app/master/plays' },
          { label: 'Proyecciones', href: '/app/admin/proyecciones' },
        ].map((action) => (
          <Link key={action.href} href={action.href} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs font-semibold text-[#E0E0E7] hover:border-[#FFFF00]/50 focus-visible:outline-2 focus-visible:outline-[#FFFF00]">
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

    </div>
  );
}
