'use client';

import { gambitApplicationModes, gambitApplicationScope, type GambitApplicationScope } from '@/lib/crm/play-order';

export default function GambitApplicationFields({ value, onChange, disabled = false }: {
  value: unknown;
  onChange: (value: GambitApplicationScope) => void;
  disabled?: boolean;
}) {
  const modes = gambitApplicationModes(value);
  return (
    <fieldset disabled={disabled} className="my-4 rounded-xl border border-yellow-400/25 bg-yellow-400/5 p-4">
      <legend className="px-1 text-sm font-semibold text-white">Forma de aplicar la jugada</legend>
      <div className="grid gap-3 text-sm text-white">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={modes.discretionary}
            onChange={(event) => onChange(gambitApplicationScope(event.target.checked, modes.crm))} />
          A discreción del asesor
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={modes.crm}
            onChange={(event) => onChange(gambitApplicationScope(modes.discretionary, event.target.checked))} />
          Mediante una jugada del CRM
        </label>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#B7B7C1]">
        {modes.discretionary && modes.crm ? 'Ambas vías habilitadas: selección libre o beneficio validado por el CRM.'
          : modes.discretionary ? 'Aparece en el catálogo para agregarlo libremente, sin vincular una jugada del CRM.'
            : modes.crm ? 'Solo se agrega desde una jugada válida del cliente, no desde el catálogo libre.'
              : 'Sin vías habilitadas: no podrá agregarse en órdenes nuevas.'}
        {' '}Conserva precio, costo para el asesor, comisiones e inventario. Debe estar activo.
      </p>
    </fieldset>
  );
}
