import { buildPlayConditions, playLastDayLabel, type PlayConditionsBenefit, type PlayConditionsDefinition } from '@/lib/crm/play-conditions';

export default function PlayConditionsCard({ play, benefits, defaultOpen = true }: {
  play: PlayConditionsDefinition;
  benefits: PlayConditionsBenefit[];
  defaultOpen?: boolean;
}) {
  const conditions = buildPlayConditions(play, benefits);
  return (
    <details open={defaultOpen} className="group/conditions rounded-xl border border-[#343B49] bg-[#0D1017]">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 text-[11px] [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-[#F5F7FB]">Condiciones de la jugada</span>
        <span className="flex items-center gap-2 text-[10px] text-[#AAB2C5]">
          <span>{playLastDayLabel(play.ends_at)}</span>
          <span aria-hidden="true" className="transition group-open/conditions:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="border-t border-[#232632] px-3 py-2">
        {play.status === 'paused' ? <p className="mb-2 text-[11px] text-[#F7DA66]">Jugada pausada: no aplicar el beneficio por ahora.</p> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          {conditions.map((condition) => (
            <div key={condition.label} className="min-w-0">
              <dt className="text-[10px] text-[#8B93A7]">{condition.label}</dt>
              <dd className="mt-0.5 text-[11px] leading-4 text-[#E2E6EF]">{condition.value}</dd>
            </div>
          ))}
        </dl>
        {benefits.length > 0 ? (
          <details className="group/options mt-2 border-t border-[#232632] pt-1">
            <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-[#F7DA66] [&::-webkit-details-marker]:hidden">
              <span>Ver beneficios, ampliaciones y cargo al asesor</span>
              <span aria-hidden="true" className="transition group-open/options:rotate-180">⌄</span>
            </summary>
            <ul className="space-y-2 pb-1">
              {benefits.map((benefit) => (
                <li key={benefit.id} className="rounded-lg border border-[#292E3B] px-2 py-1.5 text-[11px] leading-4">
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                    <span className="font-medium text-[#F5F7FB]">{benefit.quantity.toLocaleString('es-VE')} × {benefit.name}</span>
                    <span className="text-[#AAB2C5]">Cargo asesor: ${benefit.advisorCostUsd.toFixed(2)} por entrega</span>
                  </div>
                  {benefit.upgrades.length > 0 ? (
                    <>
                      <p className="mt-1 text-[#AAB2C5]">Puede entregar el base o usar su beneficio de ${benefit.benefitValueUsd.toFixed(2)} para ampliar a:</p>
                      <ul className="mt-1 space-y-1 text-[#D6DAE4]">
                        {benefit.upgrades.map((upgrade) => <li key={upgrade.id}>{upgrade.name} · {upgrade.customerDifferenceUsd > 0 ? `cliente paga +$${upgrade.customerDifferenceUsd.toFixed(2)}` : 'sin diferencia para el cliente'}</li>)}
                      </ul>
                    </>
                  ) : <p className="mt-1 text-[#8B93A7]">Solo este obsequio; sin ampliaciones.</p>}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="mt-1 text-[10px] leading-4 text-[#8B93A7]">Aplicarlo es opcional. No se convierte en dinero ni en saldo libre.</p>
      </div>
    </details>
  );
}
