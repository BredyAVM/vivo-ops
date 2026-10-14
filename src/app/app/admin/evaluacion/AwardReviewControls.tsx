'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { prepareAwardReview, publishAwardReview, resumeAwardReview } from './actions';
import { balancedExecutorRules, deliveryTargetsForDays, validateAwardPeriodRules, type AwardRules } from '@/lib/rewards/evaluation-model';
const field = 'ml-2 min-h-10 rounded-lg border border-[#303040] bg-[#0B0B10] px-2';
export default function AwardReviewControls({ period, initialRules, plays, report, currentPublication, isClosed }: {
  period: string; initialRules: AwardRules; plays: { id: number; name: string; available_days: number }[];
  report?: { id: string; status: string }; currentPublication: string | null; isClosed: boolean;
}) {
  const [rules, setRules] = useState(initialRules);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [baseDeliveryPct, setBaseDeliveryPct] = useState(40);
  const [pending, startTransition] = useTransition();
  const token = useRef<string | null>(null);
  const router = useRouter();
  const september = period === '2026-09';
  const balanced = rules.executorFormula === 'balanced-volume-v1';
  const change = (value: AwardRules) => { setRules(value); token.current = null; };
  return <section className="space-y-3 rounded-lg border border-[#292937] bg-[#111117] p-3 text-xs">
    <h2 className="text-sm font-semibold">Parámetros y cierre mensual</h2>
    <fieldset disabled={pending || Boolean(report)} className="space-y-2 disabled:opacity-70">
      <label className="block">Mínimo global del Asesor del Mes · confirmar<input aria-label="Mínimo global del Asesor del Mes" type="number" min="1" max="100" step="0.01" value={rules.globalMinimum} className={field + ' w-20'} onChange={e => change({ ...rules, globalMinimum: Number(e.target.value) })} /></label>
      <p>Se exige además clasificar en al menos una categoría. Los mínimos de cada categoría permanecen como se definieron.</p>
      <label className="block">Fórmula de Ejecutor<select aria-label="Fórmula de Ejecutor" className={field} value={rules.executorFormula ?? 'legacy-v1'} onChange={e => change(e.target.value === 'balanced-volume-v1' ? balancedExecutorRules(rules) : { ...rules, executorFormula: 'legacy-v1' })}><option value="balanced-volume-v1">Reformado · efectividad y volumen</option><option value="legacy-v1">Anterior · porcentajes sobre lista</option></select></label>
      {balanced ? <>
        <label className="block">Base de registros<select aria-label="Base de registros" className={field} value={rules.executorEvidenceMode ?? 'supported'} onChange={e => change({ ...rules, executorEvidenceMode: e.target.value as 'supported' | 'recorded' })}><option value="supported">Respaldados · respuesta directa o entrega</option><option value="recorded">Estados registrados · incluye inferidos</option></select></label>
        <p>Contacto / lista; respuesta y propuesta / contactados. Una propuesta acredita contacto, no respuesta. Las entregas confirman el recorrido previo. Registros directos no equivalen a mensajes verificados.</p>
        {rules.executorEvidenceMode === 'recorded' ? <p className="text-amber-200">Comparación con estados registrados: puede contar como respuesta la inferencia automática al lanzar una propuesta.</p> : null}
        <details><summary className="min-h-9 cursor-pointer">Volumen gradual · parámetros de la reforma</summary><div className="space-y-2">
          <p>Entrega: {32 * (1 - (rules.executorDeliveryVolumeSharePct ?? 25) / 100)} puntos de cumplimiento y {32 * (rules.executorDeliveryVolumeSharePct ?? 25) / 100} de volumen. Propuestas únicas: 20 puntos de volumen. Fórmula gradual: peso × clientes / (clientes + referencia); sin corte en 30.</p>
          <label className="block">Parte de entrega dedicada a volumen<input aria-label="Parte de entrega dedicada a volumen" type="number" min="1" max="50" step="1" className={field + ' w-20'} value={rules.executorDeliveryVolumeSharePct ?? 25} onChange={e => change({ ...rules, executorDeliveryVolumeSharePct: Number(e.target.value) })} />%</label>
          <label className="block">Clientes para mitad de puntos · entregas<input aria-label="Referencia gradual de entregas" type="number" min="1" max="1000" step="1" className={field + ' w-20'} value={rules.executorDeliveryVolumeReference ?? 10} onChange={e => change({ ...rules, executorDeliveryVolumeReference: Number(e.target.value) })} /></label>
          <label className="block">Clientes para mitad de puntos · propuestas<input aria-label="Referencia gradual de propuestas" type="number" min="1" max="1000" step="1" className={field + ' w-20'} value={rules.executorProposalVolumeReference ?? 10} onChange={e => change({ ...rules, executorProposalVolumeReference: Number(e.target.value) })} /></label>
          <p>Con referencia 10: 10 clientes dan 50% de los puntos de volumen; 30 dan 75%. Después sigue sumando, con incrementos menores. Estos parámetros se congelan al guardar el corte.</p>
        </div></details>
      </> : <p>Fórmula anterior: contacto, respuesta y propuesta se dividen entre la lista. Volumen de propuestas llega al máximo con 30 clientes.</p>}
      <label className="block">Referencia de contacto · puntos completos<input aria-label="Referencia de contacto" type="number" min="1" max="100" step="0.01" value={rules.contactTargetPct ?? 90} className={field + ' w-20'} onChange={e => change({ ...rules, contactTargetPct: Number(e.target.value) })} />%</label>
      <p>Contacto no baja por días disponibles ni obliga a entregar un obsequio. Propuesta conserva su referencia del 70%. Mínimos: contacto 70% de la lista y propuesta 50% {balanced ? 'de los contactados' : 'de la lista'}, además de los otros requisitos.</p>
      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={rules.executorEnabled} onChange={e => change({ ...rules, executorEnabled: e.target.checked })} />Incluir Ejecutor · registros revisados y aceptados</label>
      {september ? <p className="text-amber-200">Septiembre tuvo fallas de registro. Incluirlo requiere dejar por escrito la aceptación de sus limitaciones; no convierte los estados reconstruidos en respuestas comprobadas.</p> : null}
      {rules.executorEnabled ? <label className="block">Observaciones de la revisión de Ejecutor{september ? ' · obligatorio para septiembre' : ''}<textarea aria-label="Observaciones de la revisión de Ejecutor" className="mt-1 w-full rounded-lg border border-[#303040] bg-[#0B0B10] p-2" rows={2} minLength={september ? 10 : undefined} maxLength={500} value={rules.executorReviewNote ?? ''} onChange={e => change({ ...rules, executorReviewNote: e.target.value })} /></label> : <label className="block">Justificación de la exclusión de Ejecutor<textarea aria-label="Justificación de la exclusión de Ejecutor" className="mt-1 w-full rounded-lg border border-[#303040] bg-[#0B0B10] p-2" rows={2} minLength={10} maxLength={500} value={rules.executorReason} onChange={e => change({ ...rules, executorReason: e.target.value })} /></label>}
      <div className="flex flex-wrap items-center gap-2"><label>Referencia de entrega para 30 días<input aria-label="Referencia de entrega para 30 días" type="number" min="0.01" max="100" step="0.01" value={baseDeliveryPct} className={field + ' w-20'} onChange={e => setBaseDeliveryPct(Number(e.target.value))} />%</label><button type="button" className="min-h-10 rounded-lg border border-yellow-300/40 px-3 text-yellow-200" disabled={!plays.length} onClick={() => { try { change({ ...rules, deliveryTargets: deliveryTargetsForDays(plays, baseDeliveryPct) }); setMessage('Referencias calculadas según días disponibles. Contacto, respuesta y propuesta no cambian. Pulsa Probar parámetros para revisar el resultado.'); } catch (e) { setMessage(e instanceof Error ? e.message : 'Referencia inválida.'); } }}>Calcular referencias por días</button></div>
      <details><summary className="min-h-9 cursor-pointer">Referencias de entrega por campaña · {plays.length}</summary><div className="mt-2 space-y-2"><p>Meta porcentual de clientes que reciben el beneficio. Igual para todos: solo ajusta el cumplimiento temporal de entrega, nunca el volumen, contacto, respuesta o propuesta. No se toma la tasa observada como meta automática.</p>{plays.map(p => <label key={p.id} className="flex flex-wrap items-center gap-2">{p.name} · {p.available_days} días disponibles<input aria-label={'Meta de entrega ' + p.name} type="number" min="0.01" max="100" step="0.01" className={field + ' w-20'} value={rules.deliveryTargets[String(p.id)] ?? ''} onChange={e => { const targets = { ...rules.deliveryTargets }; if (e.target.value) targets[String(p.id)] = Number(e.target.value); else delete targets[String(p.id)]; change({ ...rules, deliveryTargets: targets }); }} />%</label>)}</div></details>
    </fieldset>
    {!report ? <div className="flex flex-wrap gap-2"><button disabled={pending} className="min-h-10 rounded-lg border border-yellow-300/40 px-3 text-yellow-200" onClick={() => { const invalid = validateAwardPeriodRules(period, rules); if (invalid) { setMessage(invalid); return; } router.push('/app/admin/evaluacion?' + new URLSearchParams({ month: period, evaluate: '1', rules: JSON.stringify(rules) })); }}>Probar parámetros</button><button disabled={pending} className="min-h-10 rounded-lg bg-yellow-300 px-3 font-semibold text-black" onClick={() => { const invalid = validateAwardPeriodRules(period, rules); if (invalid) { setMessage(invalid); return; } token.current ??= crypto.randomUUID(); const request = token.current; startTransition(async () => { const r = await prepareAwardReview(period, rules, request); setMessage(r.message); if (r.ok && r.reportId) router.push('/app/admin/evaluacion?month=' + period + '&report=' + r.reportId); }); }}>Guardar corte para revisar</button></div> : <>
      <p>Corte guardado · {report.status === 'published' ? 'Publicado' : report.status === 'superseded' ? 'Reemplazado por una corrección' : report.status === 'draft' ? 'Pendiente de cálculo' : 'Listo para revisar'}. Datos y reglas no se sobrescriben.</p>
      {rules.executorEnabled && rules.executorReviewNote ? <p className="text-amber-200">Observación guardada: {rules.executorReviewNote}</p> : null}
      {report.status === 'draft' ? <button disabled={pending} className="min-h-10 rounded-lg border border-yellow-300/40 px-3" onClick={() => startTransition(async () => { const r = await resumeAwardReview(report.id); setMessage(r.message); if (r.ok) router.refresh(); })}>Completar cálculo del corte</button> : null}
      <a className="inline-flex min-h-10 items-center text-yellow-200" href={'/app/admin/evaluacion?' + new URLSearchParams({ month: period, evaluate: '1', rules: JSON.stringify(rules) })}>Crear una revisión nueva / corregir el corte</a>
      {report.status === 'review' ? <form className="space-y-2" onSubmit={e => { e.preventDefault(); startTransition(async () => { const r = await publishAwardReview(report.id, currentPublication, reason, confirmed); setMessage(r.message); if (r.ok) router.refresh(); }); }}>
        {currentPublication ? <p className="text-amber-200">Hay resultados publicados. Esta corrección los reemplazará conservando el corte anterior y su motivo en el historial.</p> : null}
        <label className="block">Motivo del cierre o corrección<textarea required disabled={pending} rows={2} minLength={10} maxLength={500} className="mt-1 w-full rounded-lg border border-[#303040] bg-[#0B0B10] p-2" value={reason} onChange={e => setReason(e.target.value)} /></label>
        <label className="flex min-h-10 items-center gap-2"><input required type="checkbox" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} />Revisé mínimos, referencias, exclusiones, empate/desierto y resultados; autorizo este cierre.</label>
        <button disabled={pending || !isClosed} className="min-h-10 rounded-lg bg-yellow-300 px-3 font-semibold text-black disabled:opacity-50">{pending ? 'Publicando…' : 'Cerrar y publicar para los asesores'}</button>
        {!isClosed ? <p>El mes está en curso. Puedes guardar revisiones, pero no publicar un cierre definitivo.</p> : null}
        <p>No emite crédito, productos ni acceso a Overdrive. La entrega de premios se administra por separado.</p>
      </form> : null}
    </>}
    {message ? <p role="status" aria-live="polite" className="text-amber-200">{message}</p> : null}
  </section>;
}
