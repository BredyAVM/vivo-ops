'use client';

import { useActionState, useRef } from 'react';
import { saveBrandIncentiveDraft, type BrandIncentiveState } from '@/lib/brands/actions';
import type { BrandIncentivePolicy } from '@/lib/brands/model';

const input = 'min-h-11 min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-3 text-xs text-[#E4E4EA] md:min-h-8';

export default function BrandIncentiveForm({ policy }: { policy: BrandIncentivePolicy }) {
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const [state, action, pending] = useActionState(async (previous: BrandIncentiveState, form: FormData) => {
    const payload = JSON.stringify(Array.from(form.entries()).filter(([key]) => !key.startsWith('$ACTION_')));
    if (!attempt.current || attempt.current.payload !== payload) {
      attempt.current = { payload, id: crypto.randomUUID() };
    }
    form.set('operationId', attempt.current.id);
    const result = await saveBrandIncentiveDraft(previous, form);
    if (result.ok) attempt.current = null;
    return result;
  }, { ok: false, message: '' });

  return <form action={action} className="space-y-2 text-xs">
    <fieldset key={policy.revision} disabled={pending} className="min-w-0 space-y-3">
      <input type="hidden" name="revision" value={policy.revision} />
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Primer pedido · USD
          <input className={input} name="firstOrderUsd" inputMode="decimal" required maxLength={12}
            defaultValue={String(policy.firstOrderUsd).replace('.', ',')} onFocus={event => event.currentTarget.select()} />
        </label>
        <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Pedido recurrente · USD
          <input className={input} name="recurrentOrderUsd" inputMode="decimal" required maxLength={12}
            defaultValue={String(policy.recurrentOrderUsd).replace('.', ',')} onFocus={event => event.currentTarget.select()} />
        </label>
      </div>
      <button disabled={pending} className="min-h-11 rounded-lg bg-[#FFFF00] px-3 font-semibold text-black disabled:opacity-50 md:min-h-8">
        {pending ? 'Guardando…' : 'Guardar importes'}
      </button>
    </fieldset>
    {state.message ? <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-emerald-200' : 'text-orange-200'}>{state.message}</p> : null}
  </form>;
}
