import Link from '@/components/navigation/ContextLink';
import { loadAdminCatalogPrices } from '@/lib/admin-config/catalog-prices-data';
import { proposedCatalogUsdPrice } from '@/lib/pricing/catalog-usd-proposal';
import CatalogPricesForm from '@/components/admin/CatalogPricesForm';
import { adminPanel, AdminReadError } from './AdminReadUi';

const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const proposalLabels = {
  inactive: 'Inactivo · sin cambio', recalculate_play: 'Recalcular jugada',
  unmapped: 'Revisar producto', changed_since_audit: 'Precio cambió · revisar',
};

export default async function CatalogPrices({ query }: { query: Record<string, string | string[] | undefined> }) {
  const page = Math.max(1, Math.min(10000, Math.trunc(Number(query.page) || 1)));
  const showProposal = query.propuesta === 'usd';
  let data;
  try { data = await loadAdminCatalogPrices(query.consultar === '1', page); }
  catch { return <AdminReadError title="Precios de catálogo" message="No se pudo consultar la lista; ningún precio fue modificado." />; }
  const href = (page: number, proposal = showProposal) => '/app/admin/inventario/prices?' + new URLSearchParams({
    consultar: '1', page: String(page), ...(proposal ? { propuesta: 'usd' } : {}),
  });
  return <div className="space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">{showProposal ? 'Propuesta de precios USD' : 'Actualizar precios en lista'}</h2>
      <Link href={href(1, !showProposal)} prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00] underline">
        {showProposal ? 'Ver precios vigentes' : 'Ver propuesta USD'}
      </Link>
    </header>
    {showProposal ? <p className="text-xs text-[#B7B7C2]">Solo consulta. La propuesta no cambia el catálogo, las órdenes ni las condiciones acordadas.</p> : null}
    {data ? <section className={adminPanel}>
      {showProposal ? <div className="divide-y divide-[#292937]">{data.rows.map(row => {
        const proposal = proposedCatalogUsdPrice(row);
        const label = proposal.amountUsd == null
          ? proposalLabels[proposal.kind as keyof typeof proposalLabels] : `USD ${money.format(proposal.amountUsd)}`;
        return <article key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2 text-xs">
          <span className="min-w-0 break-words">{row.name}</span>
          <span className="text-right tabular-nums text-[#FFFF00]">{label}</span>
          <span className="col-span-2 text-[#B7B7C2]">Vigente: {row.currency === 'VES' ? 'Bs' : 'USD'} {money.format(row.amount)}</span>
        </article>;
      })}</div> : <CatalogPricesForm key={JSON.stringify(data.rows)} rows={data.rows} />}
      <nav aria-label="Páginas de precios" className="mt-3 flex justify-between gap-2 text-xs">
        {page > 1 ? <Link href={href(page - 1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Anterior</Link> : <span />}
        <span className="content-center">Página {page}</span>
        {data.hasNext ? <Link href={href(page + 1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Siguiente</Link> : <span />}
      </nav>
    </section> : <Link href={href(1)} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar precios →</Link>}
  </div>;
}
