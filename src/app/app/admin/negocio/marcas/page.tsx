import Link from '@/components/navigation/ContextLink';
import WorkspaceForm from '@/components/navigation/WorkspaceForm';
import BrandIncentiveForm from '@/components/admin/BrandIncentiveForm';
import { loadCommercialFoundation } from '@/lib/brands/data';
import type { CommercialFoundation } from '@/lib/brands/model';
import { adminInput, adminPanel } from '../../_components/AdminReadUi';

export const dynamic = 'force-dynamic';
const root = '/app/admin/negocio/marcas';
const money = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 6 });
const date = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });

export default async function CommercialBrandsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  let data: CommercialFoundation | null = null;
  let failed = false;
  try { data = await loadCommercialFoundation(query); } catch { failed = true; }
  const href = (page: number) => root + '?' + new URLSearchParams({
    consultar: '1', catalogo: '1', page: String(page), ...(query.marca ? { marca: query.marca } : {}), ...(query.q ? { q: query.q } : {}),
  });
  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-lg font-semibold text-[#DEDEE6]">Marcas y Muérdeme</h1>
      <Link href="/app/admin/negocio" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Volver a Negocio</Link>
    </header>
    <WorkspaceForm action={root} method="get" className={`${adminPanel} flex flex-wrap items-end gap-2 text-xs`}>
      <input type="hidden" name="consultar" value="1" />
      <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Marca
        <select name="marca" defaultValue={query.marca ?? ''} className={adminInput}>
          <option value="">Todas</option><option value="vivo">VIVO Fritos</option><option value="muerdeme">Muérdeme</option>
        </select>
      </label>
      <label className="grid min-w-0 flex-1 gap-1 text-[#BDBDC7]">Producto
        <input name="q" defaultValue={query.q ?? ''} maxLength={100} className={adminInput} />
      </label>
      <label className="inline-flex min-h-11 items-center gap-2 text-[#BDBDC7] md:min-h-8">
        <input type="checkbox" name="catalogo" value="1" defaultChecked={query.catalogo === '1'} />Incluir catálogo
      </label>
      <button className="min-h-11 rounded-lg border border-[#FFFF00]/40 px-3 text-[#FFFF00] md:min-h-8">Consultar marcas</button>
    </WorkspaceForm>
    {failed ? <p role="alert" className="text-xs text-orange-200">No se pudo consultar la base de marcas. Intenta consultar de nuevo.</p> : null}
    {!data && !failed ? <p className="text-xs text-[#BDBDC7]">Consulta la preparación de Muérdeme. El catálogo se carga solo si lo seleccionas.</p> : null}
    {data ? <>
      <section aria-label="Estado de las marcas" className="grid min-w-0 gap-2 sm:grid-cols-2">
        {data.brands.map(brand => <article key={brand.code} className={adminPanel}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <h2 className="font-medium text-[#DEDEE6]">{brand.name}</h2>
            <span className={`text-xs ${brand.salesEnabled ? 'text-emerald-200' : 'text-amber-200'}`}>{brand.salesEnabled ? 'En operación' : 'En preparación'}</span>
          </div>
          {brand.code === 'vivo' ? <p className="mt-2 text-xs text-[#BDBDC7]">Conserva su catálogo y reglas comerciales actuales.</p> : null}
          {brand.incentivePolicy ? <div className="mt-3 space-y-3">
            <p className="text-xs text-[#BDBDC7]">Estímulo por pedido con hamburguesa gestionado por asesor. Los importes están en preparación; todavía no generan liquidaciones.</p>
            {!brand.salesEnabled ? <BrandIncentiveForm policy={brand.incentivePolicy} /> : null}
            <p className="text-[11px] text-[#BDBDC7]">Versión {brand.incentivePolicy.revision} · {date.format(new Date(brand.incentivePolicy.createdAt))}</p>
          </div> : null}
        </article>)}
      </section>
      {query.catalogo === '1' ? <section className={adminPanel}>
        <h2 className="mb-2 text-sm font-medium text-[#DEDEE6]">Catálogo por marca</h2>
        <div className="divide-y divide-[#292937]">{data.catalog.map(item => <article key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-xs">
          <div className="min-w-0"><p className="break-words text-[#DEDEE6]">{item.name}</p><p className="text-[11px] text-[#BDBDC7]">{item.brandCode === 'vivo' ? 'VIVO Fritos' : 'Muérdeme'} · {item.isActive ? 'Activo' : 'Inactivo'}</p></div>
          <span className="shrink-0 tabular-nums text-[#DEDEE6]">{item.currency === 'USD' ? 'USD' : 'Bs'} {money.format(item.amount)}</span>
        </article>)}</div>
        {!data.catalog.length ? <p className="text-xs text-[#BDBDC7]">No hay productos con estos filtros. El menú de Muérdeme aún no se ha cargado.</p> : null}
        {data.hasNext || data.page > 1 ? <nav aria-label="Paginación del catálogo" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          {data.page > 1 ? <Link href={href(data.page - 1)} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Anterior</Link> : <span />}
          <span className="text-[#BDBDC7]">Página {data.page}</span>
          {data.hasNext ? <Link href={href(data.page + 1)} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Siguiente</Link> : <span />}
        </nav> : null}
      </section> : null}
    </> : null}
  </div>;
}
