'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { renderPlayMessage } from '@/lib/crm/play-message';
import { recordClientPlayFollowUpAction } from './actions';

type Props = {
  guidance: string | null;
  template: string;
  clientName: string;
  advisorName: string;
  benefitLabel: string;
  validityLabel: string;
  whatsappBaseHref: string | null;
  playMemberId: number;
  isActive: boolean;
  isCompleted: boolean;
  hasGreetingResponse: boolean;
  isLaunched: boolean;
};

export default function PlayMessageCard(props: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [resultMessage, setResultMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const message = useMemo(() => renderPlayMessage(props.template, {
    clientName: props.clientName,
    advisorName: props.advisorName,
    benefitLabel: props.benefitLabel,
    validityLabel: props.validityLabel,
  }), [props.advisorName, props.benefitLabel, props.clientName, props.template, props.validityLabel]);
  const whatsappHref = props.whatsappBaseHref
    ? `${props.whatsappBaseHref}?text=${encodeURIComponent(message)}`
    : null;
  const canUseMessage = props.isActive && !props.isCompleted && props.hasGreetingResponse;

  async function copyMessage() {
    if (!canUseMessage) return;
    await navigator.clipboard.writeText(message);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function recordLaunch() {
    if (!canUseMessage || props.isLaunched || pending) return;

    setResultMessage(null);
    startTransition(async () => {
      const result = await recordClientPlayFollowUpAction({
        playMemberId: props.playMemberId,
        action: 'launched',
        channel: 'whatsapp',
      });

      setResultMessage({ tone: result.ok ? 'success' : 'danger', text: result.message });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-2.5">
      {props.guidance ? (
        <div className="rounded-[14px] border border-cyan-400/20 bg-cyan-400/[0.05] px-3 py-2.5 text-xs leading-5 text-cyan-50/80">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-200/60">Orientación</div>
          {props.guidance}
        </div>
      ) : null}

      <div className="whitespace-pre-wrap rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 py-3 text-xs leading-5 text-[#E2E6EF]">
        {message}
      </div>

      {!props.isCompleted && props.isActive && !props.hasGreetingResponse ? (
        <div className="rounded-[13px] border border-[#564511] bg-[#2A2209] px-3 py-2.5 text-[10px] leading-4 text-[#F7DA66]">
          Primero abre WhatsApp y saluda al cliente. Cuando responda, marca “Respondió saludo” para habilitar este mensaje.
        </div>
      ) : props.isLaunched ? (
        <div className="rounded-[13px] border border-[#214C73] bg-[#102338] px-3 py-2 text-[10px] text-[#8CC9FF]">
          Jugada lanzada ✓
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={copyMessage}
          disabled={!canUseMessage}
          className="inline-flex h-10 items-center justify-center rounded-[12px] border border-[#F0D000] px-3 text-xs font-semibold text-[#F7DA66] disabled:cursor-not-allowed disabled:border-[#2A3040] disabled:text-[#646D80]"
        >
          {copied ? 'Copiado ✓' : 'Copiar mensaje'}
        </button>
        {whatsappHref && canUseMessage ? (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noreferrer"
            onClick={recordLaunch}
            className="inline-flex h-10 items-center justify-center rounded-[12px] bg-[#1D6B42] px-3 text-xs font-semibold text-white"
          >
            {pending ? 'Registrando…' : props.isLaunched ? 'Abrir mensaje otra vez' : 'Abrir y lanzar'}
          </a>
        ) : (
          <div className="flex h-10 items-center justify-center rounded-[12px] border border-[#2A3040] text-[10px] text-[#747E91]">
            {props.whatsappBaseHref ? 'Esperando respuesta' : 'Sin WhatsApp'}
          </div>
        )}
      </div>
      {canUseMessage && copied && !props.isLaunched ? (
        <button
          type="button"
          onClick={recordLaunch}
          disabled={pending}
          className="w-full text-center text-[10px] font-medium text-[#8CC9FF] underline decoration-[#214C73] underline-offset-2 disabled:opacity-50"
        >
          {pending ? 'Registrando…' : 'Ya lo pegué y envié · marcar como lanzada'}
        </button>
      ) : null}
      {resultMessage ? (
        <div className={`rounded-[13px] border px-3 py-2 text-[10px] ${resultMessage.tone === 'success' ? 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]' : 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]'}`}>
          {resultMessage.text}
        </div>
      ) : null}
      <p className="text-[9px] leading-4 text-[#747E91]">El mensaje queda preparado, pero nunca se envía automáticamente.</p>
    </div>
  );
}
