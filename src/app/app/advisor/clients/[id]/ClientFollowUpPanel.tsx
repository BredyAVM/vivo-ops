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
  nextFollowUpAt: string | null;
};

const actionOptions: Array<{ value: PlayFollowUpAction; label: string }> = [
  { value: 'contact', label: 'Registrar contacto' },
  { value: 'follow_up', label: 'Programar seguimiento' },
  { value: 'responded', label: 'Respondió' },
  { value: 'accepted', label: 'Aceptó / mostró interés' },
  { value: 'converted', label: 'Se logró la recompra' },
  { value: 'unreachable', label: 'No respondió' },
  { value: 'not_interested', label: 'No está interesado' },
  { value: 'not_applicable', label: 'No aplica para esta jugada' },
  { value: 'closed', label: 'Cerrar seguimiento' },
  { value: 'note', label: 'Agregar solo una nota' },
];

function localDateTimeValue(value: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const offset = parsed.getTimezoneOffset();
  return new Date(parsed.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export default function ClientFollowUpPanel(props: ClientFollowUpPanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<PlayFollowUpAction>('contact');
  const [channel, setChannel] = useState<'whatsapp' | 'call' | 'in_person' | 'other'>('whatsapp');
  const [note, setNote] = useState('');
  const [followUpAt, setFollowUpAt] = useState(localDateTimeValue(props.nextFollowUpAt));
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const canSchedule = action === 'contact' || action === 'follow_up';

  function submitFollowUp() {
    setMessage(null);

    let followUpIso: string | null = null;
    if (canSchedule && followUpAt) {
      const parsed = new Date(followUpAt);
      if (Number.isNaN(parsed.getTime())) {
        setMessage({ tone: 'danger', text: 'Revisa la fecha del próximo seguimiento.' });
        return;
      }
      followUpIso = parsed.toISOString();
    }

    if (action === 'follow_up' && !followUpIso) {
      setMessage({ tone: 'danger', text: 'Indica cuándo debe hacerse el próximo seguimiento.' });
      return;
    }

    startTransition(async () => {
      const result = await recordClientPlayFollowUpAction({
        playMemberId: props.playMemberId,
        action,
        note,
        followUpAt: followUpIso,
        channel: action === 'contact' || action === 'unreachable' ? channel : null,
      });

      if (!result.ok) {
        setMessage({ tone: 'danger', text: result.message });
        return;
      }

      setMessage({ tone: 'success', text: result.message });
      setNote('');
      if (action !== 'follow_up' && action !== 'contact') setFollowUpAt('');
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
          <label className="block text-xs text-[#AAB2C5]">
            ¿Qué ocurrió?
            <select
              value={action}
              onChange={(event) => setAction(event.target.value as PlayFollowUpAction)}
              className="mt-1.5 h-11 w-full rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
            >
              {actionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          {(action === 'contact' || action === 'unreachable') ? (
            <label className="block text-xs text-[#AAB2C5]">
              Canal
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as typeof channel)}
                className="mt-1.5 h-11 w-full rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
              >
                <option value="whatsapp">WhatsApp</option>
                <option value="call">Llamada</option>
                <option value="in_person">En persona</option>
                <option value="other">Otro</option>
              </select>
            </label>
          ) : null}

          {canSchedule ? (
            <label className="block text-xs text-[#AAB2C5]">
              Próximo seguimiento {action === 'follow_up' ? '(obligatorio)' : '(opcional)'}
              <input
                type="datetime-local"
                value={followUpAt}
                onChange={(event) => setFollowUpAt(event.target.value)}
                className="mt-1.5 h-11 w-full rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
              />
            </label>
          ) : null}

          <label className="block text-xs text-[#AAB2C5]">
            Nota {action === 'note' ? '(requerida)' : '(opcional)'}
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 2000))}
              rows={3}
              placeholder="Qué respondió, qué se acordó o cualquier detalle útil"
              className="mt-1.5 w-full resize-y rounded-[13px] border border-[#2A3040] bg-[#0D1017] px-3 py-2.5 text-sm leading-5 text-[#F5F7FB] outline-none placeholder:text-[#646D80] focus:border-[#F0D000]"
            />
          </label>

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

          <button
            type="button"
            onClick={submitFollowUp}
            disabled={pending || (action === 'note' && !note.trim())}
            className="inline-flex h-11 w-full items-center justify-center rounded-[13px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Guardando…' : 'Guardar seguimiento'}
          </button>
        </>
      )}
    </div>
  );
}
