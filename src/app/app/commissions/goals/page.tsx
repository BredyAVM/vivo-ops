import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { ADVISOR_GOAL_METRICS } from '@/lib/commissions/goal-engine';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import type { AdvisorGoalSimulatedMetric } from '@/lib/commissions/goal-simulation';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
} from '@/lib/commissions/goal-snapshot';
import {
  finalizeAdvisorGoalResultsAction,
  saveAdvisorGoalConfigurationAction,
} from './actions';
import { AdvisorGoalCollectionBreakdown } from '../AdvisorGoalCollectionBreakdown';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Promise<{
  period?: string;
  billingContext?: string;
  closuresContext?: string;
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
  const parsed = Number(value.replace(',', '.'));
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

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00-04:00`);
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function metricPoints(
  score: { metrics: Array<{ key: string; points: number; basePoints: number }> } | null,
  key: string
) {
  return score?.metrics.find((metric) => metric.key === key) ?? null;
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
}: {
  label: string;
  metric: AdvisorGoalSimulatedMetric;
  points: { points: number; basePoints: number } | null;
  moneyValues?: boolean;
  ratio?: boolean;
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
          <div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#F7F7F8]">{value(metric.actual)}</div>
          <div className="mt-0.5 text-[11px] text-[#92929E]">Resultado observado</div>
        </div>
        {points ? (
          <div className="rounded-full border border-[#F0D000]/30 bg-[#F0D000]/10 px-2.5 py-1 text-xs font-semibold text-[#F7DA66]">
            {numberLabel(points.points, 1)} / {numberLabel(points.basePoints, 0)} pts
          </div>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-[#101014] p-2.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">Referencia</div>
          <div className="mt-1 font-semibold text-[#E9E9ED]">{value(metric.reference)}</div>
        </div>
        <div className="rounded-xl bg-[#101014] p-2.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#80808D]">Meta</div>
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
    .limit(40);
  if (periodsResult.error) throw new Error(periodsResult.error.message);
  const periods = (periodsResult.data ?? []) as PeriodRow[];
  const requestedPeriodId = Number(params.period ?? 0);
  const selectedPeriod = periods.find((period) => Number(period.id) === requestedPeriodId) ?? periods[0] ?? null;
  const storedConfig = readAdvisorGoalPeriodConfig(selectedPeriod?.goal_config);
  const context = {
    growthChallengePct: numberParam(params.growth) ?? storedConfig?.growthChallengePct,
    billingContextPct: numberParam(params.billingContext) ?? storedConfig?.billing.appliedPct,
    closuresContextPct: numberParam(params.closuresContext) ?? storedConfig?.closures.appliedPct,
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
            <p className="mt-1 text-sm text-[#A9A9B4]">Capacidad personal, temporalidad, desafío y resultado sin fórmulas ocultas.</p>
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
        <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Periodos">
          {periods.map((period) => {
            const active = Number(period.id) === Number(selectedPeriod?.id);
            return (
              <Link key={period.id} className={active ? 'shrink-0 rounded-full border border-[#F0D000] bg-[#F0D000] px-3 py-2 text-xs font-semibold text-[#111113]' : 'shrink-0 rounded-full border border-[#30303A] bg-[#18181E] px-3 py-2 text-xs font-semibold text-[#B7B7C1] hover:border-[#6A6140] hover:text-[#F7DA66]'} href={`/app/commissions/goals?period=${period.id}`}>
                {period.name}
              </Link>
            );
          })}
        </nav>

        {selectedPeriod ? (
          <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold">{selectedPeriod.name}</div>
                  <span className="rounded-full border border-[#373742] bg-[#18181F] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C4C4CC]">
                    {storedConfig ? `${storedConfig.status === 'published' ? 'Publicada' : 'Borrador'} · revisión ${storedConfig.revision}` : 'Sin guardar'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[#9696A2]">Del {dateLabel(selectedPeriod.date_from)} al {dateLabel(selectedPeriod.date_to)} · corte de cobranza {simulation ? dateLabel(simulation.cutoffDate) : 'por calcular'}</div>
              </div>
              <form className="grid gap-2 sm:grid-cols-4" method="get">
                <input name="period" type="hidden" value={selectedPeriod.id} />
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-[#898995]">Contexto facturación</span>
                  <input className="mt-1 h-9 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={simulation?.appliedContext.billingPct ?? 0} name="billingContext" step="0.01" type="number" />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-[#898995]">Contexto cierres</span>
                  <input className="mt-1 h-9 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={simulation?.appliedContext.closuresPct ?? 0} name="closuresContext" step="0.01" type="number" />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-[#898995]">Desafío</span>
                  <input className="mt-1 h-9 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={simulation?.appliedContext.growthChallengePct ?? 10} min="0" name="growth" step="0.01" type="number" />
                </label>
                <button className="h-9 self-end rounded-xl bg-[#F0D000] px-4 text-sm font-semibold text-[#111113] hover:bg-[#FFE44F]" type="submit">Simular</button>
              </form>
            </div>
          </section>
        ) : null}

        {simulationError ? (
          <section className="rounded-3xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-100">{simulationError}</section>
        ) : null}

        {simulation ? (
          <>
            <section className="grid gap-3 lg:grid-cols-2">
              {([
                ['Facturación', simulation.seasonality.billing, simulation.appliedContext.billingPct],
                ['Cierres', simulation.seasonality.closures, simulation.appliedContext.closuresPct],
              ] as const).map(([label, seasonal, applied]) => (
                <article className="rounded-3xl border border-[#292933] bg-[#121217] p-5" key={label}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Temporalidad histórica · {label}</div>
                      <div className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[#F7F7F8]">{contextPercent(seasonal.suggestedPct)}</div>
                      <p className="mt-1 text-xs leading-5 text-[#9D9DA8]">Mediana del cambio desde la quincena inmediatamente anterior hacia esta misma quincena en años anteriores.</p>
                    </div>
                    <span className="rounded-full border border-[#34343F] bg-[#18181F] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C4C4CC]">Confianza {seasonal.confidence}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-xl bg-[#101014] p-3"><div className="text-[#858591]">Rango habitual</div><div className="mt-1 font-semibold">{contextPercent(seasonal.typicalLowPct)} a {contextPercent(seasonal.typicalHighPct)}</div></div>
                    <div className="rounded-xl bg-[#101014] p-3"><div className="text-[#858591]">Muestras</div><div className="mt-1 font-semibold">{seasonal.sampleCount} · {seasonal.yearCount} años</div></div>
                    <div className="rounded-xl bg-[#101014] p-3"><div className="text-[#858591]">Aplicado ahora</div><div className="mt-1 font-semibold text-[#F7DA66]">{contextPercent(applied)}</div></div>
                  </div>
                </article>
              ))}
            </section>

            {storedConfig?.status !== 'closed' ? (
            <section className="rounded-3xl border border-[#F0D000]/25 bg-[#15140C] p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-2xl">
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">Guardar esta propuesta</h2>
                  <p className="mt-1 text-sm leading-6 text-[#B5B29D]">Guardar crea una revisión administrativa. Publicar deja disponible la meta para el asesor. Si cambia una propuesta ya guardada, el motivo es obligatorio.</p>
                </div>
                <form action={saveAdvisorGoalConfigurationAction} className="grid w-full gap-3 lg:max-w-2xl lg:grid-cols-[1fr_1fr_auto]">
                  <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                  <input name="billingContextPct" type="hidden" value={simulation.appliedContext.billingPct} />
                  <input name="closuresContextPct" type="hidden" value={simulation.appliedContext.closuresPct} />
                  <input name="growthChallengePct" type="hidden" value={simulation.appliedContext.growthChallengePct} />
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#9C9986]">Motivo del ajuste</span>
                    <input className="mt-1 h-10 w-full rounded-xl border border-[#3D3A27] bg-[#0E0E0B] px-3 text-sm outline-none focus:border-[#F0D000]" maxLength={500} name="reason" placeholder={storedConfig ? 'Obligatorio si cambió algún valor' : 'Opcional en la primera versión'} />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#9C9986]">Mensaje al asesor</span>
                    <input className="mt-1 h-10 w-full rounded-xl border border-[#3D3A27] bg-[#0E0E0B] px-3 text-sm outline-none focus:border-[#F0D000]" defaultValue={storedConfig?.publicationMessage ?? ''} maxLength={500} name="publicationMessage" placeholder="Qué se busca impulsar en el periodo" />
                  </label>
                  <div className="flex items-end gap-2">
                    <button className="h-10 rounded-xl border border-[#6A6140] px-4 text-sm font-semibold text-[#E2D99D]" name="intent" type="submit" value="draft">Guardar</button>
                    <button className="h-10 rounded-xl bg-[#F0D000] px-4 text-sm font-semibold text-[#111113] hover:bg-[#FFE44F]" name="intent" type="submit" value="publish">Publicar</button>
                  </div>
                </form>
              </div>
            </section>
            ) : (
              <section className="rounded-3xl border border-emerald-500/25 bg-emerald-500/10 p-5 text-sm text-emerald-100">
                Este resultado ya está finalizado. La rectificación permanece disponible abajo y exige una nueva revisión completa.
              </section>
            )}

            <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Lectura por asesor</h2>
              <p className="mt-1 text-sm text-[#A5A5B0]">Referencia = el mayor valor entre la mediana de seis periodos y la mediana de los últimos tres. El contexto y el desafío se muestran por separado.</p>
              <div className="mt-5 space-y-5">
                {simulation.advisors.map((advisor) => (
                  <article className="rounded-3xl border border-[#30303A] bg-[#101014] p-4 md:p-5" key={advisor.advisorUserId}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold">{advisor.advisorName}</h3>
                        <p className="mt-1 text-xs text-[#9595A1]">Facturación y cierres incluyen entregados; obsequios puros no cuentan.</p>
                      </div>
                      {advisor.score ? (
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-[#3B3B46] bg-[#18181F] px-3 py-1.5 text-xs font-semibold text-[#D5D5DC]">{numberLabel(advisor.score.points, 1)} pts · {advisor.score.band.label}</span>
                          <span className="rounded-full border border-[#F0D000]/40 bg-[#F0D000]/10 px-3 py-1.5 text-sm font-bold text-[#F7DA66]">{advisor.score.calculatedCommissionPct}%</span>
                        </div>
                      ) : (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100">Referencia manual requerida</span>
                      )}
                    </div>
                    {advisor.warning ? <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">{advisor.warning}</div> : null}
                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      <MetricCard label="Facturación" metric={advisor.metrics.billing} moneyValues points={metricPoints(advisor.score, 'billing')} />
                      <MetricCard label="Cierres" metric={advisor.metrics.closures} points={metricPoints(advisor.score, 'closures')} />
                      <MetricCard label="Cobranza" metric={advisor.metrics.collection} points={metricPoints(advisor.score, 'collection')} ratio />
                      <MetricCard label="Nuevos propios" metric={advisor.metrics.newOwnClients} points={metricPoints(advisor.score, 'new_own_clients')} />
                      <MetricCard label="Nuevos asignados" metric={advisor.metrics.newAssignedClients} points={metricPoints(advisor.score, 'new_assigned_clients')} />
                    </div>
                    <div className="mt-3 space-y-2">
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
                    </div>
                  </article>
                ))}
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
              Los {ADVISOR_GOAL_METRICS.reduce((sum, metric) => sum + metric.basePoints, 0)} puntos base se reparten en 100 facturación, 40 cierres, 20 cobranza, 30 clientes propios y 10 asignados. Simular no cambia datos; solo “Finalizar y aplicar” actualiza los porcentajes de las liquidaciones.
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
