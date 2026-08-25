import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { ADVISOR_GOAL_METRICS } from '@/lib/commissions/goal-engine';
import type { AdvisorGoalMetricKey, AdvisorGoalSeasonality } from '@/lib/commissions/goal-engine';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import { suggestNextAdvisorGoalPeriod } from '@/lib/commissions/goal-period';
import type { AdvisorGoalSimulatedMetric } from '@/lib/commissions/goal-simulation';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
  resolveAdvisorGoalScoringConfiguration,
} from '@/lib/commissions/goal-snapshot';
import type { AdvisorGoalAuditEntry } from '@/lib/commissions/goal-snapshot';
import {
  createAdvisorGoalProjectionPeriodAction,
  finalizeAdvisorGoalResultsAction,
  saveAdvisorGoalConfigurationAction,
} from './actions';
import { AdvisorGoalCollectionBreakdown } from '../AdvisorGoalCollectionBreakdown';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Promise<{
  [key: string]: string | undefined;
  period?: string;
  billingContext?: string;
  closuresContext?: string;
  campaign?: string;
  growth?: string;
  notice?: string;
  error?: string;
}>;

type PeriodRow = {
  id: number | string;
  name: string;
  date_from: string;
  date_to: string;
  status: string;
  goal_config: unknown;
};

