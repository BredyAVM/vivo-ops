import type { MenuChanges } from '@/lib/brands/menu-history';

const usd = (amount: number | null) => amount === null ? 'Pendiente' : `USD ${amount.toFixed(2).replace('.', ',')}`;
export default function MuerdemeMenuChanges({ changes }: { changes: MenuChanges }) {
  return <div className="min-w-0 space-y-2 text-xs text-[#BDBDC7]">
    <p className="break-words">{changes.labels.join(' · ') || 'Sin cambios de configuración'}</p>
    {changes.prices.length ? <ul className="space-y-1" aria-label="Cambios de precio en USD">{changes.prices.map(price => <li key={price.key} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1">
      <span className="break-words">{price.label}</span>
      <span className="text-[#DEDEE6]">{price.added ? 'Nueva' : usd(price.before)} → {price.removed ? 'Retirada' : usd(price.after)}</span>
    </li>)}</ul> : null}
    {changes.recipeReview.length ? <p className="break-words text-amber-200">Revisar receta antes de vender: {changes.recipeReview.join(', ')}.</p> : null}
  </div>;
}
