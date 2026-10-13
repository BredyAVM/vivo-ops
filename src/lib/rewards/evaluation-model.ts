import { calculateAdvisorGoalSeasonality } from '../commissions/goal-engine.ts';

export const AWARD_RULE_VERSION = 'awards-preview-v1';
export const EVALUATED_CATEGORIES = ['alchemist', 'influential', 'strategic', 'executor'] as const;
export type EvaluatedCategory = typeof EVALUATED_CATEGORIES[number];
export const AWARD_LABELS = { alchemist: 'Alquimista', influential: 'Influyente', strategic: 'Estratégico', executor: 'Ejecutor' };
export type AwardRules = { globalMinimum: number; executorEnabled: boolean; executorReason: string; deliveryTargets: Record<string, number> };
export function defaultAwardRules(period: string): AwardRules {
  return { globalMinimum: 80, executorEnabled: false, executorReason: period.startsWith('2026-09') ? 'Septiembre sin premio Ejecutor por fallas de registro.' : 'Pendiente de confirmar confiabilidad y referencias de entrega por campaña.', deliveryTargets: {} };
}
export function validateAwardRules(rules: AwardRules): string | null {
  if (!Number.isFinite(rules.globalMinimum) || rules.globalMinimum < 1 || rules.globalMinimum > 100 || typeof rules.executorEnabled !== 'boolean' || typeof rules.executorReason !== 'string' || rules.executorReason.length > 500 || !rules.deliveryTargets || typeof rules.deliveryTargets !== 'object' || Array.isArray(rules.deliveryTargets)) return 'Parámetros de evaluación inválidos.';
  if (!rules.executorEnabled && rules.executorReason.trim().length < 10) return 'Justifica la exclusión de Ejecutor.';
  if (Object.entries(rules.deliveryTargets).some(([id, n]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(n) || n <= 0 || n > 100)) return 'Las metas de entrega deben ser porcentajes mayores a cero y hasta 100.';
  return null;
}
type Values = Record<string, number | string | null>;
export type MetricRow = Values & { advisor_id: string; advisor_name: string };
export type Evidence = {
  client_id: number; client_name: string; category: EvaluatedCategory; metrics: Values;
  orders: { fact_origin: string; source_record_id: number; source_control: string; purchased_on: string; net_total_usd: number }[];
};
export type EvaluationInput = {
  period: string; calculated_at: string; rule_version: string;
  cohort_metrics: (MetricRow & { category: 'alchemist' | 'influential' })[];
  strategic_metrics: MetricRow[];
  seasonal_samples: { year: number; advisor_id?: string; previous_active: number; current_active: number; previous_orders: number; current_orders: number; previous_revenue: number; current_revenue: number }[];
  ambiguous_clients: number; evidence_total: number; evidence: Evidence[];
  execution?: { plays: { id: number; name: string; available_days: number }[]; counts: (MetricRow & { play_id: number })[]; volume: { advisor_id: string; proposal_clients: number }[]; evidence?: ExecutorEvidence[] };
  executor_evidence?: ExecutorEvidence[];
};
export type ExecutorEvidence = { member_id: number; play_id: number; client_id: number; client_name: string; advisor_id: string; excluded: boolean; exclusion_reason?: string; pending_no_apply: boolean; contact: boolean; response: boolean; proposal: boolean; delivered: boolean; direct_contact: boolean; direct_response: boolean; direct_proposal: boolean; advisor_investment: number; company_investment: number; delivery_orders: { order_id: number; delivered_at: string; advisor_cost: number; company_cost: number }[] };
export type Indicator = { label: string; result: number | null; target: number; weight: number; points: number; unit: 'count' | 'percent' | 'usd' | 'ratio'; guidance: string };
export type CategoryEvaluation = { score: number; qualified: boolean; available: boolean; indicators: Indicator[]; failures: string[]; minimums: string[] };
export type AdvisorEvaluation = { id: string; name: string; categories: Record<EvaluatedCategory, CategoryEvaluation>; total: number; qualified: boolean; qualifiedCategories: number };
const number = (row: Values, key: string): number | null => {
  const value = row[key];
  if (value === null) return null;
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed < 0) throw new Error('Indicador inválido: ' + key);
  return parsed;
};
function indicator(label: string, result: number | null, target: number, weight: number, unit: Indicator['unit'], guidance: string): Indicator {
  return { label, result, target, weight, points: weight * Math.min((result ?? 0) / target, 1), unit, guidance };
}
function finish(indicators: Indicator[], failures: string[], available = true, minimums: string[] = []): CategoryEvaluation {
  const score = indicators.reduce((sum, i) => sum + i.points, 0);
  if (score < 80) failures.unshift('Puntaje inferior a 80.');
  return { score, indicators, failures, minimums, qualified: available && failures.length === 0, available };
}
function cohort(row: MetricRow, key: 'alchemist' | 'influential'): CategoryEvaluation {
  const own = key === 'influential';
  const indicators = [
    indicator('Incorporación', number(row, 'incorporation'), own ? 7 : 13, 20, 'count', 'Conseguir nuevas primeras compras ' + (own ? 'por tus propios recursos.' : 'de clientes asignados; no basta recibir el contacto.')),
    indicator('Retorno', number(row, 'return_pct'), 15, 20, 'percent', 'Retomar a los clientes incorporados en los dos meses anteriores y conseguir su compra contigo.'),
    indicator('Regularidad', number(row, 'regularity_pct'), 20, 20, 'percent', 'Sostener compras en meses consecutivos; dos compras en un solo mes no sustituyen la continuidad.'),
    indicator('Recompras', number(row, 'repeat_orders'), own ? 3 : 6, 25, 'count', 'Generar compras posteriores a la incorporación, mediante tu asesoría.'),
    indicator('Facturación', number(row, 'revenue'), own ? 400 : 700, 15, 'usd', 'Desarrollar el valor comercial de estas cohortes, sin contar regalos de valor cero.'),
  ];
  const failures: string[] = [];
  if ((number(row, 'return_pct') ?? 0) < 10) failures.push('Retorno inferior al 10%.');
  if ((number(row, 'older_pool') ?? 0) < (own ? 5 : 10)) failures.push('Se requieren al menos ' + (own ? 5 : 10) + ' clientes de los dos meses anteriores.');
  return finish(indicators, failures, true, ['80 puntos sin redondear.', 'Retorno de al menos 10%.', 'Al menos ' + (own ? 5 : 10) + ' clientes incorporados en los dos meses anteriores.']);
}
function ratio(current: number | null, previous: number | null, pct: number): number | null {
  return previous !== null && previous > 0 && current !== null ? current / (previous * (1 + pct / 100)) : null;
}
export function evaluateAwards(input: EvaluationInput, rules: AwardRules = defaultAwardRules(input.period)) {
  if (input.rule_version !== AWARD_RULE_VERSION && input.rule_version !== 'awards-v2') throw new Error('Versión de evaluación incompatible.');
  const ruleError = validateAwardRules(rules);
  if (ruleError) throw new Error(ruleError);
  const plays = input.execution?.plays ?? [];
  const executorAvailable = input.rule_version === 'awards-v2' && !input.period.startsWith('2026-09') && rules.executorEnabled && plays.length > 0 && plays.every(p => Number.isFinite(rules.deliveryTargets[String(p.id)]) && rules.deliveryTargets[String(p.id)] > 0);
  const samples = input.seasonal_samples;
  const season = (previous: 'previous_active' | 'previous_orders' | 'previous_revenue', current: 'current_active' | 'current_orders' | 'current_revenue') => calculateAdvisorGoalSeasonality(samples.map(s => ({ year: s.year, advisorId: s.advisor_id ?? '', previousValue: Number(s[previous]), currentValue: Number(s[current]) })));
  const seasons = { active: season('previous_active', 'current_active'), orders: season('previous_orders', 'current_orders'), revenue: season('previous_revenue', 'current_revenue') };
  const seasonalReliable = Object.values(seasons).every(s => s.confidence !== 'low' && s.suggestedPct > -100);
  const advisors: AdvisorEvaluation[] = input.strategic_metrics.map(row => {
    const active = ratio(number(row, 'current_active'), number(row, 'prior_active'), seasons.active.suggestedPct);
    const orders = ratio(number(row, 'current_orders'), number(row, 'prior_orders'), seasons.orders.suggestedPct);
    const billing = ratio(number(row, 'current_revenue'), number(row, 'prior_revenue'), seasons.revenue.suggestedPct);
    const indicators = [
      indicator('Clientes activos / esperado', active, 1.10, 20, 'ratio', 'Recuperar actividad en la misma cartera madura comparada con el mes anterior.'),
      indicator('Continuidad', number(row, 'continuity_pct'), 40, 25, 'percent', 'Conseguir que los clientes activos del mes anterior vuelvan a comprarte.'),
      indicator('Reactivación · 60–180 días', number(row, 'reactivation_pct'), 12, 25, 'percent', 'Reconectar a los clientes que al iniciar el mes llevaban entre 60 y 180 días sin comprar.'),
      indicator('Recompra en distintos días', number(row, 'multi_day_buyers_pct'), 30, 20, 'percent', 'Promover un próximo plan en otro día; dividir un pedido el mismo día no mejora este indicador.'),
      indicator('Cierres / esperado', orders, 1.10, 5, 'ratio', 'Aumentar los cierres por encima de la variación esperada por temporada.'),
      indicator('Facturación / esperado', billing, 1.10, 5, 'ratio', 'Desarrollar la facturación de esta cartera; no se premia solo el aumento estacional.'),
    ];
    const failures: string[] = [];
    for (const [key, label] of [['prior_active', 'activos previos'], ['current_active', 'activos actuales'], ['dormant_60_180', 'clientes recuperables de 60–180 días']] as const) {
      if ((number(row, key) ?? 0) < 10) failures.push('Se requieren al menos 10 ' + label + '.');
    }
    if ((active ?? 0) < 1.05 && (orders ?? 0) < 1.05) failures.push('Ni activos ni cierres superan en 5% el esperado estacional.');
    if ((billing ?? 0) < .90) failures.push('Facturación inferior al 90% del esperado estacional.');
    if (!seasonalReliable) failures.push('Referencia estacional insuficiente; categoría no evaluable para todos.');
    const getCohort = (key: 'alchemist' | 'influential') => {
      const values = input.cohort_metrics.filter(c => c.advisor_id === row.advisor_id && c.category === key);
      if (values.length !== 1) throw new Error('Faltan indicadores de ' + AWARD_LABELS[key]);
      return cohort(values[0], key);
    };
    const counts = input.execution?.counts.filter(c => c.advisor_id === row.advisor_id) ?? [];
    const sum = (key: string) => counts.reduce((n, c) => n + (number(c, key) ?? 0), 0);
    const assigned = sum('assigned');
    const pct = (key: string) => assigned > 0 ? sum(key) / assigned * 100 : null;
    const expected = executorAvailable ? counts.reduce((n, c) => n + (number(c, 'assigned') ?? 0) * rules.deliveryTargets[String(c.play_id)] / 100, 0) : 0;
    const proposals = Number(input.execution?.volume.find(v => v.advisor_id === row.advisor_id)?.proposal_clients ?? 0);
    const executorIndicators = [
      indicator('Contacto', pct('contact'), 90, 8, 'percent', 'Contactar orgánicamente y registrar el contacto automático o manual.'),
      indicator('Respuesta', pct('response'), 70, 24, 'percent', 'Conseguir interacción real; registrar cuando el cliente responde.'),
      indicator('Propuesta de jugada', pct('proposal'), 70, 16, 'percent', 'Presentar el beneficio tras el acercamiento y marcar que se lanzó la propuesta.'),
      indicator('Entrega / referencia de campañas', expected > 0 ? sum('delivered') / expected : null, 1, 32, 'ratio', 'Completar la entrega del beneficio. La referencia temporal solo ajusta este indicador, no mensajes ni respuestas.'),
      indicator('Clientes distintos con propuesta', proposals, 30, 20, 'count', 'Sostener el trabajo con volumen: cuenta cada cliente una vez, no mensajes repetidos.'),
    ];
    const executorFailures: string[] = [];
    if (assigned < 10) executorFailures.push('Se requieren al menos 10 asignaciones evaluables.');
    if ((pct('contact') ?? 0) < 70) executorFailures.push('Contacto inferior al 70%.');
    if ((pct('proposal') ?? 0) < 50) executorFailures.push('Propuesta inferior al 50%.');
    if (!executorAvailable) executorFailures.push(input.period.startsWith('2026-09') ? 'Septiembre sin premio por fallas de registro.' : !rules.executorEnabled ? rules.executorReason : 'Faltan referencias de entrega para todas las campañas publicadas en este mes.');
    const categories = { alchemist: getCohort('alchemist'), influential: getCohort('influential'), strategic: finish(indicators, failures, seasonalReliable, ['80 puntos sin redondear.', '10 activos previos, 10 actuales y 10 recuperables de 60–180 días.', 'Activos o cierres al menos 5% sobre el esperado estacional.', 'Facturación al menos 90% del esperado estacional.', 'Referencia estacional confiable.']), executor: finish(executorIndicators, executorFailures, executorAvailable, ['80 puntos sin redondear.', '10 asignaciones evaluables.', 'Contacto de al menos 70%.', 'Propuesta de al menos 50%.', 'Registro confiable y referencias de entrega completas, iguales para todos.']) };
    const weights = { alchemist: 20, influential: 25, strategic: 30, executor: 25 };
    const available = EVALUATED_CATEGORIES.filter(k => categories[k].available);
    const divisor = available.reduce((sum, k) => sum + weights[k], 0);
    const total = available.reduce((sum, k) => sum + categories[k].score * weights[k], 0) / divisor;
    const qualifiedCategories = available.filter(k => categories[k].qualified).length;
    return { id: row.advisor_id, name: row.advisor_name, categories, total, qualifiedCategories, qualified: total >= rules.globalMinimum && qualifiedCategories >= 1 };
  });
  const ranked = [...advisors].sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.total - a.total || a.name.localeCompare(b.name));
  const best = ranked.find(a => a.qualified)?.total;
  const leaders = best === undefined ? [] : ranked.filter(a => a.qualified && a.total === best);
  const categoryLeaders = Object.fromEntries(EVALUATED_CATEGORIES.map(k => {
    const eligible = ranked.filter(a => a.categories[k].qualified);
    const highest = Math.max(...eligible.map(a => a.categories[k].score));
    return [k, eligible.filter(a => a.categories[k].score === highest).map(a => ({ id: a.id, name: a.name }))];
  }));
  categoryLeaders.advisor_of_month = leaders.map(a => ({ id: a.id, name: a.name }));
  const weights = { alchemist: 20, influential: 25, strategic: 30, executor: 25 };
  const usable = EVALUATED_CATEGORIES.filter(k => k === 'strategic' ? seasonalReliable : k === 'executor' ? executorAvailable : true);
  const divisor = usable.reduce((s, k) => s + weights[k], 0);
  const effectiveWeights = Object.fromEntries(EVALUATED_CATEGORIES.map(k => [k, usable.includes(k) ? weights[k] / divisor * 100 : 0]));
  return { ruleVersion: input.rule_version, advisors: ranked, leaders, categoryLeaders, seasons, seasonalReliable, executorAvailable, effectiveWeights, globalMinimum: rules.globalMinimum };
}
export function awardValue(value: number | null, unit: Indicator['unit']) {
  if (value === null) return 'Sin base';
  const n = new Intl.NumberFormat('es-VE', { maximumFractionDigits: unit === 'count' ? 0 : 2 }).format(unit === 'ratio' ? value * 100 : value);
  return unit === 'usd' ? '$' + n : unit === 'percent' || unit === 'ratio' ? n + '%' : n;
}
