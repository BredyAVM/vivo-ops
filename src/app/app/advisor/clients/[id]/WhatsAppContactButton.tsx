'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { recordClientPlayFollowUpAction } from './actions';

type Props = {
  whatsappHref: string;
  playMemberId: number | null;
  shouldRecordContact: boolean;
  hasContact: boolean;
};

export default function WhatsAppContactButton(props: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function recordInitialContact() {
    if (!props.shouldRecordContact || !props.playMemberId) return;

    setError(null);
    startTransition(async () => {
      const result = await recordClientPlayFollowUpAction({
        playMemberId: props.playMemberId as number,
        action: 'contact',
        channel: 'whatsapp',
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      router.refresh();
    });
  }

  return (
    <div className="min-w-0 flex-1">
      <a
        href={props.whatsappHref}
        target="_blank"
        rel="noreferrer"
        onClick={recordInitialContact}
        className="inline-flex h-11 w-full items-center justify-center rounded-[13px] bg-[#1D6B42] px-4 text-sm font-semibold text-white"
      >
        {pending ? 'Abriendo y registrando…' : props.shouldRecordContact && !props.hasContact ? 'Iniciar contacto' : 'Abrir WhatsApp'}
      </a>
      {error ? <p className="mt-1 text-[10px] leading-4 text-[#F0A6AE]">WhatsApp se abrió, pero no se registró: {error}</p> : null}
    </div>
  );
}
