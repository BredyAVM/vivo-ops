import Link from 'next/link';
import {
  compressFinancialSeries,
  type AdminFinanceDomain,
  type AdminFinancialOverview,
  type FinancialQualityCode,
} from '@/lib/admin-finance/model';
import { addDateKeyDays, type AdminFinancePeriodKey } from '@/lib/admin-finance/period';
import type { ReactNode } from 'react';
import FinancialBarChart from './FinancialBarChart';

type FinancialDashboardProps = {
  overview: AdminFinancialOverview;
  basePath: '/app/admin' | '/app/admin/finanzas';
  detail?: boolean;
};

const usdFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat('es-VE', {
  maximumFractionDigits: 0,
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

const periodOptions: Array<{ key: AdminFinancePeriodKey; label: string }> = [
  { key: 'today', label: 'Hoy' },
  { key: 'week', label: 'Semana' },
  { key: 'month', label: 'Mes' },
];

const qualityLabels: Record<FinancialQualityCode, string> = {
  Q1_exact: 'Exacto',
  Q2_derived: 'Derivado',
  Q3_incomplete: 'Cobertura parcial',
  Q4_blocked: 'No publicable',
};

const qualityDescriptions: Record<FinancialQualityCode, string> = {
  Q1_exact: 'Fuente estructurada y cobertura completa para esta definición.',
  Q2_derived: 'Cálculo reproducible con una clasificación heredada declarada.',
  Q3_incomplete: 'La cifra tiene una cobertura conocida pero incompleta.',
  Q4_blocked: 'No existe todavía una base suficiente para publicar esta cifra.',
};

function formatUsd(value: number | null) {
  return value === null ? 'No disponible' : `$${usdFormatter.format(value)}`;
}

function formatDateKey(value: string) {
  const date = new Date(`${value}T12:00:00-04:00`);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function qualityClass(quality: FinancialQualityCode) {
  if (quality === 'Q1_exact') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200';
  if (quality === 'Q2_derived') return 'border-blue-400/25 bg-blue-400/10 text-blue-200';
  if (quality === 'Q3_incomplete') return 'border-orange-400/25 bg-orange-400/10 text-orange-200';
  return 'border-[#414151] bg-[#1A1A23] text-[#B8B8C2]';
}

function QualityBadge({ quality }: { quality: FinancialQualityCode }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${qualityClass(quality)}`}
      title={qualityDescriptions[quality]}
      aria-label={`${qualityLabels[quality]}: ${qualityDescriptions[quality]}`}
    >
      {qualityLabels[quality]}
    </span>
  );
}

function comparisonText(change: number | null) {
  if (change === null) return 'Sin base comparable en el período anterior';
  if (Math.abs(change) < 0.05) return 'Sin variación frente al período anterior';
  return `${change > 0 ? 'Subió' : 'Bajó'} ${Math.abs(change).toFixed(1)}% frente al período anterior`;
}

function periodComparisonText(change: number | null, periodKey: AdminFinancePeriodKey) {
  if (periodKey === 'today') {
    return 'Corte parcial de hoy; la comparación porcentual se muestra en Semana y Mes';
  }
  return comparisonText(change);
}

function MetricCard({
  kpi,
  label,
  value,
  context,
  quality,
  tone = 'neutral',
  href,
}: {
  kpi: string;
  label: string;
  value: string;
  context: string;
  quality: FinancialQualityCode;
  tone?: 'neutral' | 'positive' | 'warning';
  href?: string;
}) {
  const valueClass =
    tone === 'positive' ? 'text-emerald-300' : tone === 'warning' ? 'text-orange-200' : 'text-white';
  const card = (
    <article className="min-w-0 rounded-2xl border border-[#2A2A38] bg-[#111117] p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#A4A4AF]">{label}</p>
        <span className="shrink-0 text-xs font-bold text-[#777784]">{kpi}</span>
      </div>
      <p className={`mt-4 break-words text-3xl font-semibold tracking-[-0.03em] ${valueClass}`}>{value}</p>
      <p className="mt-2 min-h-10 text-sm leading-5 text-[#A8A8B3]">{context}</p>
      <div className="mt-4 border-t border-[#292937] pt-3">
        <div className="flex items-center justify-between gap-3">
          <QualityBadge quality={quality} />
          {href ? <span className="text-xs font-semibold text-[#D8D8DF]">Ver detalle →</span> : null}
        </div>
      </div>
    </article>
  );

  return href ? (
    <Link
      href={href}
      prefetch={false}
      className="rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
    >
      {card}
    </Link>
  ) : card;
}

function DomainUnavailable({ message }: { message: string }) {
  return (
    <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
      <p className="text-sm font-semibold text-red-100">Este bloque no está disponible por ahora.</p>
      <p className="mt-1 text-sm leading-6 text-red-100/75">{message} Las demás cifras continúan funcionando.</p>
    </section>
  );
}

function BreakdownStat({ label, value, context }: { label: string; value: string; context: string }) {
  return (
    <div className="rounded-xl border border-[#2D2D3A] bg-[#17171F] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9696A3]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-sm leading-5 text-[#A9A9B4]">{context}</p>
    </div>
  );
}

function DomainValue<T>({
  domain,
  children,
}: {
  domain: AdminFinanceDomain<T>;
  children: (data: T) => ReactNode;
}) {
  return domain.status === 'ready' ? children(domain.data) : <DomainUnavailable message={domain.message} />;
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#FEEF00]">{eyebrow}</p>
        <h2 id={id} className="mt-2 text-2xl font-semibold tracking-tight text-white">{title}</h2>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-[#A1A1AD]">{description}</p>
    </div>
  );
}

export default function FinancialDashboard({ overview, basePath, detail = false }: FinancialDashboardProps) {
  const currentPeriod = overview.period;
  const commercial = overview.commercial.status === 'ready' ? overview.commercial.data : null;
  const treasury = overview.treasury.status === 'ready' ? overview.treasury.data : null;
  const snapshotQuery = `period=${currentPeriod.key}&asOf=${encodeURIComponent(currentPeriod.asOf)}&definition=${overview.definitionVersion}`;
  const financialDetailPath = `/app/admin/finanzas?${snapshotQuery}`;
  const cashChartHasUnclassified =
    Boolean(treasury) &&
    ((treasury?.unclassifiedAdjustmentCount ?? 0) > 0 ||
      (treasury?.previousUnclassifiedAdjustmentCount ?? 0) > 0 ||
      (treasury?.incompleteTransferGroups ?? 0) > 0 ||
      (treasury?.previousIncompleteTransferGroups ?? 0) > 0);
  const cashChartDescription =
    (currentPeriod.key === 'today'
      ? 'Corte parcial de hoy frente al total de ayer; no suma traspasos internos.'
      : 'Cobros confirmados frente a egresos externos visibles; no suma traspasos internos.') +
    (cashChartHasUnclassified
      ? ' Los ajustes sin clasificación o las anomalías de traspaso no aparecen en las barras y bloquean el neto.'
      : '');

  const salesChartRows =
    currentPeriod.key === 'today' && commercial
      ? [
          { label: 'Ayer', primary: commercial.previousDeliveredSalesUsd },
          { label: 'Hoy', primary: commercial.deliveredSalesUsd },
        ]
      : compressFinancialSeries(commercial?.series ?? [], 12).map((bucket) => ({
          label: bucket.label,
          primary: bucket.points.reduce((total, point) => total + point.salesUsd, 0),
        }));
  const cashChartRows =
    currentPeriod.key === 'today' && treasury
      ? [
          {
            label: 'Ayer',
            primary: treasury.previousConfirmedCollectionsUsd,
            secondary: treasury.previousExternalOutflowsUsd,
          },
          {
            label: 'Hoy',
            primary: treasury.confirmedCollectionsUsd,
            secondary: treasury.externalOutflowsUsd,
          },
        ]
      : compressFinancialSeries(treasury?.series ?? [], 12).map((bucket) => ({
          label: bucket.label,
          primary: bucket.points.reduce((total, point) => total + point.collectionsUsd, 0),
          secondary: bucket.points.reduce((total, point) => total + point.externalOutflowsUsd, 0),
        }));

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[28px] border border-[#2A2A38] bg-[#111117]">
        <div className="relative px-5 py-6 sm:px-7 sm:py-8 xl:px-9 xl:py-9">
          <div
            className="pointer-events-none absolute -right-20 -top-32 h-72 w-72 rounded-full bg-[#FEEF00]/10 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#FEEF00]">
                {detail ? 'Centro financiero' : 'Inicio ejecutivo'}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl xl:text-5xl">
                {detail ? 'Finanzas con contexto y trazabilidad.' : 'Radiografía financiera del negocio.'}
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-[#B7B7C2] sm:text-base sm:leading-7">
                Ventas por entrega, dinero por fecha real de operación y posición actual se mantienen separados para
                que una cifra no aparente ser otra.
              </p>
            </div>

            <div className="flex shrink-0 flex-col gap-2 sm:flex-row xl:flex-col">
              {detail ? (
                <>
                  <Link
                    href={`/app/admin/finanzas?period=${currentPeriod.key}`}
                    prefetch={false}
                    className="flex min-h-12 items-center justify-center rounded-xl bg-[#FEEF00] px-5 text-sm font-bold text-[#0B0B0D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    Actualizar cifras ahora
                  </Link>
                  <Link
                    href="/app/master/ops/finance?status=pending"
                    prefetch={false}
                    className="flex min-h-12 items-center justify-center rounded-xl border border-orange-300/30 bg-orange-400/10 px-5 text-sm font-semibold text-orange-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-200"
                  >
                    Revisar pagos
                  </Link>
                  <Link
                    href="/app/admin/finanzas/cuentas"
                    prefetch={false}
                    className="flex min-h-12 items-center justify-center rounded-xl border border-[#3A3A49] bg-[#17171F] px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
                  >
                    Ver cuentas
                  </Link>
                  <Link
                    href="/app/admin/finanzas/pedidos"
                    prefetch={false}
                    className="flex min-h-12 items-center justify-center rounded-xl border border-[#3A3A49] bg-[#17171F] px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
                  >
                    Pedidos por entregar
                  </Link>
                </>
              ) : (
                <Link
                  href={financialDetailPath}
                  prefetch={false}
                  className="flex min-h-12 items-center justify-center rounded-xl bg-[#FEEF00] px-5 text-sm font-bold text-[#0B0B0D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  Ver dashboard financiero
                </Link>
              )}
            </div>
          </div>

          <div className="relative mt-7 flex flex-col gap-4 border-t border-[#2A2A38] pt-5 lg:flex-row lg:items-center lg:justify-between">
            <nav aria-label="Período del resumen financiero" className="flex gap-2 overflow-x-auto pb-1">
              {periodOptions.map((option) => {
                const isActive = option.key === currentPeriod.key;
                const periodHref = detail
                  ? `${basePath}?period=${option.key}&asOf=${encodeURIComponent(currentPeriod.asOf)}&definition=${overview.definitionVersion}`
                  : `${basePath}?period=${option.key}`;
                return (
                  <Link
                    key={option.key}
                    href={periodHref}
                    aria-current={isActive ? 'page' : undefined}
                    className={[
                      'flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
                      isActive
                        ? 'border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]'
                        : 'border-[#393948] bg-[#17171F] text-[#CECED6] hover:border-[#5A5A6A]',
                    ].join(' ')}
                  >
                    {option.label}
                  </Link>
                );
              })}
            </nav>
            <div className="text-sm leading-6 text-[#A7A7B2] lg:text-right">
              <p>
                {formatDateKey(currentPeriod.startKey)} – {formatDateKey(addDateKeyDays(currentPeriod.endExclusiveKey, -1))}
              </p>
              <p>Actualizado {dateTimeFormatter.format(new Date(currentPeriod.asOf))} · hora de Caracas</p>
            </div>
          </div>
          <details className="relative mt-4 rounded-xl border border-[#30303E] bg-[#17171F] px-4 py-3 text-sm text-[#C8C8D1]">
            <summary className="cursor-pointer font-semibold text-white">Cómo leer la calidad de los datos</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(Object.keys(qualityLabels) as FinancialQualityCode[]).map((quality) => (
                <p key={quality} className="leading-5">
                  <span className="font-semibold text-white">{qualityLabels[quality]}:</span>{' '}
                  {qualityDescriptions[quality]}
                </p>
              ))}
            </div>
          </details>
        </div>
      </section>

      <section aria-labelledby="financial-kpis-title">
        <SectionHeading
          id="financial-kpis-title"
          eyebrow="Cómo vamos"
          title="Cuatro señales, cuatro significados"
          description="Semana y Mes se comparan contra un período anterior de igual duración. Hoy se presenta como corte parcial, sin un porcentaje engañoso contra el día completo de ayer."
        />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          <DomainValue domain={overview.commercial}>
            {(data) => (
            <MetricCard
              kpi="C02"
              label="Ventas entregadas"
              value={formatUsd(data.deliveredSalesUsd)}
              context={`${integerFormatter.format(data.deliveredOrders)} orden(es) · ${periodComparisonText(data.deliveredSalesChangePct, currentPeriod.key)}`}
              quality={data.quality}
              href={`${financialDetailPath}#commercial-detail`}
            />
            )}
          </DomainValue>
          <DomainValue domain={overview.treasury}>
            {(data) => (
              <>
            <MetricCard
              kpi="T01"
              label="Cobros confirmados"
              value={formatUsd(data.confirmedCollectionsUsd)}
              context={periodComparisonText(data.collectionsChangePct, currentPeriod.key)}
              quality="Q1_exact"
              tone="positive"
              href={`${financialDetailPath}#treasury-detail`}
            />
            <MetricCard
              kpi="T03"
              label="Egresos externos"
              value={formatUsd(data.externalOutflowsUsd)}
              context={
                data.unclassifiedAdjustmentCount > 0
                  ? `${data.unclassifiedAdjustmentCount} ajuste(s) por ${formatUsd(data.unclassifiedAdjustmentUsd)} aún no están clasificados`
                  : data.incompleteTransferGroups > 0
                    ? `${data.incompleteTransferGroups} traspaso(s) incompletos o con diferencia FX requieren revisión`
                    : data.derivedWithdrawalCount > 0
                  ? `${data.derivedWithdrawalCount} retiro(s) requieren clasificación heredada`
                  : 'Transferencias internas excluidas del gasto'
              }
              quality={data.outflowQuality}
              tone="warning"
              href={`${financialDetailPath}#treasury-detail`}
            />
            <MetricCard
              kpi="T04"
              label="Flujo neto externo"
              value={formatUsd(data.netExternalCashFlowUsd)}
              context={
                data.netExternalCashFlowUsd === null
                  ? 'Bloqueado hasta clasificar los ajustes o anomalías de traspaso del período'
                  : periodComparisonText(data.netCashFlowChangePct, currentPeriod.key)
              }
              quality={data.netCashFlowQuality}
              tone={data.netExternalCashFlowUsd !== null && data.netExternalCashFlowUsd >= 0 ? 'positive' : 'warning'}
              href={`${financialDetailPath}#treasury-detail`}
            />
              </>
            )}
          </DomainValue>
        </div>
      </section>

      <section aria-labelledby="financial-trends-title">
        <SectionHeading
          id="financial-trends-title"
          eyebrow="Ritmo"
          title="Qué se entregó y qué se movió"
          description="La venta usa la fecha efectiva de entrega. Caja usa la fecha de operación guardada en cada movimiento confirmado."
        />
        <div className="mt-5 grid gap-3 xl:grid-cols-2">
          {commercial ? (
            <FinancialBarChart
              title="Ventas entregadas"
              description={
                currentPeriod.key === 'today'
                  ? 'Corte parcial de hoy frente al total de ayer; base comercial sin impuesto.'
                  : 'Base comercial sin impuesto, agrupada por fecha de entrega.'
              }
              rows={salesChartRows}
              primaryLabel="Venta entregada"
            />
          ) : (
            <DomainUnavailable message="No se pudo construir la serie comercial." />
          )}
          {treasury ? (
            <FinancialBarChart
              title="Entradas y salidas externas"
              description={cashChartDescription}
              rows={cashChartRows}
              primaryLabel="Cobros"
              secondaryLabel="Egresos"
              primaryTone="emerald"
            />
          ) : (
            <DomainUnavailable message="No se pudo construir la serie de tesorería." />
          )}
        </div>
      </section>

      <section aria-labelledby="financial-outlook-title">
        <SectionHeading
          id="financial-outlook-title"
          eyebrow="Lo que viene"
          title="Programado, no prometido"
          description="Sin una meta financiera global certificada, la referencia honesta es el pipeline de órdenes activas que ya tienen fecha."
        />
        <div className="mt-5 grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
          <DomainValue domain={overview.commercial}>
            {(data) => (
              <article className="rounded-2xl border border-[#FEEF00]/25 bg-[#FEEF00]/5 p-5 sm:p-6">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#FEEF00]">C06 · Pipeline programado</p>
                    <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{formatUsd(data.scheduledSalesUsd)}</p>
                    <p className="mt-2 text-sm text-[#C4C4CD]">
                      {integerFormatter.format(data.scheduledOrders)} orden(es) activas desde hoy hasta el cierre del período.
                    </p>
                  </div>
                  <QualityBadge quality={data.scheduledQuality} />
                </div>
                {data.blockedScheduledOrders > 0 ? (
                  <p className="mt-5 rounded-xl border border-orange-400/20 bg-orange-400/10 px-4 py-3 text-sm text-orange-100">
                    {data.blockedScheduledOrders} orden(es) adicionales requieren reaprobación y no están incluidas en el monto.
                  </p>
                ) : null}
                <Link
                  href={`${financialDetailPath}#commercial-detail`}
                  prefetch={false}
                  className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-[#FEEF00]/30 px-4 text-sm font-semibold text-[#FEEF00] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  Ver composición comercial →
                </Link>
              </article>
            )}
          </DomainValue>

          <article className="rounded-2xl border border-[#2A2A38] bg-[#111117] p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#A4A4AF]">Lectura responsable</p>
            <h3 className="mt-3 text-xl font-semibold text-white">Rentabilidad todavía no se publica</h3>
            <p className="mt-2 text-sm leading-6 text-[#A8A8B3]">
              Utilidad, margen e inventario valorizado necesitan costos certificados. Hasta entonces, la pantalla los
              muestra como no disponibles en vez de presentarlos como cero.
            </p>
            <div className="mt-4"><QualityBadge quality="Q4_blocked" /></div>
          </article>
        </div>
      </section>

      <section aria-labelledby="financial-position-title">
        <SectionHeading
          id="financial-position-title"
          eyebrow="Posición actual"
          title="Qué está bajo control y qué falta cerrar"
          description="Esta sección es una foto al momento de actualizar; no cambia cuando eliges Hoy, Semana o Mes."
        />
        <DomainValue domain={overview.position}>
          {(data) => (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                kpi="P17"
                label="Tasa general activa"
                value={data.activeRateBsPerUsd === null ? 'No disponible' : `${usdFormatter.format(data.activeRateBsPerUsd)} Bs/USD`}
                context={
                  data.activeRateEffectiveAt
                    ? `Vigente desde ${dateTimeFormatter.format(new Date(data.activeRateEffectiveAt))}`
                    : 'No hay una tasa activa identificada'
                }
                quality={
                  data.activeRateCount === 1
                    ? 'Q1_exact'
                    : data.activeRateCount === 0
                      ? 'Q4_blocked'
                      : 'Q3_incomplete'
                }
                href={`${financialDetailPath}#position-detail`}
              />
              <MetricCard
                kpi="P04"
                label="Fondos de clientes"
                value={formatUsd(data.clientFundsUsd)}
                context={
                  data.clientFundsUsd === null
                    ? 'No se pudo certificar la obligación al corte'
                    : data.clientFundDifferenceUsd !== null && Math.abs(data.clientFundDifferenceUsd) > 0.01
                    ? `Diferencia de ${formatUsd(Math.abs(data.clientFundDifferenceUsd))} frente al ledger`
                    : 'Obligación registrada, conciliada contra su ledger'
                }
                quality={data.clientFundsQuality}
                tone="warning"
                href={`${financialDetailPath}#position-detail`}
              />
              <MetricCard
                kpi="P13"
                label="Cuentas con ancla"
                value={`${data.anchoredAccounts}/${data.activeAccounts}`}
                context={data.latestClosureDate ? `Último cierre visible: ${formatDateKey(data.latestClosureDate)}` : 'Sin cierres visibles'}
                quality={data.accountCoverageQuality}
                href="/app/admin/finanzas/cuentas"
              />
              <MetricCard
                kpi="P03"
                label="Posición de tesorería"
                value={formatUsd(data.treasuryPositionUsd)}
                context="Se habilitará cuando el alcance de cuentas y su valoración estén certificados"
                quality={data.treasuryQuality}
                href={`${financialDetailPath}#position-detail`}
              />
            </div>
          )}
        </DomainValue>
      </section>

      <section id="pendientes" className="scroll-mt-24" aria-labelledby="financial-attention-title">
        <SectionHeading
          id="financial-attention-title"
          eyebrow="Atención requerida"
          title="Lo que necesita una decisión"
          description="Estos contadores son trabajo pendiente; nunca se suman como dinero realizado."
        />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <DomainValue domain={overview.treasury}>
            {(data) => (
              <>
                <Link
                  href="/app/master/ops/finance?status=pending"
                  prefetch={false}
                  className="rounded-2xl border border-orange-400/25 bg-orange-400/5 p-5 transition hover:border-orange-300/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-200 motion-reduce:transition-none"
                >
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-orange-200">T08 · Reportes de pago</p>
                  <p className="mt-3 text-3xl font-semibold text-white">{data.pendingPaymentReports}</p>
                  <p className="mt-1 text-sm text-[#B9B9C3]">{formatUsd(data.pendingPaymentReportsUsd)} reportados, aún no caja.</p>
                  <p className="mt-4 text-sm font-semibold text-orange-100">Revisar pagos →</p>
                </Link>
                <Link
                  href="/app/admin/finanzas/cuentas?state=pending_movements"
                  prefetch={false}
                  className="rounded-2xl border border-blue-400/20 bg-blue-400/5 p-5 transition hover:border-blue-300/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-200 motion-reduce:transition-none"
                >
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-200">T07 · Movimientos</p>
                  <p className="mt-3 text-3xl font-semibold text-white">{data.pendingMovementOperations}</p>
                  <p className="mt-1 text-sm text-[#B9B9C3]">Operación(es) agrupadas pendientes de aprobación.</p>
                  <p className="mt-4 text-sm font-semibold text-blue-100">Ver cuentas afectadas →</p>
                </Link>
              </>
            )}
          </DomainValue>
          <DomainValue domain={overview.position}>
            {(data) => (
              <Link
                href="/app/admin/finanzas/cuentas?state=open_reconciliation"
                prefetch={false}
                className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5 transition hover:border-red-300/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-200 motion-reduce:transition-none"
              >
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-red-200">P12 · Conciliaciones</p>
                <p className="mt-3 text-3xl font-semibold text-white">{data.openReconciliations}</p>
                <p className="mt-1 text-sm text-[#B9B9C3]">{formatUsd(data.openReconciliationsUsd)} de diferencia absoluta abierta.</p>
                <p className="mt-4 text-sm font-semibold text-red-100">Ir a conciliación →</p>
              </Link>
            )}
          </DomainValue>
        </div>
      </section>

      {detail ? (
        <div className="space-y-4">
          <section id="commercial-detail" className="scroll-mt-24 rounded-2xl border border-[#2A2A38] bg-[#111117] p-5 sm:p-6">
            <SectionHeading
              id="commercial-detail-title"
              eyebrow="Detalle comercial"
              title="Venta realizada y pipeline"
              description="La venta realizada usa entrega efectiva. El pipeline solo incluye órdenes activas programadas y separa las que requieren reaprobación."
            />
            <DomainValue domain={overview.commercial}>
              {(data) => (
                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <BreakdownStat
                    label="Período actual"
                    value={formatUsd(data.deliveredSalesUsd)}
                    context={`${data.deliveredOrders} orden(es) entregadas`}
                  />
                  <BreakdownStat
                    label="Período anterior"
                    value={formatUsd(data.previousDeliveredSalesUsd)}
                    context={`${data.previousDeliveredOrders} orden(es) entregadas`}
                  />
                  <BreakdownStat
                    label="Cobertura de precio"
                    value={`${data.exactPricingOrders}/${data.totalPricingOrders}`}
                    context="Órdenes entregadas con subtotal comercial explícito"
                  />
                  <BreakdownStat
                    label="Pipeline incluido"
                    value={formatUsd(data.scheduledSalesUsd)}
                    context={`${data.scheduledExactPricingOrders}/${data.scheduledOrders} con precio exacto · ${data.blockedScheduledOrders} bloqueada(s)`}
                  />
                </div>
              )}
            </DomainValue>
          </section>

          <section id="treasury-detail" className="scroll-mt-24 rounded-2xl border border-[#2A2A38] bg-[#111117] p-5 sm:p-6">
            <SectionHeading
              id="treasury-detail-title"
              eyebrow="Detalle de tesorería"
              title="Entradas, salidas y clasificación"
              description="La suma usa movimientos confirmados y su fecha real de operación. Lo no clasificable se declara y puede bloquear el neto."
            />
            <DomainValue domain={overview.treasury}>
              {(data) => (
                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <BreakdownStat label="Cobros de órdenes" value={formatUsd(data.confirmedCollectionsUsd)} context="T01 · entradas confirmadas" />
                  <BreakdownStat label="Otros ingresos externos" value={formatUsd(data.otherExternalIncomeUsd)} context="Excluye patas de traspasos internos" />
                  <BreakdownStat label="Egresos identificados" value={formatUsd(data.externalOutflowsUsd)} context={`T03 · calidad ${qualityLabels[data.outflowQuality].toLowerCase()}`} />
                  <BreakdownStat label="Flujo neto externo" value={formatUsd(data.netExternalCashFlowUsd)} context={data.netExternalCashFlowUsd === null ? 'No publicable con clasificación pendiente' : 'T01 + otros ingresos − T03'} />
                  <BreakdownStat label="Traspasos excluidos" value={String(data.internalTransferGroupsExcluded)} context={`${data.incompleteTransferGroups} grupo(s) incompletos o con diferencia FX`} />
                  <BreakdownStat label="Ajustes sin clasificar" value={formatUsd(data.unclassifiedAdjustmentUsd)} context={`${data.unclassifiedAdjustmentCount} movimiento(s) fuera del neto`} />
                </div>
              )}
            </DomainValue>
          </section>

          <section id="position-detail" className="scroll-mt-24 rounded-2xl border border-[#2A2A38] bg-[#111117] p-5 sm:p-6">
            <SectionHeading
              id="position-detail-title"
              eyebrow="Detalle de posición"
              title="Tasa, fondos y controles al corte"
              description="Los fondos de clientes son una obligación. La posición bruta permanece bloqueada hasta certificar el alcance y ancla de todas las cuentas."
            />
            <DomainValue domain={overview.position}>
              {(data) => (
                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <BreakdownStat label="Tasa activa" value={data.activeRateBsPerUsd === null ? 'No disponible' : `${usdFormatter.format(data.activeRateBsPerUsd)} Bs/USD`} context={`${data.activeRateCount} tasa(s) activas al corte`} />
                  <BreakdownStat label="Fondos según clientes" value={formatUsd(data.clientFundsUsd)} context="Saldo cacheado de la obligación" />
                  <BreakdownStat label="Fondos según ledger" value={formatUsd(data.clientFundLedgerUsd)} context="Créditos menos débitos del subledger" />
                  <BreakdownStat label="Diferencia de fondos" value={formatUsd(data.clientFundDifferenceUsd)} context={qualityLabels[data.clientFundsQuality]} />
                  <BreakdownStat label="Cobertura de cuentas" value={`${data.anchoredAccounts}/${data.activeAccounts}`} context="Cuentas activas con baseline o cierre válido" />
                  <BreakdownStat label="Conciliaciones huérfanas" value={String(data.orphanedReconciliations)} context={`${data.openReconciliations} conciliación(es) abiertas en total`} />
                </div>
              )}
            </DomainValue>
          </section>

          <section className="rounded-2xl border border-[#2A2A38] bg-[#111117] p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#FEEF00]">Alcance de esta versión</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Lectura ejecutiva lista; operación avanzada en transición</h2>
            <p className="mt-3 max-w-4xl text-sm leading-6 text-[#A8A8B3]">
              Esta ruta ya consulta resúmenes pequeños y protegidos. Cuentas, movimientos, cierres, conciliación y tasa
              se migrarán aquí por cortes completos; mientras tanto, los botones superiores conservan acceso a las
              herramientas vigentes sin duplicar acciones financieras.
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
