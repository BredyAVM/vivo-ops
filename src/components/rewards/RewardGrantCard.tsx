import type { ReactNode } from 'react';
import { REWARD_CATEGORIES, REWARD_MODES, rewardAmountLabel, rewardRestrictions, rewardGrantState, type RewardGrant } from '@/lib/rewards/wallet-model';

export default function RewardGrantCard({ grant, action, asOf }: { grant: RewardGrant; action?: ReactNode; asOf: Date }) {
  const state = rewardGrantState(grant, asOf);
  const restrictions = rewardRestrictions(grant.terms_snapshot);
  const date = (value: string) => new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
  return <article className="rounded-xl border border-[#292937] bg-[#111117] p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-sm font-semibold">{grant.terms_snapshot.title}</h2><p className="mt-1 text-xs text-[#AAB2C5]">{REWARD_CATEGORIES[grant.terms_snapshot.category]} · {grant.period.slice(0, 7)}</p></div>
      <span className={state.label === 'Vigente' ? 'text-xs text-emerald-200' : 'text-xs text-[#AAB2C5]'}>{state.label}</span>
    </div>
    <p className="mt-2 text-base font-semibold">{rewardAmountLabel({ ...grant.terms_snapshot, amount: grant.amount })}</p>
    <p className="mt-1 text-xs text-[#AAB2C5]">{REWARD_MODES[grant.terms_snapshot.mode]} · {restrictions.uses}</p>
    <p className="mt-1 text-xs text-[#AAB2C5]">{restrictions.products}</p>
    <p className="mt-1 text-xs text-[#AAB2C5]">{grant.expires_on ? 'Último día: ' + grant.expires_on : 'Sin vencimiento'} · No transferible · Sin efectivo.</p>
    <p className="mt-2 text-xs text-amber-100">Premio otorgado. Su aplicación en pedidos aún no está habilitada.</p>
    <details className="mt-2 text-xs"><summary className="cursor-pointer">Motivo e historial</summary><div className="mt-2 space-y-2 text-[#AAB2C5]">
      {grant.events.slice().sort((a,b) => a.created_at.localeCompare(b.created_at)).map(e => <p key={e.event_type}>{e.event_type === 'issued' ? 'Otorgado' : 'Revocado'} · {date(e.created_at)} · {e.reason}</p>)}
      <p>Condiciones conservadas desde la emisión. No son deuda del cliente ni dinero recibido en caja.</p>
    </div></details>
    {action ? <div className="mt-3">{action}</div> : null}
  </article>;
}
