'use client';

import { useState, useTransition } from 'react';
import { selectClientPlayBenefitAction } from './actions';

type BenefitOption = {
  id: number;
  productId: number;
  name: string;
  sku: string | null;
  quantity: number;
};

export default function ClientBenefitSelector({
  playMemberId,
  options,
  selectedBenefitId,
  isActive,
}: {
  playMemberId: number;
  options: BenefitOption[];
  selectedBenefitId: number | null;
  isActive: boolean;
}) {
  const [selected, setSelected] = useState(String(selectedBenefitId ?? options[0]?.id ?? ''));
  const [savedBenefitId, setSavedBenefitId] = useState(selectedBenefitId);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function saveSelection() {
    const playBenefitId = Number(selected);
    if (!Number.isFinite(playBenefitId) || playBenefitId <= 0) return;
    setNotice(null);
    startTransition(async () => {
      const result = await selectClientPlayBenefitAction({ playMemberId, playBenefitId });
      setNotice(result.message);
      if (result.ok) setSavedBenefitId(playBenefitId);
    });
  }

  if (options.length === 0) {
    return <div className="text-xs text-[#8B93A7]">Esta jugada no tiene beneficios configurados.</div>;
  }

  return (
    <div className="space-y-2.5">
      <div className="text-[10px] leading-4 text-[#8B93A7]">
        Escoge una sola alternativa para este cliente. Puedes cambiarla mientras el beneficio siga disponible.
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = selected === String(option.id);
          return (
            <label
              key={option.id}
              className={[
                'flex cursor-pointer items-center gap-2.5 rounded-[13px] border px-3 py-2.5 transition',
                active
                  ? 'border-[#F0D000] bg-[#2B2708] text-[#F7DA66]'
                  : 'border-[#2A3040] bg-[#0D1017] text-[#D4D9E4]',
                !isActive ? 'cursor-not-allowed opacity-60' : '',
              ].join(' ')}
            >
              <input
                type="radio"
                name={`play-benefit-${playMemberId}`}
                value={option.id}
                checked={active}
                disabled={!isActive || isPending}
                onChange={(event) => setSelected(event.target.value)}
                className="accent-[#F0D000]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{option.name}</span>
                <span className="mt-0.5 block text-[9px] opacity-65">
                  {option.quantity.toLocaleString('es-VE')} unidad{option.quantity === 1 ? '' : 'es'}{option.sku ? ` · ${option.sku}` : ''}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div role="status" className="text-[10px] text-[#AAB2C5]">{notice}</div>
        <button
          type="button"
          disabled={!isActive || isPending || !selected || savedBenefitId === Number(selected)}
          onClick={saveSelection}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl bg-[#F0D000] px-4 text-xs font-bold text-[#111318] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? 'Guardando…' : savedBenefitId ? 'Cambiar elección' : 'Confirmar elección'}
        </button>
      </div>
    </div>
  );
}
