'use client';

import { useState } from 'react';
import { isDeliveryProduct } from '@/lib/crm/benefit-eligibility';

export default function CouponSelector({ cap, options, selected, discount, delivery, disabled, onToggle }: {
  cap: number;
  options: Array<{ playBenefitId: number; name: string; sku?: string | null }>;
  selected: number[];
  discount: number;
  delivery: boolean;
  disabled?: boolean;
  onToggle: (id: number) => void;
}) {
  const [choice, setChoice] = useState('');
  const money = (n: number) => `$${n.toFixed(2)}`;
  return <div className="space-y-2 rounded-xl border border-cyan-300/30 bg-cyan-950/20 p-3">
    <div className="flex flex-wrap justify-between gap-2 text-xs text-cyan-100">
      <strong>Cupón · hasta {money(cap)} en total</strong>
      <span>Aplicado {money(discount)} · disponible {money(Math.max(0, cap - discount))}</span>
    </div>
    <p className="text-[11px] text-cyan-100/75">Combina bebidas y un envío. Comparten el mismo límite; el cliente paga la diferencia. Un solo pedido, sin saldo acumulable.</p>
    <div className="flex gap-2">
      <select aria-label="Bebida o delivery para el cupón" className="min-w-0 flex-1 rounded-lg border border-cyan-300/30 bg-[#101419] px-2 py-2 text-xs text-white"
        value={choice} disabled={disabled} onChange={e => setChoice(e.target.value)}>
        <option value="">Seleccionar bebida o delivery</option>
        {[false, true].map(isDelivery => {
          const available = options.filter(o => !selected.includes(o.playBenefitId) && isDeliveryProduct(o.name, o.sku) === isDelivery);
          return available.length ? <optgroup key={String(isDelivery)} label={isDelivery ? 'Delivery' : 'Bebidas'}>
            {available.map(o => <option key={o.playBenefitId} value={o.playBenefitId}
              disabled={!delivery && isDelivery}>{o.name}{!delivery && isDelivery ? ' · requiere delivery' : ''}</option>)}
          </optgroup> : null;
        })}
      </select>
      <button type="button" disabled={disabled || !choice} className="rounded-lg bg-cyan-200 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40"
        onClick={() => { onToggle(Number(choice)); setChoice(''); }}>Aplicar cupón</button>
    </div>
    {selected.map(id => <div key={id} className="flex items-center justify-between gap-2 text-xs text-cyan-50">
      <span>{options.find(o => o.playBenefitId === id)?.name ?? 'Beneficio seleccionado'}</span>
      <button type="button" disabled={disabled} onClick={() => onToggle(id)} className="rounded-lg border border-cyan-100/20 px-2 py-1 disabled:opacity-40">Quitar</button>
    </div>)}
  </div>;
}
