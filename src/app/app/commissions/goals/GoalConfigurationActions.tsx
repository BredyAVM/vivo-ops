'use client';

import { useFormStatus } from 'react-dom';
import GoalActionFeedback from './GoalActionFeedback';

export default function GoalConfigurationActions({ publishedAt, notice, error, feedbackKey, periodName }: {
  publishedAt?: string | null; notice?: string; error?: string; feedbackKey?: string; periodName?: string;
}) {
  const { pending, data } = useFormStatus();
  const publishing = pending && data?.get('intent') === 'publish';
  const savingDraft = pending && !publishing;
  const publishedDate = publishedAt ? new Date(publishedAt) : null;
  const publishedLabel = publishedDate && !Number.isNaN(publishedDate.getTime())
    ? new Intl.DateTimeFormat('es-VE', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZone: 'America/Caracas',
      }).format(publishedDate)
    : null;

  return <div className="space-y-2 md:col-span-2" aria-busy={pending}>
    {!pending ? <GoalActionFeedback key={`${feedbackKey ?? ''}:${notice ?? ''}:${error ?? ''}`}
      notice={notice} error={error} periodName={periodName} /> : null}
    {publishedLabel ? <p className="text-xs leading-5 text-emerald-200">
      Última publicación: {publishedLabel} · visible para los asesores.
      <span className="block text-[11px] text-[#A9A9B4]">Si cambias valores, debes actualizar la publicación para compartirlos.</span>
    </p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <button className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#6A6140] px-4 py-2 text-sm font-semibold text-[#E2D99D] disabled:cursor-wait disabled:opacity-60"
        disabled={pending} name="intent" type="submit" value="draft">
        {savingDraft ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" /> : null}
        {savingDraft ? 'Guardando borrador…' : 'Guardar borrador'}
      </button>
      <button className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#F0D000] px-5 py-2 text-sm font-semibold text-[#111113] hover:bg-[#FFE44F] disabled:cursor-wait disabled:opacity-70"
        disabled={pending} name="intent" type="submit" value="publish">
        {publishing ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" /> : null}
        {publishing ? 'Publicando metas…' : publishedLabel ? 'Actualizar publicación' : 'Publicar meta'}
      </button>
    </div>
    <p role="status" aria-live="polite" aria-atomic="true" className="min-h-4 text-right text-[11px] text-[#D7D0AC]">
      {pending ? publishing
        ? 'Publicando metas y actualizando preliminares. Espera la confirmación; no necesitas pulsar de nuevo.'
        : 'Guardando el borrador. Espera la confirmación; todavía no se publica a los asesores.'
        : ''}
    </p>
  </div>;
}
