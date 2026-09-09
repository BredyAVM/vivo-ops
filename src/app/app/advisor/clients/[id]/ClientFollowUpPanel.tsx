'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  recordClientPlayFollowUpAction,
  type PlayFollowUpAction,
} from './actions';

type ClientFollowUpPanelProps = {
  playMemberId: number;
  isActive: boolean;
  workflowStatus: string;
  contactAttemptCount: number;
};

const quickActions: Array<{
  value: Extract<PlayFollowUpAction, 'contact' | 'responded' | 'unreachable'>;
  label: string;
  activeClassName: string;
}> = [
  { value: 'contact', label: 'Jugada lanzada', activeClassName: 'border-[#3C8FD9] bg-[#102338] text-[#8CC9FF]' },
  { value: 'responded', label: 'Respondió', activeClassName: 'border-[#4A3675] bg-[#241A3A] text-[#C9B1FF]' },
  { value: 'unreachable', label: 'No respondió', activeClassName: 'border-[#68401B] bg-[#2F1E0D] text-[#F6B97D]' },
];

export default function ClientFollowUpPanel(props: ClientFollowUpPanelProps) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PlayFollowUpAction | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submitFollowUp(action: PlayFollowUpAction) {
    setMessage(null);
    setPendingAction(action);

    startTransition(async () => {
      const result = await recordClientPlayFollowUpAction({
        playMemberId: props.playMemberId,
        action,
        note,
        followUpAt: action === 'follow_up' && followUpAt
          ? new Date(followUpAt).toISOString()
          : null,
        channel: action === 'contact' || action === 'unreachable' ? 'whatsapp' : null,
      });

      if (!result.ok) {
        setMessage({ tone: 'danger', text: result.message });
        setPendingAction(null);
        return;
      }

      setMessage({ tone: 'success', text: result.message });
      setNote('');
      if (action === 'follow_up') setFollowUpAt('');
      setPendingAction(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-[#AAB2C5]">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#747E91]">Estado</div>
          <div className="mt-1 text-[#F5F7FB]">{props.workflowStatus}</div>
        </div>
        <div className="rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-[#AAB2C5]">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[#747E91]">Intentos</div>
          <div className="mt-1 text-[#F5F7FB]">{props.contactAttemptCount}</div>
        </div>
      </div>

      {!props.isActive ? (
        <div className="rounded-[14px] border border-[#564511] bg-[#2A2209] px-3 py-3 text-xs leading-5 text-[#F7DA66]">
          Esta jugada no está activa. Su foto y su historial siguen visibles, pero no admite nuevos movimientos.
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="text-xs text-[#AAB2C5]">Registro rápido</legend>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {quickActions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => submitFollowUp(option.value)}
                  disabled={pending}
                  className={`inline-flex min-h-11 items-center justify-center rounded-[12px] border px-2 text-center text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${option.activeClassName}`}
                >
                  {pending && pendingAction === option.value ? 'Guardando…' : option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block text-xs text-[#AAB2C5]">
            Nota opcional
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 2000))}
              rows={3}
              placeholder="Qué respondió, qué se acordó o cualquier detalle útil"
              className="mt-1.5 w-full resize-y rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 py-2.5 text-sm leading-5 text-[#F5F7FB] outline-none placeholder:text-[#646D80] focus:border-[#F0D000]"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => submitFollowUp('note')}
              disabled={pending || !note.trim()}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-[12px] border border-[#2A3040] px-3 text-xs font-semibold text-[#D4D9E4] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending && pendingAction === 'note' ? 'Guardando…' : 'Guardar nota'}
            </button>
          </div>

          <details className="rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-medium text-[#AAB2C5]">Programar próximo seguimiento</summary>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label className="min-w-0 flex-1 text-[10px] text-[#8B93A7]">
                Fecha y hora
                <input
                  type="datetime-local"
                  value={followUpAt}
                  onChange={(event) => setFollowUpAt(event.target.value)}
                  className="mt-1 h-10 w-full rounded-[11px] border border-[#2A3040] bg-[#12151D] px-2.5 text-xs text-[#F5F7FB]"
                />
              </label>
              <button
                type="button"
                onClick={() => submitFollowUp('follow_up')}
                disabled={pending || !followUpAt}
                className="mt-auto inline-flex h-10 items-center justify-center rounded-[11px] border border-[#564511] bg-[#2A2209] px-3 text-xs font-semibold text-[#F7DA66] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending && pendingAction === 'follow_up' ? 'Guardando…' : 'Programar'}
              </button>
            </div>
          </details>

          {message ? (
            <div
              role="status"
              className={[
                'rounded-[13px] border px-3 py-2.5 text-xs leading-5',
                message.tone === 'success'
                  ? 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]'
                  : 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
              ].join(' ')}
            >
              {message.text}
            </div>
          ) : null}

        </>
      )}
    </div>
  );
}
