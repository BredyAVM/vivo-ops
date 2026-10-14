import { awardValue, indicatorReference, executorSummary, type CategoryEvaluation } from '@/lib/rewards/evaluation-model';
export default function AwardIndicators({ evaluation }: { evaluation: CategoryEvaluation }) {
  return <div className="space-y-3 text-xs">
    <p className={evaluation.qualified ? 'text-emerald-300' : 'text-amber-200'}>{!evaluation.available ? 'No evaluable en este período.' : evaluation.qualified ? 'Cumples los mínimos para clasificar.' : 'Todavía no cumples todos los mínimos.'} {evaluation.failures.join(' ')}</p>
    {evaluation.executorContext ? <><p>{executorSummary(evaluation.executorContext)}</p>{evaluation.executorContext.evidenceMode === 'supported' ? <p>Estados registrados para comparación: contactos {evaluation.executorContext.recordedContact}, respuestas {evaluation.executorContext.recordedResponse}, propuestas {evaluation.executorContext.recordedProposal}. Propuesta no acredita respuesta; una entrega sí acredita el recorrido.</p> : null}</> : null}
    <p>Metas y referencias reparten los puntos; no sustituyen los mínimos obligatorios. La clasificación utiliza el puntaje sin redondear.</p>
    <p><strong>Mínimos: </strong>{evaluation.minimums.join(' ')}</p>
    <div className="divide-y divide-[#292937]">{evaluation.indicators.map(i => <details key={i.label} className="py-2"><summary className="flex min-h-9 cursor-pointer flex-wrap justify-between gap-2"><span>{i.label} · {awardValue(i.result, i.unit)} / {indicatorReference(i)}</span><span>{i.points.toFixed(2)} / {i.weight} pts</span></summary><p className="mt-2 text-[#AAB2C5]">{i.guidance}</p><p className="mt-1">{i.scoring === 'gradual' ? 'Volumen gradual · peso × clientes / (clientes + referencia). La referencia no es una meta máxima.' : `${i.result === null ? 'Falta base para este indicador.' : i.points < i.weight ? 'Por desarrollar' : 'Meta completa'} · Peso × resultado/meta, limitado al peso máximo.`}</p></details>)}</div>
  </div>;
}
