import { calculateAdvisorGoalSeasonality } from '../commissions/goal-engine.ts';

export const AWARD_RULE_VERSION = 'awards-preview-v1';
export const EVALUATED_CATEGORIES = ['alchemist', 'influential', 'strategic'] as const;
export type EvaluatedCategory = typeof EVALUATED_CATEGORIES[number];
export const AWARD_LABELS = { alchemist: 'Alquimista', influential: 'Influyente', strategic: 'Estratégico' };
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
};
export type Indicator = { label: string; result: number | null; target: number; weight: number; points: number; unit: 'count' | 'percent' | 'usd' | 'ratio'; guidance: string };
export type CategoryEvaluation = { score: number; qualified: boolean; available: boolean; indicators: Indicator[]; failures: string[] };
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
function finish(indicators: Indicator[], failures: string[], available = true): CategoryEvaluation {
  const score = indicators.reduce((sum, i) => sum + i.points, 0);
  if (score < 80) failures.unshift('Puntaje inferior a 80.');
  return { score, indicators, failures, qualified: available && failures.length === 0, available };
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
  return finish(indicators, failures);
}
function ratio(current: number | null, previous: number | null, pct: number): number | null {
  return previous !== null && previous > 0 && current !== null ? current / (previous * (1 + pct / 100)) : null;
}
export function evaluateAwards(input: EvaluationInput) {
  if (input.rule_version !== AWARD_RULE_VERSION) throw new Error('Versión de evaluación incompatible.');
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
    const categories = { alchemist: getCohort('alchemist'), influential: getCohort('influential'), strategic: finish(indicators, failures, seasonalReliable) };
    // Executor excluded for everyone until reliable campaign delivery references exist.
    const weights = { alchemist: 20, influential: 25, strategic: 30 };
    const available = EVALUATED_CATEGORIES.filter(k => categories[k].available);
    const divisor = available.reduce((sum, k) => sum + weights[k], 0);
    const total = available.reduce((sum, k) => sum + categories[k].score * weights[k], 0) / divisor;
    const qualifiedCategories = available.filter(k => categories[k].qualified).length;
    return { id: row.advisor_id, name: row.advisor_name, categories, total, qualifiedCategories, qualified: total >= 80 && qualifiedCategories >= 1 };
  });
  const ranked = [...advisors].sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.total - a.total || a.name.localeCompare(b.name));
  const best = ranked.find(a => a.qualified)?.total;
  const leaders = best === undefined ? [] : ranked.filter(a => a.qualified && a.total === best);
  return { advisors: ranked, leaders, seasons, seasonalReliable };
}
export function awardValue(value: number | null, unit: Indicator['unit']) {
  if (value === null) return 'Sin base';
  const n = new Intl.NumberFormat('es-VE', { maximumFractionDigits: unit === 'count' ? 0 : 2 }).format(unit === 'ratio' ? value * 100 : value);
  return unit === 'usd' ? '$' + n : unit === 'percent' || unit === 'ratio' ? n + '%' : n;
}
