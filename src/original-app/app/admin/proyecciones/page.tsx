import Link from '@/components/navigation/ContextLink';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminExecutiveKpiDomain } from '@/lib/admin-finance/executive-data';
import { parseProjectionOptions } from '@/lib/admin-finance/executive-model';
import { addDateKeyDays } from '@/lib/admin-finance/period';
import ExecutiveTrendChart from '../_components/ExecutiveTrendChart';

const currency = new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD' });
const number = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 1 });
const field = 'min-h-11 rounded-lg border border-[#343442] bg-[#17171F] px-3 text-xs text-white';

export default async function ProjectionsPage({ searchParams }: {
  searchParams: Promise<{ weeks?: string; growth?: string; calculate?: string }>;
}) {
  const ctx = await requireAdminContext();
  const params = await searchParams;
  const options = parseProjectionOptions(params.weeks, params.growth);
  // Opening this center performs no historical consultation. Only the submitted
  // GET form starts its bounded read; it never publishes goals or writes data.
  const executive = params.calculate === '1' ? await loadAdminExecutiveKpiDomain({
    supabase: ctx.supabase as unknown as SupabaseClient,
    ...options, includeFinancialStates: false,
  }) : null;
  const data = executive?.status === 'ready' ? executive.data : null;
  const projection = data?.operational;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-white">Proyecciones</h1>
        <Link href="/app/commissions/goals" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#CFCFD7] underline">Metas de asesores →</Link>
      </header>
      <form action="/app/admin/proyecciones" method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-[#292937] bg-[#111117] p-3">
        <input type="hidden" name="calculate" value="1" />
        <label className="grid gap-1 text-xs text-[#BDBDC7]">Semanas anteriores
          <select name="weeks" defaultValue={String(options.historyWeeks)} className={field}>
            {[1, 2, 3, 4].map((weeks) => <option key={weeks} value={weeks}>{weeks} completas</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[#BDBDC7]">Crecimiento esperado (%)
          <input type="number" name="growth" min="0" max="100" step="0.1" defaultValue={options.growthPct} required className={`${field} w-36`} />
        </label>
        <button type="submit" className="min-h-11 rounded-lg bg-[#FFFF00] px-4 text-xs font-semibold text-black">Calcular referencia</button>
        <p className="basis-full text-[11px] text-[#9B9BA7]">Promedio semanal × (1 + crecimiento). Escenario del negocio; no modifica las metas de asesores.</p>
      </form>
      {!executive ? <p className="text-xs text-[#9B9BA7]">Elige la base y calcula cuando necesites consultarla.</p> : null}
      {executive?.status === 'error' ? <p role="alert" className="text-xs text-orange-200">{executive.message}</p> : null}
      {data && projection ? <>
        <section className="rounded-xl border border-[#292937] bg-[#111117] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">Semana {data.weekStartKey} — {addDateKeyDays(data.weekStartKey, 6)}</h2>
            <span className="text-[11px] text-[#9B9BA7]">Referencia estimada · +{number.format(projection.growthPct)}%</span>
          </div>
          <table className="w-full text-right text-xs tabular-nums [&_td]:py-2 [&_th]:py-2">
            <thead className="text-[10px] text-[#9B9BA7]"><tr><th scope="col" className="text-left">Indicador</th><th scope="col">Promedio</th><th scope="col">Referencia</th><th scope="col">Registrado*</th></tr></thead>
            <tbody className="divide-y divide-[#272734] text-[#D8D8DF]">
              <tr><th scope="row" className="text-left font-medium">Fact. neta</th><td>{currency.format(projection.history.reduce((sum, week) => sum + week.commercialNetUsd, 0) / projection.historyWeeks)}</td><td className="font-semibold text-[#FFFF00]">{currency.format(projection.weeklyReferenceUsd)}</td><td>{currency.format(projection.week.commercialNetUsd)}</td></tr>
              <tr><th scope="row" className="text-left font-medium">Cierres</th><td>{number.format(projection.history.reduce((sum, week) => sum + week.closures, 0) / projection.historyWeeks)}</td><td className="font-semibold text-[#FFFF00]">{number.format(projection.weeklyReferenceClosures)}</td><td>{projection.week.closures}</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-[#9B9BA7]">*Incluye órdenes ya registradas para próximos días de esta semana. No es una proyección de utilidad ni de dinero cobrado.</p>
        </section>
        <div className="grid gap-3 lg:grid-cols-2">
          <ExecutiveTrendChart points={projection.trend} todayKey={data.todayKey} historyWeeks={projection.historyWeeks} growthPct={projection.growthPct} />
          <ExecutiveTrendChart points={projection.trend} todayKey={data.todayKey} historyWeeks={projection.historyWeeks} growthPct={projection.growthPct} metric="closures" />
        </div>
        <details className="rounded-xl border border-[#292937] bg-[#111117] px-3">
          <summary className="min-h-11 cursor-pointer content-center text-xs text-white">Ver semanas usadas en el promedio</summary>
          <table className="mb-3 w-full text-right text-xs tabular-nums [&_td]:py-2 [&_th]:py-2">
            <thead className="text-[#9B9BA7]"><tr><th scope="col" className="text-left">Semana</th><th scope="col">Fact. neta</th><th scope="col">Cierres</th></tr></thead>
            <tbody className="text-[#D8D8DF]">{projection.history.map((week) => <tr key={week.startKey}><th scope="row" className="text-left font-medium">{week.startKey} — {addDateKeyDays(week.endExclusiveKey, -1)}</th><td>{currency.format(week.commercialNetUsd)}</td><td>{week.closures}</td></tr>)}</tbody>
          </table>
          <p className="mb-3 text-[10px] text-[#9B9BA7]">Las semanas sin órdenes cuentan como cero. Base operativa actual por fecha programada; no es un cierre histórico certificado.</p>
        </details>
      </> : null}
    </div>
  );
}
