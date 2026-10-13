import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { UUID_PATTERN } from '@/lib/rewards/wallet-model';
import { AWARD_LABELS, EVALUATED_CATEGORIES, awardValue, evaluateAwards, type EvaluationInput, type EvaluatedCategory } from '@/lib/rewards/evaluation-model';

const box = 'rounded-lg border border-[#292937] bg-[#111117] p-3';
const score = (n: number) => n.toFixed(2);
const descriptions = {
  alchemist: 'Asignados y clientes de origen empresarial activados por asesor. Mes elegido y dos meses previos. Solo compras por ese asesor; la incorporación no cuenta como recompra.',
  influential: 'Clientes propios, excluyendo origen empresarial. Mes elegido y dos meses previos. Solo compras por el asesor de incorporación.',
  strategic: 'Misma cartera madura al iniciar el mes: primera compra anterior a los tres meses previos. Comparación con el mes anterior y ajuste mensual de temporada. Propietario reconstruido por última compra previa con asesor activo.',
};
export default async function AwardEvaluationPage({ searchParams }: { searchParams?: Promise<{ month?: string; evaluate?: string; advisor?: string; category?: string; page?: string }> }) {
  const ctx = await requireAdminContext();
  const params = await searchParams ?? {};
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const today = todayParts.find(p => p.type === 'year')!.value + '-' + todayParts.find(p => p.type === 'month')!.value;
  const lastMonth = new Date(today + '-01T12:00:00-04:00');
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const period = params.month ?? lastMonth.toISOString().slice(0, 7);
  const validPeriod = /^202[6-9]-(0[1-9]|1[0-2])$/.test(period) && period <= today;
  const advisorId = UUID_PATTERN.test(params.advisor ?? '') ? params.advisor! : null;
  const category = EVALUATED_CATEGORIES.includes(params.category as EvaluatedCategory) ? params.category as EvaluatedCategory : null;
  const page = /^\d{1,4}$/.test(params.page ?? '') ? Math.max(0, Number(params.page) - 1) : 0;
  const href = (advisor?: string, key?: EvaluatedCategory, nextPage = 0) => '/app/admin/evaluacion?' + new URLSearchParams({ month: period, evaluate: '1', ...(advisor && key ? { advisor, category: key, page: String(nextPage + 1) } : {}) });
  let input: EvaluationInput | null = null;
  let result: ReturnType<typeof evaluateAwards> | null = null;
  let failed = false;
  if (params.evaluate === '1' && validPeriod) {
    const { data, error } = await ctx.supabase.rpc('admin_award_evaluation_preview_v1', { p_month: period + '-01', p_advisor: advisorId && category ? advisorId : null, p_category: advisorId && category ? category : null, p_offset: page * 50 });
    try {
      if (error || !data) throw new Error('Evaluation unavailable');
      input = data as EvaluationInput;
      result = evaluateAwards(input);
    } catch {
      console.error('Award evaluation unavailable', error?.code ?? 'invalid_payload');
      failed = true;
    }
  }
  const selected = result?.advisors.find(a => a.id === advisorId);
  const selectedMetrics = input && selected && category ? category === 'strategic'
    ? input.strategic_metrics.find(r => r.advisor_id === selected.id)
    : input.cohort_metrics.find(r => r.advisor_id === selected.id && r.category === category) : null;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-lg font-semibold">Evaluación de asesores</h1><p className="text-xs text-[#AAB2C5]">Cómo se obtienen los puntos, quién clasifica y qué puede mejorar.</p></div><Link prefetch={false} className="text-xs text-yellow-200" href={'/app/admin/premios?month=' + (validPeriod ? period : today)}>Entrega de premios →</Link></header>
    <p className={box + ' text-xs leading-5 text-amber-100'}>Vista previa administrativa, no premiación oficial. Se recalcula al consultar; no emite crédito ni modifica clientes, órdenes o comisiones. El cierre mensual y la publicación para asesores todavía no están habilitados.</p>
    <form className="flex flex-wrap items-end gap-2"><input type="hidden" name="evaluate" value="1" /><label className="text-xs">Mes a evaluar<input className="ml-2 min-h-10 rounded-lg border border-[#303040] bg-[#0B0B10] px-3" type="month" name="month" min="2026-01" max={today} defaultValue={validPeriod ? period : today} /></label><button className="min-h-10 rounded-lg bg-yellow-300 px-4 text-xs font-semibold text-black">Evaluar / actualizar</button></form>
    {!validPeriod ? <p role="alert">Selecciona un mes de 2026 en adelante, no posterior al mes actual.</p> : null}
    {period === today ? <p className="text-xs text-amber-200">Mes en curso: resultados parciales, todavía no comparables con un cierre mensual.</p> : null}
    {failed ? <p role="alert" className={box}>No se pudo calcular la evaluación. Vuelve a consultar. No se presentan ceros ni ganadores con datos incompletos.</p> : null}
    {result && input ? <>
      <section className={box + ' space-y-2 text-xs'}>
        <h2 className="text-sm font-semibold">Asesor del Mes · simulación parcial</h2>
        <p className="text-yellow-200">{result.leaders.length ? (result.leaders.length > 1 ? 'Empate: ' : 'Lidera la simulación: ') + result.leaders.map(a => a.name).join(' · ') : 'Nadie cumple los mínimos de esta simulación.'}</p>
        <p>Pesos originales: Alquimista 20%, Influyente 25%, Estratégico 30%, Ejecutor 25%. Se redistribuyen entre las categorías evaluables para todos, nunca por el bajo puntaje de una persona.</p>
        <p>Para esta simulación: al menos una categoría clasificada y 80 puntos globales. El mínimo global de 80 sigue provisional; los empates no se resuelven arbitrariamente.</p>
        <p>Ejecutor: {period === '2026-09' ? 'septiembre sin premio por fallas de registro.' : 'pendiente de referencias de entrega por campaña y validación del registro.'} No aporta cero puntos: queda fuera para todos.</p>
        <p>Pesos efectivos: {result.seasonalReliable ? 'Alquimista 26,67% · Influyente 33,33% · Estratégico 40%.' : 'Alquimista 44,44% · Influyente 55,56%; Estratégico también fuera por referencia insuficiente.'}</p>
      </section>
      <div className="overflow-x-auto rounded-lg border border-[#292937]"><table className="w-full whitespace-nowrap text-left text-xs"><caption className="p-2 text-left">Ranking · primero los que cumplen los mínimos globales provisionales</caption><thead className="bg-[#17171F]"><tr><th className="p-2">Asesor</th>{EVALUATED_CATEGORIES.map(k => <th className="p-2" key={k}>{AWARD_LABELS[k]}</th>)}<th className="p-2">Global</th><th className="p-2">Clasificación</th></tr></thead><tbody>{result.advisors.map(a => <tr key={a.id} className="border-t border-[#292937]"><th className="p-2 font-normal">{a.name}</th>{EVALUATED_CATEGORIES.map(k => <td className="p-2" key={k}><Link prefetch={false} className={a.categories[k].qualified ? 'text-emerald-300 underline' : 'text-[#AAB2C5] underline'} href={href(a.id, k)}>{a.categories[k].available ? score(a.categories[k].score) : 'No evaluable'}{a.categories[k].qualified ? ' ✓' : ''}<span className="sr-only"> · Ver indicadores de {a.name} en {AWARD_LABELS[k]}</span></Link></td>)}<td className="p-2">{score(a.total)}</td><td className="p-2">{a.qualified ? 'Clasifica en simulación' : 'No clasifica'} · {a.qualifiedCategories} categorías</td></tr>)}</tbody></table></div>
      <section className="grid gap-2 md:grid-cols-3">{EVALUATED_CATEGORIES.map(k => {
        const eligible = result.advisors.filter(a => a.categories[k].qualified);
        const best = Math.max(...eligible.map(a => a.categories[k].score));
        return <div key={k} className={box + ' text-xs space-y-1'}><h2 className="font-semibold">{AWARD_LABELS[k]}</h2><p>{eligible.length ? 'Lidera: ' + eligible.filter(a => a.categories[k].score === best).map(a => a.name).join(' · ') : result.advisors.some(a => a.categories[k].available) ? 'Sin clasificados.' : 'No evaluable.'}</p><p className="text-[#AAB2C5]">{descriptions[k]}</p></div>;
      })}</section>
      {selected && category ? <section className={box + ' space-y-3'}>
        <h2 className="text-sm font-semibold">{selected.name} · {AWARD_LABELS[category]}</h2>
        {selectedMetrics ? <p className="text-xs text-[#AAB2C5]">{category === 'strategic'
          ? `Cartera madura: ${selectedMetrics.mature_portfolio} · Activos previos: ${selectedMetrics.prior_active} · Activos actuales: ${selectedMetrics.current_active} · Recuperables: ${selectedMetrics.dormant_60_180} · Reactivados: ${selectedMetrics.reactivated_60_180}.`
          : `Nuevos este mes: ${selectedMetrics.incorporation} · Base de los dos meses previos: ${selectedMetrics.older_pool} · Volvieron: ${selectedMetrics.older_returned} · Nuevas asignaciones empresariales inferidas: ${selectedMetrics.inferred_new}.`}</p> : null}
        <p className="text-xs">{selected.categories[category].qualified ? 'Cumple todos los mínimos.' : selected.categories[category].failures.join(' ')} Se decide con el puntaje sin redondear.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Indicador</th><th className="p-2">Resultado</th><th className="p-2">Meta completa</th><th className="p-2">Puntos</th></tr></thead><tbody>{selected.categories[category].indicators.map(i => <tr key={i.label} className="border-t border-[#292937]"><th className="p-2 font-normal">{i.label}</th><td className="p-2">{awardValue(i.result, i.unit)}</td><td className="p-2">{awardValue(i.target, i.unit)}</td><td className="p-2">{score(i.points)} / {i.weight}</td></tr>)}</tbody></table></div>
        <details><summary className="cursor-pointer text-xs text-yellow-200">Cómo se calcula y cómo mejorar</summary><div className="mt-2 space-y-2 text-xs"><p>Cada indicador aporta su peso × resultado/meta, con tope en su peso. Cumplir una meta no reemplaza los mínimos obligatorios.</p><p>{category === 'strategic' ? 'Mínimos: 80 puntos; 10 activos previos, 10 actuales y 10 recuperables; activos o cierres al menos 5% sobre el esperado estacional; facturación al menos 90% del esperado.' : 'Mínimos: 80 puntos; retorno de 10%; al menos ' + (category === 'alchemist' ? 10 : 5) + ' clientes incorporados en los dos meses previos. Retorno = los que compraron este mes / esa base anterior. Regularidad = promedio por cliente de los meses posteriores a incorporación con compra, excluyendo cohorte actual.'}</p>{selected.categories[category].indicators.map(i => <p key={i.label}><span className="font-semibold">{i.label}{i.points < i.weight ? ' · Por desarrollar' : ' · Meta completa'}: </span>{i.guidance}</p>)}</div></details>
        <h3 className="text-xs font-semibold">Clientes que sustentan la evaluación · {input.evidence_total}</h3>
        <p className="text-xs text-[#AAB2C5]">50 por página. Compras entregadas y hechos históricos válidos, positivos, atribuidos al asesor. Otros canales o asesores no suman a sus números.</p>
        {input.evidence.map(c => <details key={c.client_id} className="border-t border-[#292937] pt-2 text-xs"><summary className="cursor-pointer">{c.client_name} · #{c.client_id} · {category === 'strategic' ? `${c.metrics.current_orders} compras actuales / ${c.metrics.prior_orders} previas` : `${c.metrics.period_orders} compras · ${c.metrics.period_repeat_orders} recompras`}</summary><div className="mt-2 space-y-1 text-[#AAB2C5]"><p>{category === 'strategic' ? `Última compra antes del mes: ${c.metrics.last_purchase_on}. Días distintos de compra actual: ${c.metrics.current_buy_days}.` : `Incorporación: ${c.metrics.first_purchase_on} · ${c.metrics.origin === 'company_to_advisor_inferred' ? 'Asignación empresarial inferida' : c.metrics.origin === 'own' ? 'Propio' : 'Asignado directo'}. Compras del mes anterior: ${c.metrics.previous_month_orders}.`}</p><p>Facturación actual: {awardValue(Number(c.metrics.period_revenue ?? c.metrics.current_revenue), 'usd')}</p>{c.orders.slice(0,20).map(o => <p key={o.fact_origin + ':' + o.source_record_id}>{o.fact_origin === 'live' ? 'Orden' : 'Histórico'} #{o.source_control} · {o.purchased_on} · {awardValue(Number(o.net_total_usd), 'usd')}</p>)}{c.orders.length > 20 ? <p>Se muestran las primeras 20 compras de esta ventana; los indicadores incluyen todas.</p> : null}</div></details>)}
        {!input.evidence_total ? <p className="text-xs">No hay clientes en esta cohorte.</p> : null}
        <nav aria-label="Páginas de evidencia" className="flex gap-4 text-xs text-yellow-200">{page > 0 ? <Link prefetch={false} href={href(selected.id, category, page - 1)}>Anterior</Link> : null}{(page + 1) * 50 < input.evidence_total ? <Link prefetch={false} href={href(selected.id, category, page + 1)}>Siguiente</Link> : null}</nav>
      </section> : <p className="text-xs text-[#AAB2C5]">Toca el puntaje de un asesor para ver sus indicadores, mínimos, recomendaciones y clientes.</p>}
      <details className={box + ' text-xs'}><summary className="cursor-pointer">Origen, temporada y límites de la lectura</summary><div className="mt-2 space-y-2"><p>Referencia de metas reutilizada con muestras mensuales: mediana de variaciones equivalentes de años anteriores. Activos {result.seasons.active.suggestedPct}%; cierres {result.seasons.orders.suggestedPct}%; facturación {result.seasons.revenue.suggestedPct}%. {result.seasons.active.sampleCount} muestras / {result.seasons.active.yearCount} años. Confianza {result.seasons.active.confidence === 'high' ? 'alta' : result.seasons.active.confidence === 'medium' ? 'media' : 'baja'}.</p><p>Asesores activos que reciben comisiones hoy; no es una certificación de quién estaba activo históricamente. Tipo propio/asignado actual y dueño de cartera reconstruido: no hay registro completo de adjudicaciones pasadas ni de oportunidades recibidas en WhatsApp.</p><p>{input.ambiguous_clients} clientes con primera compra o activación simultánea ambigua excluidos preventivamente. Los resultados pueden cambiar con correcciones de datos antes del cierre oficial.</p><p>Versión {input.rule_version} · consulta {new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }).format(new Date(input.calculated_at))}.</p></div></details>
    </> : !failed ? <p className="text-xs text-[#AAB2C5]">Elige el mes y pulsa Evaluar. No hay cálculo automático de fondo ni nuevos saldos.</p> : null}
  </div>;
}
