'use client';

import { useMemo, useState } from 'react';

type Props = {
  guidance: string | null;
  template: string;
  clientName: string;
  advisorName: string;
  benefitLabel: string;
  validityLabel: string;
  whatsappBaseHref: string | null;
};

function renderMessage(template: string, values: Omit<Props, 'guidance' | 'template' | 'whatsappBaseHref'>) {
  return template
    .replaceAll('{nombre}', values.clientName)
    .replaceAll('{asesor}', values.advisorName)
    .replaceAll('{beneficio}', values.benefitLabel)
    .replaceAll('{vigencia}', values.validityLabel);
}

export default function PlayMessageCard(props: Props) {
  const [copied, setCopied] = useState(false);
  const message = useMemo(() => renderMessage(props.template, {
    clientName: props.clientName,
    advisorName: props.advisorName,
    benefitLabel: props.benefitLabel,
    validityLabel: props.validityLabel,
  }), [props.advisorName, props.benefitLabel, props.clientName, props.template, props.validityLabel]);
  const whatsappHref = props.whatsappBaseHref
    ? `${props.whatsappBaseHref}?text=${encodeURIComponent(message)}`
    : null;

  async function copyMessage() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
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

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={copyMessage}
          className="inline-flex h-10 items-center justify-center rounded-[12px] border border-[#F0D000] px-3 text-xs font-semibold text-[#F7DA66]"
        >
          {copied ? 'Copiado ✓' : 'Copiar mensaje'}
        </button>
        {whatsappHref ? (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center justify-center rounded-[12px] bg-[#1D6B42] px-3 text-xs font-semibold text-white"
          >
            Abrir en WhatsApp
          </a>
        ) : (
          <div className="flex h-10 items-center justify-center rounded-[12px] border border-[#2A3040] text-[10px] text-[#747E91]">
            Sin WhatsApp
          </div>
        )}
      </div>
      <p className="text-[9px] leading-4 text-[#747E91]">El mensaje queda preparado, pero nunca se envía automáticamente.</p>
    </div>
  );
}
