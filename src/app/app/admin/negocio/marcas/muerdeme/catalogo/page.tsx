import Link from '@/components/navigation/ContextLink';
import WorkspaceForm from '@/components/navigation/WorkspaceForm';
import { loadMuerdemeMenuList } from '@/lib/brands/menu-data';
import { menuKinds, menuKindLabels, menuRoot } from '@/lib/brands/menu-model';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';

export const dynamic = 'force-dynamic';
const input = 'min-h-11 min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-2 text-xs text-[#E4E4EA] md:min-h-8';
export default async function MuerdemeCataloguePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  let result = null;
  let failed = false;
  try { result = await loadMuerdemeMenuList(query); } catch { failed = true; }
  const href = (page: number) => menuRoot + '?' + new URLSearchParams({ consultar: '1', page: String(page),
    ...(query.tipo ? { tipo: query.tipo } : {}), ...(query.q ? { q: query.q } : {}), ...(query.archivados === '1' ? { archivados: '1' } : {}),
  });
  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold text-[#DEDEE6]">Catálogo de Muérdeme</h1>
      {!safeAppReturnHref(query.returnTo) ? <Link href="/app/admin/negocio/marcas" prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Volver a Marcas</Link> : null}</header>
    <details className="rounded-lg border border-[#30303D] bg-[#111117] px-3"><summary className="min-h-11 cursor-pointer content-center text-xs text-[#FFFF00]">Nuevo producto</summary>
      <nav aria-label="Crear producto de Muérdeme" className="flex flex-wrap gap-2 pb-3">{menuKinds.map(kind => <Link key={kind} href={`${menuRoot}/nuevo?tipo=${kind}`} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs text-[#DEDEE6] md:min-h-8">{menuKindLabels[kind]}</Link>)}</nav>
    </details>
    <WorkspaceForm action={menuRoot} method="get" className="flex flex-wrap items-end gap-2 text-xs">
      <input type="hidden" name="consultar" value="1" />
      <label className="grid min-w-0 flex-1 gap-1 text-[#BDBDC7]">Producto<input name="q" maxLength={100} defaultValue={query.q ?? ''} className={input} /></label>
      <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Tipo<select name="tipo" defaultValue={query.tipo ?? ''} className={input}><option value="">Todos</option>{menuKinds.map(kind => <option key={kind} value={kind}>{menuKindLabels[kind]}</option>)}</select></label>
      <label className="inline-flex min-h-11 items-center gap-2 text-[#BDBDC7] md:min-h-8"><input type="checkbox" name="archivados" value="1" defaultChecked={query.archivados === '1'} />Ver archivados</label>
      <button className="min-h-11 rounded-lg border border-[#FFFF00]/40 px-3 text-[#FFFF00] md:min-h-8">Consultar catálogo</button>
    </WorkspaceForm>
    <p className="text-[11px] text-[#BDBDC7]">En preparación. Guardar aquí todavía no habilita ventas.</p>
    {failed ? <p role="alert" className="text-xs text-orange-200">No se pudo consultar el catálogo. Revisa los filtros e intenta de nuevo.</p> : null}
    {!result && !failed ? <p className="text-xs text-[#BDBDC7]">Consulta los productos cuando los necesites o empieza creando uno.</p> : null}
    {result ? <section aria-label="Productos de Muérdeme" className="min-w-0 rounded-xl border border-[#292937] bg-[#111117] p-3">
      {!result.rows.length ? <p className="text-xs text-[#BDBDC7]">No hay productos guardados con estos filtros.</p> : null}
      <div className="divide-y divide-[#292937]">{result.rows.map(row => <Link key={row.entryId} href={`${menuRoot}/${row.entryId}`} prefetch={false} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3 text-xs">
        <span className="min-w-0"><span className="block break-words font-medium text-[#DEDEE6]">{row.name}</span><span className="text-[11px] text-[#BDBDC7]">{menuKindLabels[row.kind]} · {row.variantCount} presentaciones · Versión {row.revision}{row.archived ? ' · Archivado' : ''}{row.missingPrices ? ' · Precio pendiente' : ''}</span></span>
        <span className="text-[#FFFF00]">Configurar →</span>
      </Link>)}</div>
      {result.hasNext || result.page > 1 ? <nav aria-label="Paginación del catálogo" className="mt-3 flex items-center justify-between gap-2 text-xs">
        {result.page > 1 ? <Link href={href(result.page - 1)} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Anterior</Link> : <span />}
        <span className="text-[#BDBDC7]">Página {result.page}</span>{result.hasNext ? <Link href={href(result.page + 1)} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Siguiente</Link> : <span />}
      </nav> : null}
    </section> : null}
  </div>;
}
