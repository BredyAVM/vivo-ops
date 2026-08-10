'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveAdvisorOrderDraftAction } from './actions';

export default function ArchiveDraftButton({ draftId, label }: { draftId: number; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function archiveDraft() {
    if (!window.confirm(`¿Eliminar ${label}? Esta acción lo quitará de tus pendientes.`)) return;

    setError(null);
    startTransition(async () => {
      try {
        await archiveAdvisorOrderDraftAction(draftId);
        router.refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'No se pudo eliminar el borrador.');
      }
    });
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={archiveDraft}
        disabled={isPending}
        className="inline-flex h-10 w-full items-center justify-center rounded-[14px] border border-[#5E2229] px-3 text-sm font-medium text-[#F0A6AE] disabled:cursor-wait disabled:opacity-60"
      >
        {isPending ? 'Eliminando…' : 'Eliminar'}
      </button>
      {error ? <p className="mt-1.5 text-xs leading-4 text-[#F0A6AE]">{error}</p> : null}
    </div>
  );
}
