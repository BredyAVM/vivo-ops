import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { UUID_PATTERN } from '@/lib/rewards/wallet-model';
import { AWARD_LABELS, EVALUATED_CATEGORIES, awardValue, evaluateAwards, defaultAwardRules, validateAwardRules, type AwardRules, type EvaluationInput, type EvaluatedCategory } from '@/lib/rewards/evaluation-model';
import AwardReviewControls from './AwardReviewControls';

const box = 'rounded-lg border border-[#292937] bg-[#111117] p-3';
const score = (n: number) => n.toFixed(2);
const descriptions = {
  alchemist: 'Asignados y clientes de origen empresarial activados por asesor. Mes elegido y dos meses previos. Solo compras por ese asesor; la incorporación no cuenta como recompra.',
  influential: 'Clientes propios, excluyendo origen empresarial. Mes elegido y dos meses previos. Solo compras por el asesor de incorporación.',
  strategic: 'Misma cartera madura al iniciar el mes: primera compra anterior a los tres meses previos. Comparación con el mes anterior y ajuste mensual de temporada. Propietario reconstruido por última compra previa con asesor activo.',
  executor: 'Contacto, respuesta, propuesta y entrega en campañas publicadas durante el mes. Volumen de clientes distintos con propuesta. No aplica aprobado y retiros administrativos se excluyen; pendientes siguen contando. La inversión no da puntos por sí misma.',
};
export default async function AwardEvaluationPage({ searchParams }: { searchParams?: Promise<{ month?: string; evaluate?: string; advisor?: string; category?: string; page?: string; rules?: string; report?: string }> }) {
  const ctx = await requireAdminContext();
  const params = await searchParams ?? {};
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const today = todayParts.find(p => p.type === 'year')!.value + '-' + todayParts.find(p => p.type === 'month')!.value;
  const lastMonth = new Date(today + '-01T12:00:00-04:00');
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const period = params.month ?? lastMonth.toISOString().slice(0, 7);
  const validPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period >= '2026-01' && period <= today;
  const advisorId = UUID_PATTERN.test(params.advisor ?? '') ? params.advisor! : null;
  const category = EVALUATED_CATEGORIES.includes(params.category as EvaluatedCategory) ? params.category as EvaluatedCategory : null;
  const page = /^\d{1,4}$/.test(params.page ?? '') ? Math.max(0, Number(params.page) - 1) : 0;
  const reportId = UUID_PATTERN.test(params.report ?? '') ? params.report! : null;
  let rules = defaultAwardRules(period);
  let invalidRules = false;
  if (params.rules) {
    try { if (params.rules.length > 5000) throw new Error(); rules = JSON.parse(params.rules) as AwardRules; invalidRules = Boolean(validateAwardRules(rules)); } catch { invalidRules = true; }
  }
  const href = (advisor?: string, key?: EvaluatedCategory, nextPage = 0) => '/app/admin/evaluacion?' + new URLSearchParams({ month: period, ...(reportId ? { report: reportId } : { evaluate: '1', rules: JSON.stringify(rules) }), ...(advisor && key ? { advisor, category: key, page: String(nextPage + 1) } : {}) });
  let input: EvaluationInput | null = null;
  let result: ReturnType<typeof evaluateAwards> | null = null;
  let report: { id: string; status: string; created_at: string; published_at: string | null; publication_reason: string | null } | undefined;
  let failed = false;
  const [reports, publication] = validPeriod ? await Promise.all([
    ctx.supabase.from('award_month_reports').select('id,status,created_at,published_at,publication_reason').eq('period', period + '-01').order('created_at', { ascending: false }).limit(21),
    ctx.supabase.from('award_month_reports').select('id').eq('period', period + '-01').eq('status', 'published').maybeSingle(),
  ]) : [{ data: [], error: null }, { data: null, error: null }];
  if ((params.evaluate === '1' || reportId) && validPeriod && !invalidRules) {
    const args = { p_advisor: advisorId && category ? advisorId : null, p_category: advisorId && category ? category : null, p_offset: page * 50 };
    const { data, error } = reportId ? await ctx.supabase.rpc('admin_award_report_view_v2', { p_report: reportId, ...args }) : await ctx.supabase.rpc('admin_award_evaluation_preview_v2', { p_month: period + '-01', ...args });
    try {
      if (error || !data) throw new Error('Evaluation unavailable');
      if (reportId) {
        const saved = data as { input: EvaluationInput; rules: AwardRules; result: ReturnType<typeof evaluateAwards> | null } & NonNullable<typeof report>;
        report = saved;
        input = saved.input;
        if (input.period.slice(0,7) !== period) throw new Error('Período incompatible.');
        rules = saved.rules;
        result = saved.result;
      } else {
        input = data as EvaluationInput;
        result = evaluateAwards(input, rules);
      }
    } catch {
      console.error('Award evaluation unavailable', error?.code ?? 'invalid_payload');
      failed = true;
    }
  }
  const selected = result?.advisors.find(a => a.id === advisorId);
  const selectedMetrics = input && selected && category ? category === 'strategic'
    ? input.strategic_metrics.find(r => r.advisor_id === selected.id)
    : category === 'executor' ? null : input.cohort_metrics.find(r => r.advisor_id === selected.id && r.category === category) : null;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-lg font-semibold">Evaluación de asesores</h1><p className="text-xs text-[#AAB2C5]">Cómo se obtienen los puntos, quién clasifica y qué puede mejorar.</p></div><Link prefetch={false} className="text-xs text-yellow-200" href={'/app/admin/premios?month=' + (validPeriod ? period : today)}>Entrega de premios →</Link></header>
    <p className={box + ' text-xs leading-5 text-amber-100'}>{report ? 'Corte guardado: datos, reglas y resultados congelados. ' + (report.status === 'published' ? 'Publicado para los asesores.' : report.status === 'superseded' ? 'Historial: reemplazado por una corrección posterior.' : 'Todavía no publicado para los asesores.') : 'Vista previa administrativa: se recalcula al consultar. Guarda un corte, revisa y publica cuando termine el mes.'} No emite crédito ni modifica órdenes, clientes, saldos o comisiones.</p>
    <form className="flex flex-wrap items-end gap-2"><input type="hidden" name="evaluate" value="1" /><label className="text-xs">Mes a evaluar<input className="ml-2 min-h-10 rounded-lg border border-[#303040] bg-[#0B0B10] px-3" type="month" name="month" min="2026-01" max={today} defaultValue={validPeriod ? period : today} /></label><button className="min-h-10 rounded-lg bg-yellow-300 px-4 text-xs font-semibold text-black">Evaluar / actualizar</button></form>
    {!validPeriod ? <p role="alert">Selecciona un mes de 2026 en adelante, no posterior al mes actual.</p> : null}
    {invalidRules ? <p role="alert">Parámetros inválidos. Vuelve a consultar sin esos parámetros.</p> : null}
    {period === today ? <p className="text-xs text-amber-200">Mes en curso: resultados parciales, todavía no comparables con un cierre mensual.</p> : null}
    {failed ? <p role="alert" className={box}>No se pudo calcular la evaluación. Vuelve a consultar. No se presentan ceros ni ganadores con datos incompletos.</p> : null}
    {reports.error || publication.error ? <p role="alert">No se pudo consultar el historial de cierres. No publiques hasta actualizar.</p> : <details className={box + ' text-xs'}><summary className="cursor-pointer">Cortes y publicaciones guardados · {reports.data?.length ?? 0}</summary><div className="mt-2 space-y-2">{reports.data?.slice(0,20).map(r => <p key={r.id}><Link prefetch={false} className="text-yellow-200 underline" href={'/app/admin/evaluacion?month=' + period + '&report=' + r.id}>{new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }).format(new Date(r.created_at))} · {r.status === 'published' ? 'Publicado' : r.status === 'superseded' ? 'Reemplazado' : r.status === 'review' ? 'En revisión' : 'Pendiente de cálculo'}</Link>{r.publication_reason ? ' · ' + r.publication_reason : ''}</p>)}{!reports.data?.length ? <p>No hay cortes guardados para este mes.</p> : null}{(reports.data?.length ?? 0) > 20 ? <p>Se muestran los 20 cortes más recientes.</p> : null}</div></details>}
    {input && !failed && !reports.error && !publication.error ? <details className={box + ' text-xs'}><summary className="min-h-9 cursor-pointer text-yellow-200">Parámetros · guardar corte · cerrar y publicar</summary><AwardReviewControls key={reportId ?? period + ':' + JSON.stringify(rules)} period={period} initialRules={rules} plays={input.execution?.plays ?? []} report={report ? { id: report.id, status: report.status } : undefined} currentPublication={publication.data?.id ?? null} isClosed={period < today} /></details> : null}
    {result && input ? <>
      <section className={box + ' space-y-2 text-xs'}>
        <h2 className="text-sm font-semibold">Asesor del Mes · {report?.status === 'published' ? 'Publicado' : report ? 'Corte en revisión' : 'Simulación'}{!result.executorAvailable || !result.seasonalReliable ? ' · cobertura parcial' : ''}</h2>
        <p className="text-yellow-200">{result.leaders.length ? (result.leaders.length > 1 ? 'Empate: ' : report?.status === 'published' ? 'Ganador del cierre: ' : 'Lidera la simulación: ') + result.leaders.map(a => a.name).join(' · ') : 'Desierto: nadie cumple los mínimos.'}</p>
        <p>Pesos originales: Alquimista 20%, Influyente 25%, Estratégico 30%, Ejecutor 25%. Se redistribuyen entre las categorías evaluables para todos, nunca por el bajo puntaje de una persona.</p>
        <p>Al menos una categoría clasificada y {rules.globalMinimum} puntos globales. {report ? 'Mínimo confirmado en este corte.' : 'El valor propuesto debe confirmarse antes de publicar.'} Los empates se muestran como empate; si nadie clasifica, queda desierto.</p>
        <p>Ejecutor: {result.executorAvailable ? 'incluido; referencias de entrega iguales para todos los asesores.' : period === '2026-09' ? 'septiembre sin premio por fallas de registro.' : rules.executorEnabled ? 'faltan referencias completas de entrega.' : rules.executorReason} {!result.executorAvailable ? 'Queda fuera para todos; no aporta cero puntos.' : ''}</p>
        <p>Pesos efectivos: {EVALUATED_CATEGORIES.map(k => AWARD_LABELS[k] + ' ' + score(result.effectiveWeights?.[k] ?? 0) + '%').join(' · ')}.</p>
      </section>
      <div className="overflow-x-auto rounded-lg border border-[#292937]"><table className="w-full whitespace-nowrap text-left text-xs"><caption className="p-2 text-left">Ranking · primero quienes cumplen los mínimos globales del cálculo</caption><thead className="bg-[#17171F]"><tr><th className="p-2">Asesor</th>{EVALUATED_CATEGORIES.map(k => <th className="p-2" key={k}>{AWARD_LABELS[k]}</th>)}<th className="p-2">Global</th><th className="p-2">Clasificación</th></tr></thead><tbody>{result.advisors.map(a => <tr key={a.id} className="border-t border-[#292937]"><th className="p-2 font-normal">{a.name}</th>{EVALUATED_CATEGORIES.map(k => <td className="p-2" key={k}><Link prefetch={false} className={a.categories[k].qualified ? 'text-emerald-300 underline' : 'text-[#AAB2C5] underline'} href={href(a.id, k)}>{a.categories[k].available ? score(a.categories[k].score) : 'No evaluable'}{a.categories[k].qualified ? ' ✓' : ''}<span className="sr-only"> · Ver indicadores de {a.name} en {AWARD_LABELS[k]}</span></Link></td>)}<td className="p-2">{score(a.total)}</td><td className="p-2">{a.qualified ? report ? 'Clasifica en el corte' : 'Clasifica en simulación' : 'No clasifica'} · {a.qualifiedCategories} categorías</td></tr>)}</tbody></table></div>
      <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">{EVALUATED_CATEGORIES.map(k => {
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
        <details><summary className="cursor-pointer text-xs text-yellow-200">Cómo se calcula y cómo mejorar</summary><div className="mt-2 space-y-2 text-xs"><p>Cada indicador aporta su peso × resultado/meta, con tope en su peso. Cumplir una meta no reemplaza los mínimos obligatorios.</p><p>{category === 'executor' ? 'Mínimos: 80 puntos; 10 asignaciones evaluables; contacto 70%; propuesta 50%; registro confiable. Contacto, respuesta y propuesta se dividen entre todas las asignaciones evaluables. Entrega = clientes con beneficio entregado / suma de asignaciones por la meta porcentual de cada campaña. Volumen cuenta clientes distintos, una sola vez. Inversión y repetición de obsequios no dan puntos adicionales.' : category === 'strategic' ? 'Mínimos: 80 puntos; 10 activos previos, 10 actuales y 10 recuperables; activos o cierres al menos 5% sobre el esperado estacional; facturación al menos 90% del esperado.' : 'Mínimos: 80 puntos; retorno de 10%; al menos ' + (category === 'alchemist' ? 10 : 5) + ' clientes incorporados en los dos meses previos. Retorno = los que compraron este mes / esa base anterior. Regularidad = promedio por cliente de los meses posteriores a incorporación con compra, excluyendo cohorte actual.'}</p>{selected.categories[category].indicators.map(i => <p key={i.label}><span className="font-semibold">{i.label}{i.points < i.weight ? ' · Por desarrollar' : ' · Meta completa'}: </span>{i.guidance}</p>)}</div></details>
        {category === 'executor' ? <div className="space-y-2 text-xs"><h3 className="font-semibold">Campañas, registros e inversión</h3>{input.execution?.counts.filter(c => c.advisor_id === selected.id).map(c => <p key={c.play_id}>{input.execution?.plays.find(p => p.id === c.play_id)?.name} · Evaluables {c.assigned}; excluidos {c.excluded}; No aplica pendiente {c.pending_no_apply}. Contactos {c.contact}, respuestas {c.response}, propuestas {c.proposal}, entregas {c.delivered}. Registros directos: {c.direct_contact}/{c.direct_response}/{c.direct_proposal}. Asesor {awardValue(Number(c.advisor_investment), 'usd')}; empresa {awardValue(Number(c.company_investment), 'usd')}.</p>)}<p>Aportes configurados en la jugada; no son costo contable de producción. {input.execution?.counts.some(c => c.advisor_id === selected.id && Number(c.missing_cost_records ?? 0) > 0) ? 'Hay entregas con aportes incompletos: se muestran solo los importes registrados, no un costo total confirmado.' : ''}</p><p>Una entrega confirmada acredita el recorrido previo cuando falta marcado manual; los registros directos se muestran por separado, no como mensajes comprobados.</p>{input.executor_evidence?.map(e => <details key={e.member_id} className="border-t border-[#292937] pt-2"><summary className="cursor-pointer">{e.client_name} · {e.excluded ? 'Excluido' : e.delivered ? 'Entregado' : e.proposal ? 'Propuesta' : e.response ? 'Respondió' : e.contact ? 'Contactado' : 'Pendiente'}</summary><p className="mt-2">{e.excluded ? e.exclusion_reason : ''}</p><p>{input.execution?.plays.find(p => p.id === e.play_id)?.name} · {e.pending_no_apply ? 'No aplica pendiente: sigue contando.' : ''}</p>{e.delivery_orders.map(o => <p key={o.order_id}>Orden #{o.order_id} · {o.delivered_at.slice(0,10)} · Asesor {awardValue(Number(o.advisor_cost), 'usd')} · Empresa {awardValue(Number(o.company_cost), 'usd')}</p>)}</details>)}</div> : null}
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