function numberParam(value: string | undefined) {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value.trim().replace(/\s/g, '').replace('%', '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberLabel(value: number | null, digits = 2) {
  if (value == null) return 'Por definir';
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function money(value: number | null) {
  return value == null ? 'Por definir' : `$${numberLabel(value)}`;
}

function percent(value: number | null, digits = 2) {
  return value == null ? 'Por definir' : `${numberLabel(value * 100, digits)}%`;
}

function contextPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${numberLabel(value)}%`;
}

function editableNumber(value: number) {
  return new Intl.NumberFormat('es-VE', {
    useGrouping: false,
    maximumFractionDigits: 2,
  }).format(value);
}

const metricWeightParam: Record<AdvisorGoalMetricKey, string> = {
  billing: 'weightBilling',
  closures: 'weightClosures',
  collection: 'weightCollection',
  new_own_clients: 'weightOwnClients',
  new_assigned_clients: 'weightAssignedClients',
};

function bandMinParam(key: string) {
  return `bandMin${key[0].toUpperCase()}${key.slice(1)}`;
}

function bandCommissionParam(key: string) {
  return `bandCommission${key[0].toUpperCase()}${key.slice(1)}`;
}

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00-04:00`);
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function dateTimeLabel(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function periodStatusLabel(period: PeriodRow) {
  const config = readAdvisorGoalPeriodConfig(period.goal_config);
  if (!config) return 'Sin guardar';
  if (config.status === 'closed') return 'Finalizada';
  if (config.status === 'published') return 'Publicada';
  return 'Borrador';
}

function confidenceCopy(seasonality: AdvisorGoalSeasonality) {
  if (seasonality.confidence === 'high') {
    return {
      label: 'Base histórica sólida',
      detail: `${seasonality.sampleCount} comparaciones de ${seasonality.yearCount} años. Es una referencia confiable, no una obligación.`,
    };
  }
  if (seasonality.confidence === 'medium') {
    return {
      label: 'Base histórica útil',
      detail: `${seasonality.sampleCount} comparaciones de ${seasonality.yearCount} años. Conviene validarla con el contexto comercial.`,
    };
  }
  return {
    label: 'Pocos antecedentes',
    detail: `${seasonality.sampleCount} comparaciones de ${seasonality.yearCount} años. Administración debe decidir con mayor cautela.`,
  };
}

function auditActionLabel(action: AdvisorGoalAuditEntry['action']) {
  if (action === 'generated') return 'Borrador creado';
  if (action === 'published') return 'Meta publicada';
  if (action === 'finalized') return 'Resultado finalizado';
  if (action === 'rate_overridden') return 'Porcentaje sustituido';
  return 'Configuración modificada';
}

function auditNumber(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ConfigurationHistory({ audit }: { audit: AdvisorGoalAuditEntry[] }) {
  if (audit.length === 0) return null;
  return (
    <details className="rounded-2xl border border-[#30303A] bg-[#0E0E12] px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#D9D9E0]">
        Historial de versiones ({audit.length})
      </summary>
      <div className="mt-3 space-y-2 border-t border-[#292933] pt-3">
        {[...audit].reverse().map((entry, index) => {
          const nextBilling = auditNumber(entry.next, 'billingContextPct');
          const nextClosures = auditNumber(entry.next, 'closuresContextPct');
          const nextCampaign = auditNumber(entry.next, 'campaignBoostPct') ?? 0;
          const nextGrowth = auditNumber(entry.next, 'growthChallengePct');
          const hasScoring = Boolean(entry.next?.scoring && typeof entry.next.scoring === 'object');
          return (
            <article className="rounded-xl bg-[#15151B] px-3 py-2.5" key={`${entry.version}-${entry.recordedAt}-${index}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[#E8E8ED]">Revisión {entry.version} · {auditActionLabel(entry.action)}</div>
                <div className="text-[11px] text-[#898995]">{dateTimeLabel(entry.recordedAt)}</div>
              </div>
              {nextBilling != null && nextClosures != null && nextGrowth != null ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#B6B6C0]">
                  <span>Temporada facturación <strong className="text-[#F2F2F5]">{contextPercent(nextBilling)}</strong></span>
                  <span>Temporada cierres <strong className="text-[#F2F2F5]">{contextPercent(nextClosures)}</strong></span>
                  <span>Campaña <strong className="text-[#F2F2F5]">+{numberLabel(nextCampaign)}%</strong></span>
                  <span>Desafío <strong className="text-[#F2F2F5]">+{numberLabel(nextGrowth)}%</strong></span>
                  {hasScoring ? <span><strong className="text-[#F2F2F5]">Base de puntos y porcentajes registrada</strong></span> : null}
                </div>
              ) : null}
              {entry.reason ? <p className="mt-1.5 text-[11px] leading-5 text-[#9D9DA8]">Motivo: {entry.reason}</p> : null}
            </article>
          );
        })}
      </div>
    </details>
  );
}

function metricPoints(
  score: { metrics: Array<{ key: string; points: number; basePoints: number }> } | null,
  key: string
) {
  return score?.metrics.find((metric) => metric.key === key) ?? null;
}

function CompactAdvisorValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.11em] text-[#767681] xl:hidden">{label}</div>
      <div className="mt-0.5 truncate text-xs font-semibold text-[#E1E1E6]" title={value}>{value}</div>
    </div>
  );
}

function History({ metric, moneyValues = false }: { metric: AdvisorGoalSimulatedMetric; moneyValues?: boolean }) {
  return (
    <details className="mt-3 rounded-xl border border-[#30303A] bg-[#101014] px-3 py-2.5">
      <summary className="cursor-pointer text-[11px] font-semibold text-[#C9C9D1]">
        Ver los {metric.history.length} periodos usados
      </summary>
      <div className="mt-2 space-y-1.5 border-t border-[#2A2A33] pt-2 text-xs text-[#A9A9B4]">
        {metric.history.map((item) => (
          <div className="flex items-center justify-between gap-3" key={item.periodKey}>
            <span>{item.periodKey}</span>
            <span className="font-medium text-[#E8E8EC]">
              {moneyValues ? money(item.value) : numberLabel(item.value, 0)}
            </span>
          </div>
        ))}
        {metric.recentContext ? (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-sky-400/20 bg-sky-400/5 px-2.5 py-2 text-sky-100">
            <span>{metric.recentContext.periodKey} · solo contexto</span>
            <span className="font-medium">
              {moneyValues ? money(metric.recentContext.value) : numberLabel(metric.recentContext.value, 0)}
            </span>
          </div>
        ) : null}
        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[#2A2A33] pt-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#83838F]">Mediana disponible</div>
            <div className="mt-0.5 text-[#E8E8EC]">
              {moneyValues ? money(metric.capacity.medianAvailable) : numberLabel(metric.capacity.medianAvailable)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#83838F]">Últimos 3</div>
            <div className="mt-0.5 text-[#E8E8EC]">
              {moneyValues ? money(metric.capacity.medianRecent) : numberLabel(metric.capacity.medianRecent)}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}

function MetricCard({
  label,
  metric,
  points,
  moneyValues = false,
  ratio = false,
  projection = false,
  rule = 'commercial',
}: {
  label: string;
  metric: AdvisorGoalSimulatedMetric;
  points: { points: number; basePoints: number } | null;
  moneyValues?: boolean;
  ratio?: boolean;
  projection?: boolean;
  rule?: 'commercial' | 'new-client' | 'collection';
}) {
  const value = (input: number | null) => ratio
    ? percent(input)
    : moneyValues
      ? money(input)
      : numberLabel(input, 0);
  return (
    <article className="rounded-2xl border border-[#2B2B35] bg-[#15151B] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">{label}</div>
          <div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#F7F7F8]">{projection ? 'Por iniciar' : value(metric.actual)}</div>
          <div className="mt-0.5 text-[11px] text-[#92929E]">{projection ? 'Todavía sin resultado' : 'Resultado observado'}</div>
        </div>
        {points ? (
          <div className="rounded-full border border-[#F0D000]/30 bg-[#F0D000]/10 px-2.5 py-1 text-xs font-semibold text-[#F7DA66]">
            {projection ? `hasta ${numberLabel(points.basePoints, 0)} pts` : `${numberLabel(points.points, 1)} / ${numberLabel(points.basePoints, 0)} pts`}
          </div>
        ) : null}
      </div>
      <div className={`mt-4 grid gap-2 text-xs ${rule === 'new-client' ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <div className="rounded-xl bg-[#101014] p-2.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">{rule === 'collection' ? 'Piso saludable' : '1 · Referencia'}</div>
          <div className="mt-1 font-semibold text-[#E9E9ED]">{value(metric.reference)}</div>
        </div>
        {rule === 'commercial' ? (
          <>
            <div className="rounded-xl bg-[#101014] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">2 · Temporada</div>
              <div className="mt-1 font-semibold text-[#E9E9ED]">{contextPercent(metric.appliedContextPct)}</div>
              <div className="mt-0.5 text-[10px] text-[#858591]">queda en {value(metric.expectedCapacity)}</div>
            </div>
            <div className="rounded-xl bg-[#101014] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">3 · Campaña</div>
              <div className="mt-1 font-semibold text-[#E9E9ED]">+{numberLabel(metric.campaignBoostPct)}%</div>
              <div className="mt-0.5 text-[10px] text-[#858591]">queda en {value(metric.campaignCapacity)}</div>
            </div>
            <div className="rounded-xl bg-[#101014] p-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">4 · Desafío</div>
              <div className="mt-1 font-semibold text-[#E9E9ED]">+{numberLabel(metric.growthChallengePct)}%</div>
              <div className="mt-0.5 text-[10px] text-[#858591]">sobre la proyección</div>
            </div>
          </>
        ) : rule === 'new-client' ? (
          <div className="rounded-xl bg-[#101014] p-2.5">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">2 · Impulso</div>
            <div className="mt-1 font-semibold text-[#E9E9ED]">+1 cliente</div>
          </div>
        ) : null}
        <div className={`rounded-xl bg-[#101014] p-2.5 ${rule === 'commercial' ? 'col-span-2' : ''}`}>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">{rule === 'commercial' ? '5 · Meta' : rule === 'new-client' ? '3 · Meta' : '2 · Meta ideal'}</div>
          <div className="mt-1 font-semibold text-[#F7DA66]">{value(metric.target)}</div>
        </div>
      </div>
      {metric.history.length > 0 ? <History metric={metric} moneyValues={moneyValues} /> : null}
    </article>
  );
}

export default async function AdvisorGoalAdministrationPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin')) redirect(resolveHomePath(ctx.roles));

  const params = (await searchParams) ?? {};
  const periodsResult = await ctx.supabase
    .from('advisor_commission_periods')
    .select('id, name, date_from, date_to, status, goal_config')
    .order('date_from', { ascending: false })
    .limit(120);
  if (periodsResult.error) throw new Error(periodsResult.error.message);
  const periods = (periodsResult.data ?? []) as PeriodRow[];
  const requestedPeriodId = Number(params.period ?? 0);
  const selectedPeriod = periods.find((period) => Number(period.id) === requestedPeriodId) ?? periods[0] ?? null;
  const selectedPeriodIndex = selectedPeriod
    ? periods.findIndex((period) => Number(period.id) === Number(selectedPeriod.id))
    : -1;
  const newerPeriod = selectedPeriodIndex > 0 ? periods[selectedPeriodIndex - 1] : null;
  const olderPeriod = selectedPeriodIndex >= 0 && selectedPeriodIndex < periods.length - 1
    ? periods[selectedPeriodIndex + 1]
    : null;
  const nextPeriodSuggestion = selectedPeriod
    ? suggestNextAdvisorGoalPeriod(selectedPeriod.date_to)
    : null;
  const existingNextPeriod = nextPeriodSuggestion
    ? periods.find((period) =>
        period.date_from === nextPeriodSuggestion.dateFrom
        && period.date_to === nextPeriodSuggestion.dateTo
      ) ?? null
    : null;
  const storedConfig = readAdvisorGoalPeriodConfig(selectedPeriod?.goal_config);
  const storedScoring = resolveAdvisorGoalScoringConfiguration(storedConfig);
  const metricBasePoints = Object.fromEntries(
    ADVISOR_GOAL_METRICS.map((metric) => {
      const storedWeight = storedScoring.metricBasePoints[metric.key] / 2;
      const weight = numberParam(params[metricWeightParam[metric.key]]) ?? storedWeight;
      return [metric.key, weight * 2];
    })
  ) as Record<AdvisorGoalMetricKey, number>;
  const bands = storedScoring.bands.map((band) => ({
    ...band,
    minPoints: band.key === 'yuca'
      ? 0
      : numberParam(params[bandMinParam(band.key)]) ?? band.minPoints,
    commissionPct: numberParam(params[bandCommissionParam(band.key)]) ?? band.commissionPct,
  }));
  const context = {
    growthChallengePct: numberParam(params.growth) ?? storedConfig?.growthChallengePct,
    campaignBoostPct: numberParam(params.campaign) ?? storedConfig?.campaignBoostPct ?? 0,
    billingContextPct: numberParam(params.billingContext) ?? storedConfig?.billing.appliedPct,
    closuresContextPct: numberParam(params.closuresContext) ?? storedConfig?.closures.appliedPct,
    metricBasePoints,
    bands,
  };

  let simulation: Awaited<ReturnType<typeof loadAdvisorGoalSimulation>> | null = null;
  let simulationError: string | null = null;
  if (selectedPeriod) {
    try {
      simulation = await loadAdvisorGoalSimulation({
        supabase: ctx.supabase,
        periodId: Number(selectedPeriod.id),
        periodFrom: selectedPeriod.date_from,
        periodTo: selectedPeriod.date_to,
        context,
      });
    } catch (error) {
      simulationError = error instanceof Error ? error.message : 'No se pudo construir la simulación.';
    }
  }
  const storedGoalByAdvisorId = new Map<string, NonNullable<ReturnType<typeof readAdvisorGoalPublicationSnapshot>>>();
  if (selectedPeriod) {
    const storedGoalsResult = await ctx.supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, snapshot')
      .eq('period_id', Number(selectedPeriod.id));
    if (!storedGoalsResult.error) {
      for (const closure of storedGoalsResult.data ?? []) {
        const goal = readAdvisorGoalPublicationSnapshot(closure.snapshot);
        if (goal) storedGoalByAdvisorId.set(String(closure.advisor_user_id), goal);
      }
    }
  }

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F7F7F8]">
      <header className="border-b border-[#24242D] bg-[#101014]">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.04em]">Metas y porcentajes</h1>
              <span className="rounded-full border border-[#F0D000]/35 bg-[#F0D000]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#F7DA66]">
                Simulación auditable
              </span>
            </div>
            <p className="mt-1 text-sm text-[#A9A9B4]">Capacidad personal, temporalidad, campaña, desafío y resultado sin fórmulas ocultas.</p>
          </div>
          <Link className="inline-flex w-fit items-center rounded-full border border-[#34343F] px-4 py-2 text-sm font-semibold text-[#D8D8DF] hover:border-[#F0D000] hover:text-[#F7DA66]" href={`/app/commissions${selectedPeriod ? `?period=${selectedPeriod.id}` : ''}`}>
            Volver a comisiones
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] space-y-5 px-5 py-6">
        {params.notice ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{params.notice}</div>
        ) : null}
        {params.error ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{params.error}</div>
        ) : null}
        {selectedPeriod ? (
          <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Período de trabajo</div>
                  <span className="rounded-full border border-[#373742] bg-[#18181F] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C4C4CC]">
                    {storedConfig ? `${storedConfig.status === 'published' ? 'Publicada' : storedConfig.status === 'closed' ? 'Finalizada' : 'Borrador'} · revisión ${storedConfig.revision}` : 'Sin guardar'}
                  </span>
                  {simulation?.mode === 'projection' ? (
                    <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-200">Proyección previa</span>
                  ) : null}
                </div>
                <h2 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">{selectedPeriod.name}</h2>
                <div className="mt-1 text-xs text-[#9696A2]">Del {dateLabel(selectedPeriod.date_from)} al {dateLabel(selectedPeriod.date_to)} · corte de cobranza {simulation ? dateLabel(simulation.cutoffDate) : 'por calcular'}</div>
              </div>
              <form className="flex w-full max-w-xl items-end gap-2" method="get">
                <label className="min-w-0 flex-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#898995]">Cambiar de período</span>
                  <select className="mt-1 h-10 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={String(selectedPeriod.id)} name="period">
                    {periods.map((period) => (
                      <option key={period.id} value={period.id}>{period.name} · {periodStatusLabel(period)}</option>
                    ))}
                  </select>
                </label>
                <button className="h-10 rounded-xl border border-[#4A4A56] px-4 text-sm font-semibold text-[#E3E3E8] hover:border-[#F0D000] hover:text-[#F7DA66]" type="submit">Abrir</button>
              </form>
            </div>

            <div className="mt-4 flex flex-col gap-3 border-t border-[#292933] pt-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2 text-xs">
                {olderPeriod ? <Link className="rounded-lg border border-[#30303A] px-3 py-1.5 text-[#BDBDC6] hover:text-white" href={`/app/commissions/goals?period=${olderPeriod.id}`}>← {olderPeriod.name}</Link> : null}
                {newerPeriod ? <Link className="rounded-lg border border-[#30303A] px-3 py-1.5 text-[#BDBDC6] hover:text-white" href={`/app/commissions/goals?period=${newerPeriod.id}`}>{newerPeriod.name} →</Link> : null}
              </div>
              {nextPeriodSuggestion ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="text-xs text-[#8FA7B6]">Próximo: {nextPeriodSuggestion.name} · esto solo prepara la proyección</span>
                  {existingNextPeriod ? (
                    <Link className="inline-flex h-9 items-center justify-center rounded-xl border border-sky-300/35 px-3 text-xs font-semibold text-sky-100" href={`/app/commissions/goals?period=${existingNextPeriod.id}`}>Abrir próximo</Link>
                  ) : (
                    <form action={createAdvisorGoalProjectionPeriodAction}>
                      <input name="sourcePeriodId" type="hidden" value={selectedPeriod.id} />
                      <button className="h-9 rounded-xl border border-sky-300/35 px-3 text-xs font-semibold text-sky-100 hover:bg-sky-400/10" type="submit">Preparar próximo período</button>
                    </form>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {simulationError ? (
          <section className="rounded-3xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-100">{simulationError}</section>
        ) : null}

        {simulation ? (
          <>
            <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#F7DA66]">1 · Configurar la meta</div>
                  <h2 className="mt-1 text-xl font-semibold tracking-[-0.025em]">Temporada, campaña y desafío</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A5A5B0]">El histórico sugiere la temporada. Administración decide cuánto aplicar, añade el impulso esperado de la campaña y finalmente establece el desafío de crecimiento. Puedes escribir enteros o decimales con coma o punto.</p>
                </div>
                <div className="rounded-xl border border-[#30303A] bg-[#0E0E12] px-3 py-2 text-xs text-[#A9A9B4]">
                  {storedConfig
                    ? `Guardado actual: temporada ${contextPercent(storedConfig.billing.appliedPct)} facturación, ${contextPercent(storedConfig.closures.appliedPct)} cierres, campaña +${numberLabel(storedConfig.campaignBoostPct ?? 0)}% y desafío +${numberLabel(storedConfig.growthChallengePct)}%.`
                    : 'Todavía no hay una versión guardada para este período.'}
                </div>
              </div>

              <form className="mt-5" method="get">
                <input name="period" type="hidden" value={selectedPeriod?.id ?? ''} />
                <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                  {([
                    {
                      label: 'Facturación',
                      name: 'billingContext',
                      seasonal: simulation.seasonality.billing,
                      applied: simulation.appliedContext.billingPct,
                    },
                    {
                      label: 'Cierres',
                      name: 'closuresContext',
                      seasonal: simulation.seasonality.closures,
                      applied: simulation.appliedContext.closuresPct,
                    },
                  ] as const).map((item) => {
                    const confidence = confidenceCopy(item.seasonal);
                    return (
                      <article className="rounded-2xl border border-[#30303A] bg-[#0E0E12] p-4" key={item.name}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#8F8F9B]">Ajuste de temporada · {item.label}</div>
                            <div className="mt-1 text-lg font-semibold">El histórico sugiere {contextPercent(item.seasonal.suggestedPct)}</div>
                          </div>
                          <span className="rounded-full border border-sky-400/20 bg-sky-400/5 px-2 py-1 text-[10px] font-semibold text-sky-100">{confidence.label}</span>
                        </div>
                        <p className="mt-2 text-[11px] leading-5 text-[#9797A3]">{confidence.detail}</p>
                        <label className="mt-4 block">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#B7B7C1]">Decisión de administración</span>
                          <div className="relative mt-1">
                            <input
                              className="h-11 w-full rounded-xl border border-[#40404C] bg-[#15151B] px-3 pr-9 text-base font-semibold outline-none focus:border-[#F0D000]"
                              defaultValue={editableNumber(item.applied)}
                              inputMode="decimal"
                              name={item.name}
                              type="text"
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#858591]">%</span>
                          </div>
                        </label>
                        <details className="mt-3 text-[11px] text-[#9797A3]">
                          <summary className="cursor-pointer font-semibold text-[#C7C7CF]">Cómo se obtuvo la recomendación</summary>
                          <p className="mt-2 leading-5">Compara el cambio hacia esta misma quincena en años anteriores. El rango habitual fue {contextPercent(item.seasonal.typicalLowPct)} a {contextPercent(item.seasonal.typicalHighPct)}.</p>
                        </details>
                      </article>
                    );
                  })}

                  <article className="rounded-2xl border border-violet-400/25 bg-violet-400/5 p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-violet-200">Impulso de campaña</div>
                    <div className="mt-1 text-lg font-semibold">Efecto comercial esperado</div>
                    <p className="mt-2 text-[11px] leading-5 text-[#ACA3BD]">Es una decisión administrativa del período. No cambia la lectura histórica: aumenta por igual la proyección de facturación y cierres.</p>
                    <label className="mt-4 block">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-200">Campaña aplicada</span>
                      <div className="relative mt-1">
                        <input className="h-11 w-full rounded-xl border border-violet-400/30 bg-[#100D14] px-3 pr-9 text-base font-semibold outline-none focus:border-violet-300" defaultValue={editableNumber(simulation.appliedContext.campaignBoostPct)} inputMode="decimal" name="campaign" type="text" />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-violet-200/60">%</span>
                      </div>
                    </label>
                  </article>

                  <article className="rounded-2xl border border-[#F0D000]/25 bg-[#15140C] p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#D0BC46]">Desafío adicional</div>
                    <div className="mt-1 text-lg font-semibold">Crecimiento sobre la proyección</div>
                    <p className="mt-2 text-[11px] leading-5 text-[#AAA68E]">Se aplica después de temporada y campaña. Es el esfuerzo adicional que convierte la proyección esperada en la meta final.</p>
                    <label className="mt-4 block">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C9C39D]">Desafío aplicado</span>
                      <div className="relative mt-1">
                        <input className="h-11 w-full rounded-xl border border-[#48442C] bg-[#0E0E0B] px-3 pr-9 text-base font-semibold outline-none focus:border-[#F0D000]" defaultValue={editableNumber(simulation.appliedContext.growthChallengePct)} inputMode="decimal" name="growth" type="text" />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#928C68]">%</span>
                      </div>
                    </label>
                  </article>
                </div>

                <section className="mt-4 rounded-2xl border border-[#30303A] bg-[#0E0E12] p-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#F7DA66]">Base de puntos y porcentajes</div>
                      <h3 className="mt-1 text-base font-semibold">Define cuánto vale cada indicador y qué comisión entrega cada banda</h3>
                    </div>
                    <div className="text-xs text-[#94949F]">Los pesos deben sumar 100% · equivalen a 200 puntos base</div>
                  </div>
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <div className="overflow-hidden rounded-xl border border-[#292933]">
                      <div className="grid grid-cols-[minmax(0,1fr)_82px_72px] gap-2 bg-[#15151B] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.11em] text-[#858591]">
                        <span>Indicador</span><span className="text-right">Peso</span><span className="text-right">Puntos</span>
                      </div>
                      <div className="divide-y divide-[#292933]">
                        {simulation.scoring.metrics.map((metric) => (
                          <label className="grid grid-cols-[minmax(0,1fr)_82px_72px] items-center gap-2 px-3 py-2" key={metric.key}>
                            <span className="truncate text-xs font-medium text-[#DADAE0]">{metric.label}</span>
                            <span className="relative">
                              <input
                                aria-label={`Peso de ${metric.label}`}
                                className="h-8 w-full rounded-lg border border-[#3A3A45] bg-[#101014] px-2 pr-6 text-right text-xs font-semibold outline-none focus:border-[#F0D000]"
                                defaultValue={editableNumber(metric.weightPct)}
                                inputMode="decimal"
                                name={metricWeightParam[metric.key]}
                                type="text"
                              />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#777783]">%</span>
                            </span>
                            <span className="text-right text-xs font-semibold text-[#F7DA66]">{numberLabel(metric.basePoints, 1)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-[#292933]">
                      <div className="grid grid-cols-[minmax(0,1fr)_92px_88px] gap-2 bg-[#15151B] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.11em] text-[#858591]">
                        <span>Banda</span><span className="text-right">Desde pts</span><span className="text-right">Comisión</span>
                      </div>
                      <div className="divide-y divide-[#292933]">
                        {simulation.scoring.bands.map((band) => (
                          <div className="grid grid-cols-[minmax(0,1fr)_92px_88px] items-center gap-2 px-3 py-2" key={band.key}>
                            <span className="text-xs font-medium text-[#DADAE0]">{band.label}</span>
                            {band.key === 'yuca' ? (
                              <span className="text-right text-xs font-semibold text-[#A5A5B0]">0</span>
                            ) : (
                              <input
                                aria-label={`Puntos mínimos de ${band.label}`}
                                className="h-8 w-full rounded-lg border border-[#3A3A45] bg-[#101014] px-2 text-right text-xs font-semibold outline-none focus:border-[#F0D000]"
                                defaultValue={editableNumber(band.minPoints)}
                                inputMode="decimal"
                                name={bandMinParam(band.key)}
                                type="text"
                              />
                            )}
                            <span className="relative">
                              <input
                                aria-label={`Comisión de ${band.label}`}
                                className="h-8 w-full rounded-lg border border-[#3A3A45] bg-[#101014] px-2 pr-6 text-right text-xs font-semibold outline-none focus:border-[#F0D000]"
                                defaultValue={editableNumber(band.commissionPct)}
                                inputMode="decimal"
                                name={bandCommissionParam(band.key)}
                                type="text"
                              />
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#777783]">%</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-[11px] leading-5 text-[#858591]">Al recalcular, los puntos se derivan del peso: 1% equivale a 2 puntos. Las bandas deben crecer sin duplicados y sus porcentajes no pueden disminuir.</p>
                </section>
                <div className="mt-4 flex flex-col gap-2 border-t border-[#292933] pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[#8F8F9B]">Recalcular solo cambia esta vista. No guarda ni publica nada.</p>
                  <div className="flex gap-2">
                    <Link className="inline-flex h-10 items-center rounded-xl border border-[#3A3A45] px-4 text-sm font-semibold text-[#C9C9D1] hover:text-white" href={`/app/commissions/goals?period=${selectedPeriod?.id ?? ''}`}>
                      {storedConfig ? 'Volver a lo guardado' : 'Usar recomendación'}
                    </Link>
                    <button className="h-10 rounded-xl bg-[#F0D000] px-5 text-sm font-semibold text-[#111113] hover:bg-[#FFE44F]" type="submit">Recalcular metas</button>
                  </div>
                </div>
              </form>

              {storedConfig?.status !== 'closed' ? (
                <div className="mt-5 border-t border-[#292933] pt-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#F7DA66]">2 · Confirmar configuración</div>
                      <h3 className="mt-1 text-lg font-semibold">Guardar o publicar esta versión</h3>
                      <div className="mt-3 space-y-2 text-xs leading-5 text-[#AAAAB5]">
                        <p><strong className="text-[#E6E6EB]">Guardar borrador:</strong> queda en este período y solo lo ve administración. Al volver a abrirlo, estos valores aparecen automáticamente.</p>
                        <p><strong className="text-[#E6E6EB]">Publicar meta:</strong> la hace visible para cada asesor y envía la notificación correspondiente.</p>
                      </div>
                    </div>
                    <form action={saveAdvisorGoalConfigurationAction} className="grid gap-3 md:grid-cols-2">
                      <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                      <input name="billingContextPct" type="hidden" value={simulation.appliedContext.billingPct} />
                      <input name="closuresContextPct" type="hidden" value={simulation.appliedContext.closuresPct} />
                      <input name="campaignBoostPct" type="hidden" value={simulation.appliedContext.campaignBoostPct} />
                      <input name="growthChallengePct" type="hidden" value={simulation.appliedContext.growthChallengePct} />
                      <div className="hidden">
                        {simulation.scoring.metrics.map((metric) => (
                          <input key={metric.key} name={`metricWeight:${metric.key}`} type="hidden" value={metric.weightPct} />
                        ))}
                        {simulation.scoring.bands.map((band) => (
                          <div key={band.key}>
                            {band.key !== 'yuca' ? <input name={`bandMin:${band.key}`} type="hidden" value={band.minPoints} /> : null}
                            <input name={`bandCommission:${band.key}`} type="hidden" value={band.commissionPct} />
                          </div>
                        ))}
                      </div>
                      <label className="block">
                        <span className="text-[10px] uppercase tracking-[0.12em] text-[#9C9986]">Por qué cambió esta versión</span>
                        <input className="mt-1 h-10 w-full rounded-xl border border-[#3D3A27] bg-[#0E0E0B] px-3 text-sm outline-none focus:border-[#F0D000]" maxLength={500} name="reason" placeholder={storedConfig ? 'Obligatorio si modificaste algún valor' : 'Opcional en la primera versión'} />
                        <span className="mt-1 block text-[10px] text-[#817E6C]">Sirve para que administración pueda auditar cambios posteriores.</span>
                      </label>
                      <label className="block">
                        <span className="text-[10px] uppercase tracking-[0.12em] text-[#9C9986]">Mensaje opcional para el asesor</span>
                        <input className="mt-1 h-10 w-full rounded-xl border border-[#3D3A27] bg-[#0E0E0B] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={storedConfig?.publicationMessage ?? ''} maxLength={500} name="publicationMessage" placeholder="Ej.: este período impulsaremos cierres" />
                        <span className="mt-1 block text-[10px] text-[#817E6C]">Acompaña la meta publicada; no altera ningún cálculo.</span>
                      </label>
                      <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
                        <button className="h-10 rounded-xl border border-[#6A6140] px-4 text-sm font-semibold text-[#E2D99D]" name="intent" type="submit" value="draft">Guardar borrador</button>
                        <button className="h-10 rounded-xl bg-[#F0D000] px-5 text-sm font-semibold text-[#111113] hover:bg-[#FFE44F]" name="intent" type="submit" value="publish">Publicar meta</button>
                      </div>
                    </form>
                  </div>
                  {storedConfig ? <div className="mt-4"><ConfigurationHistory audit={storedConfig.audit} /></div> : null}
                </div>
              ) : (
                <div className="mt-5 space-y-3 border-t border-[#292933] pt-5">
                  <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">Este resultado ya está finalizado. La rectificación permanece disponible abajo y exige una nueva revisión completa.</div>
                  <ConfigurationHistory audit={storedConfig.audit} />
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Lectura por asesor</h2>
              <p className="mt-1 text-sm leading-6 text-[#A5A5B0]">
                {simulation.referenceLagPeriods === 1
                  ? 'La referencia usa hasta seis periodos consolidados y omite la quincena inmediatamente anterior, que se muestra solo como contexto. Luego aplica temporalidad, campaña y desafío.'
                  : 'Este periodo conserva la fórmula anterior: referencia con hasta seis periodos, incluyendo la quincena inmediatamente anterior.'} {simulation.mode === 'projection' ? '“Al cumplir” muestra el nivel y porcentaje correspondiente a alcanzar exactamente los cinco objetivos.' : ''}
              </p>
              <div className="mt-4 overflow-hidden rounded-2xl border border-[#30303A] bg-[#101014]">
                <div className="hidden grid-cols-[minmax(180px,1.35fr)_minmax(95px,0.8fr)_70px_86px_100px_minmax(145px,1fr)_82px] gap-3 border-b border-[#30303A] bg-[#15151B] px-4 py-2 text-[9px] font-semibold uppercase tracking-[0.11em] text-[#7F7F8B] xl:grid">
                  <span>Asesor</span><span>Facturación</span><span>Cierres</span><span>Cobranza</span><span>Nuevos P / A</span><span>Resultado</span><span className="text-right">Auditoría</span>
                </div>
                <div className="divide-y divide-[#30303A]">
                {simulation.advisors.map((advisor) => {
                  const displayedScore = simulation.mode === 'projection' ? advisor.targetScore : advisor.score;
                  const collectionValue = simulation.mode === 'projection' ? advisor.metrics.collection.target : advisor.metrics.collection.actual;
                  return (
                    <details className="group" key={advisor.advisorUserId}>
                      <summary className="grid cursor-pointer list-none grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-3 hover:bg-[#15151B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F0D000] [&::-webkit-details-marker]:hidden xl:grid-cols-[minmax(180px,1.35fr)_minmax(95px,0.8fr)_70px_86px_100px_minmax(145px,1fr)_82px]">
                        <div className="col-span-2 min-w-0 xl:col-span-1">
                          <div className="truncate text-sm font-semibold text-[#F0F0F3]" title={advisor.advisorName}>{advisor.advisorName}</div>
                          <div className="mt-0.5 text-[10px] text-[#858591]">{simulation.mode === 'projection' ? 'Meta proyectada' : 'Avance observado'}</div>
                        </div>
                        <CompactAdvisorValue label="Facturación" value={money(advisor.metrics.billing.target)} />
                        <CompactAdvisorValue label="Cierres" value={numberLabel(advisor.metrics.closures.target, 0)} />
                        <CompactAdvisorValue label="Cobranza" value={percent(collectionValue, 0)} />
                        <CompactAdvisorValue label="Nuevos P / A" value={`${numberLabel(advisor.metrics.newOwnClients.target, 0)} / ${numberLabel(advisor.metrics.newAssignedClients.target, 0)}`} />
                        <div className="min-w-0">
                          <div className="text-[9px] font-semibold uppercase tracking-[0.11em] text-[#767681] xl:hidden">Resultado</div>
                          {displayedScore ? (
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold text-[#DADAE0]">{numberLabel(displayedScore.points, 1)} pts · {displayedScore.band.label}</span>
                              <span className="rounded-full bg-[#F0D000]/10 px-2 py-0.5 text-xs font-bold text-[#F7DA66]">{displayedScore.calculatedCommissionPct}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-amber-200">Referencia requerida</span>
                          )}
                        </div>
                        <div className="col-span-2 flex items-center justify-end gap-1 text-[11px] font-semibold text-[#BDBDC6] xl:col-span-1">
                          <span>Ver detalle</span><span className="transition-transform group-open:rotate-180">⌄</span>
                        </div>
                      </summary>
                      <div className="border-t border-[#2A2A33] bg-[#0D0D11] px-4 py-4">
                        <p className="text-xs text-[#9595A1]">Facturación y cierres incluyen entregados; obsequios puros no cuentan.</p>
                        {advisor.warning ? <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">{advisor.warning}</div> : null}
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          <MetricCard label="Facturación" metric={advisor.metrics.billing} moneyValues points={metricPoints(displayedScore, 'billing')} projection={simulation.mode === 'projection'} />
                          <MetricCard label="Cierres" metric={advisor.metrics.closures} points={metricPoints(displayedScore, 'closures')} projection={simulation.mode === 'projection'} />
                          <MetricCard label="Cobranza" metric={advisor.metrics.collection} points={metricPoints(displayedScore, 'collection')} projection={simulation.mode === 'projection'} ratio rule="collection" />
                          <MetricCard label="Nuevos propios" metric={advisor.metrics.newOwnClients} points={metricPoints(displayedScore, 'new_own_clients')} projection={simulation.mode === 'projection'} rule="new-client" />
                          <MetricCard label="Nuevos asignados" metric={advisor.metrics.newAssignedClients} points={metricPoints(displayedScore, 'new_assigned_clients')} projection={simulation.mode === 'projection'} rule="new-client" />
                        </div>
                        {simulation.mode === 'active' ? <div className="mt-3 space-y-2">
                          <div className="grid grid-cols-3 gap-2 text-center text-xs">
                            <div className="rounded-xl bg-[#15151B] p-2.5"><div className="text-emerald-300">100%</div><div className="mt-1 text-[#A0A0AB]">{advisor.collection.punctualCount} puntuales</div></div>
                            <div className="rounded-xl bg-[#15151B] p-2.5"><div className="text-[#F7DA66]">80%</div><div className="mt-1 text-[#A0A0AB]">{advisor.collection.creditCount} con crédito</div></div>
                            <div className="rounded-xl bg-[#15151B] p-2.5"><div className="text-red-300">0%</div><div className="mt-1 text-[#A0A0AB]">{advisor.collection.overdueCount} atrasados</div></div>
                          </div>
                          <AdvisorGoalCollectionBreakdown
                            defaultOpen
                            points={metricPoints(advisor.score, 'collection')?.points}
                            summary={advisor.collection}
                          />
                        </div> : (
                          <div className="mt-3 rounded-2xl border border-sky-400/20 bg-sky-400/5 px-4 py-3 text-xs leading-5 text-sky-100">
                            La cobranza comenzará a medirse cuando existan pedidos entregados: puntual 100%, crédito de hasta cinco días 80% y atraso 0%.
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
                </div>
              </div>
            </section>

            {storedConfig && (storedConfig.status === 'published' || storedConfig.status === 'closed') ? (
              <section className="rounded-3xl border border-emerald-500/25 bg-[#0E1814] p-5">
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">{storedConfig.status === 'closed' ? 'Rectificar resultado final' : 'Finalizar resultado y porcentaje'}</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A8B9B1]">Al finalizar, el porcentaje calculado de cada asesor pasa a su liquidación. Puedes sustituir uno de forma excepcional; si difiere, su motivo es obligatorio y queda en el historial.</p>
                </div>
                <form action={finalizeAdvisorGoalResultsAction} className="mt-4 space-y-3">
                  <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                    {simulation.advisors.map((advisor) => {
                      const storedGoal = storedGoalByAdvisorId.get(advisor.advisorUserId);
                      const calculatedPct = advisor.score?.calculatedCommissionPct ?? 0;
                      return (
                        <article className="rounded-2xl border border-[#294037] bg-[#0B1210] p-3" key={advisor.advisorUserId}>
                          <div className="truncate text-sm font-semibold" title={advisor.advisorName}>{advisor.advisorName}</div>
                          <div className="mt-1 text-[11px] text-[#8FA49A]">Calculado: {calculatedPct.toFixed(2)}%</div>
                          <label className="mt-3 block">
                            <span className="text-[10px] uppercase tracking-[0.12em] text-[#82968D]">Porcentaje aplicado</span>
                            <div className="relative mt-1">
                              <input className="h-9 w-full rounded-xl border border-[#30483E] bg-[#08100D] px-3 pr-7 text-sm font-semibold outline-none focus:border-emerald-400" defaultValue={storedGoal?.appliedCommissionPct ?? calculatedPct} max="100" min="0" name={`commissionPct:${advisor.advisorUserId}`} required step="0.01" type="number" />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#789087]">%</span>
                            </div>
                          </label>
                          <label className="mt-2 block">
                            <span className="text-[10px] uppercase tracking-[0.12em] text-[#82968D]">Motivo si cambia</span>
                            <input className="mt-1 h-9 w-full rounded-xl border border-[#30483E] bg-[#08100D] px-3 text-xs outline-none focus:border-emerald-400" defaultValue={storedGoal?.rateOverrideReason ?? ''} maxLength={500} name={`overrideReason:${advisor.advisorUserId}`} placeholder="Solo si sustituye" />
                          </label>
                        </article>
                      );
                    })}
                  </div>
                  <div className="flex flex-col gap-3 border-t border-[#294037] pt-3 md:flex-row md:items-end md:justify-between">
                    <label className="block w-full md:max-w-2xl">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[#82968D]">Nota de finalización o rectificación</span>
                      <input className="mt-1 h-10 w-full rounded-xl border border-[#30483E] bg-[#08100D] px-3 text-sm outline-none focus:border-emerald-400" maxLength={500} name="finalizationReason" placeholder={storedConfig.status === 'closed' ? 'Obligatoria para explicar la nueva revisión' : 'Opcional en el primer cierre'} required={storedConfig.status === 'closed'} />
                    </label>
                    <button className="h-10 shrink-0 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-[#07110D] hover:bg-emerald-300" disabled={simulation.advisors.some((advisor) => advisor.score == null)} type="submit">
                      {storedConfig.status === 'closed' ? 'Rectificar y recalcular' : 'Finalizar y aplicar'}
                    </button>
                  </div>
                </form>
              </section>
            ) : null}

            <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5 text-sm text-[#A8A8B3]">
              La base vigente distribuye {numberLabel(simulation.scoring.metrics.reduce((sum, metric) => sum + metric.basePoints, 0), 0)} puntos: {simulation.scoring.metrics.map((metric) => `${numberLabel(metric.basePoints, 1)} ${metric.label.toLocaleLowerCase('es')}`).join(', ')}. Simular no cambia datos; solo “Finalizar y aplicar” actualiza los porcentajes de las liquidaciones.
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
