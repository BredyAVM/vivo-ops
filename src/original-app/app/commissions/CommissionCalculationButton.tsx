'use client';

import { useFormStatus } from 'react-dom';

export default function CommissionCalculationButton({ disabled, lastCalculatedLabel }: {
  disabled: boolean;
  lastCalculatedLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <div className="space-y-1.5 md:max-w-[280px]">
      <button
        className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#FFFF00] px-5 text-sm font-semibold text-[#111113] transition enabled:hover:bg-[#FFE44F] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || pending}
        type="submit"
        aria-busy={pending}
      >
        <span aria-hidden="true" className={pending ? 'animate-spin motion-reduce:animate-none' : ''}>↻</span>
        {pending ? 'Actualizando…' : 'Actualizar y calcular'}
      </button>
      <p role="status" aria-live="polite" className="text-[11px] leading-4 text-[#A6A6B0]">
        {pending ? 'Consultando pedidos y pagos validados. Espera el resultado.'
          : `Último cálculo de preliminares: ${lastCalculatedLabel}.`}
      </p>
    </div>
  );
}
