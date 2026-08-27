'use client';

import { useMemo, useState, useTransition } from 'react';
import { selectClientPlayBenefitAction } from './actions';

type BenefitOption = {
  id: number;
  productId: number;
  name: string;
  sku: string | null;
  quantity: number;
  unitAdvisorCostUsd: number;
};

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function selectionKey(ids: number[]) {
  return [...ids].sort((left, right) => left - right).join(',');
}

export default function ClientBenefitSelector({
  playMemberId,
  options,
  selectedBenefitIds,
  selectionMode,
  purchaseRequirementMode,
  minimumOrderAmountUsd,
  isActive,
}: {
  playMemberId: number;
  options: BenefitOption[];
  selectedBenefitIds: number[];
  selectionMode: 'single' | 'multiple';
  purchaseRequirementMode: 'none' | 'minimum_order';
  minimumOrderAmountUsd: number | null;
  isActive: boolean;
}) {
  const initialIds = selectedBenefitIds.length > 0
    ? selectedBenefitIds
    : options[0]?.id
      ? [options[0].id]
      : [];
  const [selected, setSelected] = useState<number[]>(initialIds);
  const [savedIds, setSavedIds] = useState<number[]>(selectedBenefitIds);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const advisorChargeUsd = useMemo(() => selected.reduce((sum, benefitId) => {
    const option = options.find((candidate) => candidate.id === benefitId);
    return sum + (option ? option.quantity * option.unitAdvisorCostUsd : 0);
  }, 0), [options, selected]);

  function toggle(optionId: number) {
    if (selectionMode === 'single') {
      setSelected([optionId]);
      return;
    }
    setSelected((current) => current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId]);
  }

  function saveSelection() {
    if (selected.length === 0) {
      setNotice('Selecciona al menos un beneficio.');
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const result = await selectClientPlayBenefitAction({
        playMemberId,
        playBenefitIds: selected,
      });
      setNotice(result.message);
      if (result.ok) setSavedIds(selected);
    });
  }

  if (options.length === 0) {
    return <div className="text-xs text-[#8B93A7]">Esta jugada no tiene beneficios configurados.</div>;
  }

  return (
    <div className="space-y-2.5">
      <div className="text-[10px] leading-4 text-[#8B93A7]">
        {selectionMode === 'multiple'
          ? 'Puedes escoger uno o varios beneficios de esta jugada.'
          : 'Escoge una sola alternativa para este cliente.'}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = selected.includes(option.id);
          const optionCharge = option.quantity * option.unitAdvisorCostUsd;
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
                type={selectionMode === 'multiple' ? 'checkbox' : 'radio'}
                name={`play-benefit-${playMemberId}`}
                value={option.id}
                checked={active}
                disabled={!isActive || isPending}
                onChange={() => toggle(option.id)}
                className="accent-[#F0D000]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{option.name}</span>
                <span className="mt-0.5 block text-[9px] opacity-65">
                  {option.quantity.toLocaleString('es-VE')} unidad{option.quantity === 1 ? '' : 'es'}{option.sku ? ` · ${option.sku}` : ''}
                </span>
                <span className="mt-1 block text-[10px] font-semibold">
                  Cargo en tu comisión: {moneyFormatter.format(optionCharge)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="rounded-xl border border-[#2A3040] bg-[#0D1017] px-3 py-2 text-[10px] text-[#AAB2C5]">
        <div className="flex items-center justify-between gap-3">
          <span>Cargo total seleccionado</span>
          <strong className="text-[#F7DA66]">{moneyFormatter.format(advisorChargeUsd)}</strong>
        </div>
        <div className="mt-1 text-[9px] text-[#747E91]">
          {purchaseRequirementMode === 'minimum_order'
            ? `Disponible únicamente en una orden con compra mínima de ${moneyFormatter.format(minimumOrderAmountUsd ?? 0)}.`
            : 'No requiere una compra mínima para aplicarse.'}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div role="status" className="text-[10px] text-[#AAB2C5]">{notice}</div>
        <button
          type="button"
          disabled={!isActive || isPending || selected.length === 0 || selectionKey(savedIds) === selectionKey(selected)}
          onClick={saveSelection}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl bg-[#F0D000] px-4 text-xs font-bold text-[#111318] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? 'Guardando…' : savedIds.length > 0 ? 'Cambiar elección' : 'Confirmar elección'}
        </button>
      </div>
    </div>
  );
}
