import { calculateAdvisorGoalSeasonality } from '../commissions/goal-engine.ts';

export const AWARD_RULE_VERSION = 'awards-preview-v1';
export const EVALUATED_CATEGORIES = ['alchemist', 'influential', 'strategic', 'executor'] as const;
export type EvaluatedCategory = typeof EVALUATED_CATEGORIES[number];
export const AWARD_LABELS = { alchemist: 'Alquimista', influential: 'Influyente', strategic: 'Estratégico', executor: 'Ejecutor' };
export type AwardRules = {
  globalMinimum: number; executorEnabled: boolean; executorReason: string; deliveryTargets: Record<string, number>;
  contactTargetPct?: number; executorReviewNote?: string;
  executorFormula?: 'legacy-v1' | 'balanced-volume-v1'; executorEvidenceMode?: 'recorded' | 'supported';
  executorDeliveryVolumeSharePct?: number; executorDeliveryVolumeReference?: number; executorProposalVolumeReference?: number;
};
export function balancedExecutorRules(rules: AwardRules): AwardRules {
  return { ...rules, executorFormula: 'balanced-volume-v1', executorEvidenceMode: 'supported',
    executorDeliveryVolumeSharePct: 25, executorDeliveryVolumeReference: 10, executorProposalVolumeReference: 10 };
}
export function defaultAwardRules(period: string): AwardRules {
  return balancedExecutorRules({ globalMinimum: 80, executorEnabled: false, executorReason: period.startsWith('2026-09') ? 'Septiembre sin premio Ejecutor por fallas de registro.' : 'Pendiente de confirmar confiabilidad y referencias de entrega por campaña.', deliveryTargets: {}, contactTargetPct: 80, executorReviewNote: '' });
}
export function validateAwardRules(rules: AwardRules): string | null {
  if (!Number.isFinite(rules.globalMinimum) || rules.globalMinimum < 1 || rules.globalMinimum > 100 || typeof rules.executorEnabled !== 'boolean' || typeof rules.executorReason !== 'string' || rules.executorReason.length > 500 || !rules.deliveryTargets || typeof rules.deliveryTargets !== 'object' || Array.isArray(rules.deliveryTargets)) return 'Parámetros de evaluación inválidos.';
  if (!rules.executorEnabled && rules.executorReason.trim().length < 10) return 'Justifica la exclusión de Ejecutor.';
  if (rules.contactTargetPct !== undefined && (!Number.isFinite(rules.contactTargetPct) || rules.contactTargetPct < 1 || rules.contactTargetPct > 100)) return 'La referencia de contacto debe estar entre 1% y 100%.';
  if (rules.executorReviewNote !== undefined && (typeof rules.executorReviewNote !== 'string' || rules.executorReviewNote.length > 500)) return 'La observación de Ejecutor admite hasta 500 caracteres.';
  if (rules.executorFormula !== undefined && !['legacy-v1', 'balanced-volume-v1'].includes(rules.executorFormula)) return 'Fórmula de Ejecutor inválida.';
  if (rules.executorEvidenceMode !== undefined && !['recorded', 'supported'].includes(rules.executorEvidenceMode)) return 'Selecciona la base de registros de Ejecutor.';
  if (rules.executorDeliveryVolumeSharePct !== undefined && (!Number.isFinite(rules.executorDeliveryVolumeSharePct) || rules.executorDeliveryVolumeSharePct < 1 || rules.executorDeliveryVolumeSharePct > 50)) return 'El volumen de entrega admite entre 1% y 50% de sus 32 puntos.';
  for (const ref of [rules.executorDeliveryVolumeReference, rules.executorProposalVolumeReference]) {
    if (ref !== undefined && (!Number.isSafeInteger(ref) || ref < 1 || ref > 1000)) return 'Las referencias graduales deben ser enteros entre 1 y 1000 clientes.';
  }
  if (Object.entries(rules.deliveryTargets).some(([id, n]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(n) || n <= 0 || n > 100)) return 'Las metas de entrega deben ser porcentajes mayores a cero y hasta 100.';
  return null;
}
export function deliveryTargetsForDays(plays: { id: number; available_days: number }[], basePct: number) {
  if (!Number.isFinite(basePct) || basePct <= 0 || basePct > 100) throw new Error('La referencia mensual de entrega debe ser mayor a cero y hasta 100%.');
  return Object.fromEntries(plays.map(p => {
    if (!Number.isSafeInteger(p.id) || p.id <= 0 || !Number.isFinite(p.available_days) || p.available_days <= 0) throw new Error('Campaña sin días disponibles para evaluar la entrega.');
    return [String(p.id), Number(Math.min(100, basePct * p.available_days / 30).toFixed(4))];
  }));
}
export function validateAwardPeriodRules(period: string, rules: AwardRules): string | null {
  const error = validateAwardRules(rules);
  if (error) return error;
  return period.startsWith('2026-09') && rules.executorEnabled && (rules.executorReviewNote?.trim().length ?? 0) < 10
    ? 'Septiembre requiere justificar la aceptación de las limitaciones del registro de Ejecutor.' : null;
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
  execution?: {
    plays: { id: number; name: string; available_days: number }[]; counts: (MetricRow & { play_id: number })[];
    volume: { advisor_id: string; proposal_clients: number }[]; evidence?: ExecutorEvidence[];
    metrics_version?: string; balanced_counts?: (MetricRow & { play_id: number })[];
    balanced_volume?: { advisor_id: string; proposal_clients: number; delivered_clients: number }[];
  };
  executor_evidence?: ExecutorEvidence[];
};
export type ExecutorEvidence = { member_id: number; play_id: number; client_id: number; client_name: string; advisor_id: string; excluded: boolean; exclusion_reason?: string; pending_no_apply: boolean; contact: boolean; response: boolean; proposal: boolean; delivered: boolean; direct_contact: boolean; direct_response: boolean; direct_proposal: boolean; advisor_investment: number; company_investment: number; delivery_orders: { order_id: number; delivered_at: string; advisor_cost: number; company_cost: number }[] };
export type Indicator = { label: string; result: number | null; target: number; weight: number; points: number; unit: 'count' | 'percent' | 'usd' | 'ratio'; guidance: string; scoring?: 'gradual' };
export type ExecutorContext = {
  formula: 'legacy-v1' | 'balanced-volume-v1'; evidenceMode: 'recorded' | 'supported'; assigned: number; contact: number;
  response: number; proposal: number; delivered: number; uniqueProposals: number; uniqueDelivered: number;
  expectedDeliveries: number; recordedContact: number; recordedResponse: number; recordedProposal: number;
};
export type CategoryEvaluation = { score: number; qualified: boolean; available: boolean; indicators: Indicator[]; failures: string[]; minimums: string[]; executorContext?: ExecutorContext };
export function executorSummary(c: ExecutorContext) {
  return `${c.formula === 'balanced-volume-v1' ? 'Reformado · efectividad y volumen' : 'Fórmula anterior'} · ${c.evidenceMode === 'supported' ? 'registros respaldados (no mensajes verificados)' : 'estados registrados, incluidos inferidos'}. Lista ${c.assigned}; contactados ${c.contact}; respuestas ${c.response}; propuestas ${c.proposal}; entregas ${c.delivered}. Clientes únicos: ${c.uniqueProposals} con propuesta${c.formula === 'balanced-volume-v1' ? ` y ${c.uniqueDelivered} con entrega` : ''}.`;
}
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
function gradualIndicator(label: string, result: number, reference: number, weight: number, guidance: string): Indicator {
  return { label, result, target: reference, weight, points: weight * result / (result + reference), unit: 'count', scoring: 'gradual',
    guidance: guidance + ` Fórmula: ${weight} × clientes / (clientes + ${reference}). La referencia da la mitad de puntos, no el máximo. Sigue creciendo con aportes cada vez menores; no hay corte en 30 clientes.` };
}
export function indicatorReference(i: Indicator) {
  return awardValue(i.target, i.unit) + (i.scoring === 'gradual' ? ' · mitad de puntos' : '');
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
  const balanced = rules.executorFormula === 'balanced-volume-v1';
  const evidenceMode = balanced ? rules.executorEvidenceMode ?? 'supported' : 'recorded';
  const summaryReady = input.execution?.metrics_version === 'executor-summary-v3'
    && Array.isArray(input.execution.balanced_counts) && Array.isArray(input.execution.balanced_volume);
  if (balanced && rules.executorEnabled && !summaryReady) throw new Error('Falta el resumen de evidencias para la fórmula reformada. Actualiza el cálculo antes de guardar.');
  const septemberAccepted = !input.period.startsWith('2026-09') || (rules.executorReviewNote?.trim().length ?? 0) >= 10;
  const executorAvailable = input.rule_version === 'awards-v2' && septemberAccepted && rules.executorEnabled && plays.length > 0 && plays.every(p => Number.isFinite(rules.deliveryTargets[String(p.id)]) && rules.deliveryTargets[String(p.id)] > 0);
  // Missing parameter preserves the original 90% reference in legacy cuts/resumed calculations.
  const contactTarget = rules.contactTargetPct ?? 90;
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
    const recordedCounts = input.execution?.counts.filter(c => c.advisor_id === row.advisor_id) ?? [];
    const counts = balanced && evidenceMode === 'supported'
      ? input.execution?.balanced_counts?.filter(c => c.advisor_id === row.advisor_id) ?? [] : recordedCounts;
    const sum = (key: string) => counts.reduce((n, c) => n + (number(c, key) ?? 0), 0);
    const assigned = sum('assigned');
    const contact = sum('contact');
    const pct = (key: string) => assigned > 0 ? sum(key) / assigned * 100 : null;
    const perContact = (key: string) => contact > 0 ? sum(key) / contact * 100 : null;
    const expected = executorAvailable ? counts.reduce((n, c) => n + (number(c, 'assigned') ?? 0) * rules.deliveryTargets[String(c.play_id)] / 100, 0) : 0;
    const volume = input.execution?.balanced_volume?.find(v => v.advisor_id === row.advisor_id);
    const proposals = number({ value: (balanced && evidenceMode === 'supported' ? volume?.proposal_clients
      : input.execution?.volume.find(v => v.advisor_id === row.advisor_id)?.proposal_clients) ?? 0 }, 'value')!;
    const uniqueDelivered = number({ value: volume?.delivered_clients ?? 0 }, 'value')!;
    if (balanced && executorAvailable && (sum('response') > contact || sum('proposal') > contact || contact > assigned)) throw new Error('Resumen de Ejecutor inconsistente: revisa contacto, respuesta y propuesta.');
    const deliveryVolumeWeight = 32 * (rules.executorDeliveryVolumeSharePct ?? 25) / 100;
    const executorIndicators = balanced ? [
      indicator('Cobertura de contacto · lista', pct('contact'), contactTarget, 8, 'percent', 'Contacto / lista evaluable. Una propuesta directa o una entrega acredita contacto, pero no se presupone respuesta por lanzar la propuesta. Los días no reducen la referencia de contacto.'),
      indicator('Respuesta · contactados', perContact('response'), 70, 24, 'percent', 'Respuestas / contactados, no sobre toda la lista. En modo respaldado cuenta registro directo de respuesta o entrega confirmada; lanzar la propuesta por sí solo no acredita respuesta.'),
      indicator('Propuesta · contactados', perContact('proposal'), 70, 16, 'percent', 'Propuestas / contactados, no respuestas. Se reconoce el avance en el abordaje sin suponer que todos contestaron.'),
      indicator('Entrega · cumplimiento temporal', expected > 0 ? sum('delivered') / expected : null, 1, 32 - deliveryVolumeWeight, 'ratio', 'Entregas / referencia ajustada por los días de cada campaña. Solo este componente cambia por duración; superar la referencia no agrega puntos aquí.'),
      gradualIndicator('Entrega · volumen único', uniqueDelivered, rules.executorDeliveryVolumeReference ?? 10, deliveryVolumeWeight, 'Cada cliente que recibió un beneficio cuenta una vez en el mes, aunque se repita la entrega.'),
      gradualIndicator('Propuestas · volumen único', proposals, rules.executorProposalVolumeReference ?? 10, 20, 'Reconoce el trabajo efectivo con clientes distintos, sin comparar con el mejor asesor ni favorecer un ganador específico.'),
    ] : [
      indicator('Contacto', pct('contact'), contactTarget, 8, 'percent', 'Contactar orgánicamente y registrar el contacto automático o manual. La duración de la campaña no reduce esta referencia; contactar no obliga a entregar el beneficio.'),
      indicator('Respuesta', pct('response'), 70, 24, 'percent', 'Conseguir interacción real; registrar cuando el cliente responde.'),
      indicator('Propuesta de jugada', pct('proposal'), 70, 16, 'percent', 'Presentar el beneficio tras el acercamiento y marcar que se lanzó la propuesta.'),
      indicator('Entrega / referencia de campañas', expected > 0 ? sum('delivered') / expected : null, 1, 32, 'ratio', 'Completar la entrega del beneficio. La referencia temporal solo ajusta este indicador, no mensajes ni respuestas.'),
      indicator('Clientes distintos con propuesta', proposals, 30, 20, 'count', 'Sostener el trabajo con volumen: cuenta cada cliente una vez, no mensajes repetidos.'),
    ];
    const executorFailures: string[] = [];
    if (assigned < 10) executorFailures.push('Se requieren al menos 10 asignaciones evaluables.');
    if ((pct('contact') ?? 0) < 70) executorFailures.push('Contacto inferior al 70%.');
    if (((balanced ? perContact('proposal') : pct('proposal')) ?? 0) < 50) executorFailures.push(balanced ? 'Propuesta inferior al 50% de los contactados.' : 'Propuesta inferior al 50%.');
    if (!executorAvailable) executorFailures.push(input.period.startsWith('2026-09') && !septemberAccepted ? 'Septiembre sin premio por fallas de registro; requiere aceptación administrativa explícita para incluirlo.' : !rules.executorEnabled ? rules.executorReason : 'Faltan referencias de entrega para todas las campañas publicadas en este mes.');
    const categories = { alchemist: getCohort('alchemist'), influential: getCohort('influential'), strategic: finish(indicators, failures, seasonalReliable, ['80 puntos sin redondear.', '10 activos previos, 10 actuales y 10 recuperables de 60–180 días.', 'Activos o cierres al menos 5% sobre el esperado estacional.', 'Facturación al menos 90% del esperado estacional.', 'Referencia estacional confiable.']), executor: finish(executorIndicators, executorFailures, executorAvailable, ['80 puntos sin redondear.', '10 asignaciones evaluables.', 'Contacto de al menos 70%.', 'Propuesta de al menos 50%.', 'Registro confiable y referencias de entrega completas, iguales para todos.']) };
    if (balanced) categories.executor.minimums = ['80 puntos sin redondear.', '10 asignaciones evaluables.', 'Contacto de al menos 70% de la lista.', 'Propuesta de al menos 50% de los contactados.', 'Registros revisados y referencias de entrega completas, iguales para todos.'];
    categories.executor.executorContext = {
      formula: balanced ? 'balanced-volume-v1' : 'legacy-v1', evidenceMode, assigned, contact, response: sum('response'),
      proposal: sum('proposal'), delivered: sum('delivered'), uniqueProposals: proposals, uniqueDelivered,
      expectedDeliveries: expected, recordedContact: recordedCounts.reduce((n,c) => n + Number(c.contact), 0),
      recordedResponse: recordedCounts.reduce((n,c) => n + Number(c.response), 0), recordedProposal: recordedCounts.reduce((n,c) => n + Number(c.proposal), 0),
    };
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
