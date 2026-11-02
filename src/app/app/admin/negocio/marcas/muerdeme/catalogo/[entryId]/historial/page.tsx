import { notFound } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import MuerdemeMenuChanges from '@/components/admin/MuerdemeMenuChanges';
import { loadMuerdemeMenuHistory } from '@/lib/brands/menu-data';
import { isMenuId, menuRoot } from '@/lib/brands/menu-model';

export const dynamic = 'force-dynamic';
export default async function MuerdemeMenuHistoryPage({ params, searchParams }: {
  params: Promise<{ entryId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { entryId } = await params;
  if (!isMenuId(entryId)) notFound();
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  let data = null, failed = false;
  try { data = await loadMuerdemeMenuHistory(entryId, query); } catch { failed = true; }
  const path = `${menuRoot}/${entryId}`;
  const href = (page: number) => `${path}/historial?consultar=1&page=${page}`;
  return <div className="min-w-0 space-y-3 text-xs">
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h1 className="break-words text-lg font-semibold text-[#DEDEE6]">Historial{data ? ` · ${data.name}` : ' del producto'}</h1>
      <Link href={path} prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Volver al producto</Link>
    </header>
    <p className="text-[#BDBDC7]">Fecha, responsable y cambios por versión. Los pedidos guardados conservan sus condiciones.</p>
    {failed ? <p role="alert" className="text-orange-200">No se pudo consultar el historial. Intenta de nuevo.</p> : null}
    {!data ? <Link href={href(1)} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-[#FFFF00]">Consultar historial</Link> : null}
    {data ? <section aria-label="Versiones del producto" className="min-w-0 divide-y divide-[#30303D] rounded-lg border border-[#30303D] bg-[#111117] px-3">
      {data.rows.map(row => <details key={row.revision} className="min-w-0 py-1">
        <summary className="min-h-11 cursor-pointer content-center break-words text-[#DEDEE6]">Versión {row.revision} · {new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' }).format(new Date(row.createdAt))} · {row.actor}</summary>
        <div className="min-w-0 space-y-2 pb-3">{row.name !== data.name ? <p className="break-words text-[#DEDEE6]">Nombre en esta versión: {row.name}</p> : null}<p className="break-words text-[#BDBDC7]">{row.note ?? 'Sin nota histórica'}</p><MuerdemeMenuChanges changes={row.changes} /></div>
      </details>)}
      {!data.rows.length ? <p className="py-3 text-[#BDBDC7]">No hay versiones en esta página.</p> : null}
    </section> : null}
    {data && (data.hasNext || data.page > 1) ? <nav aria-label="Paginación del historial" className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-[#FFFF00]">
      {data.page > 1 ? <Link href={href(data.page - 1)} prefetch={false} className="inline-flex min-h-11 items-center">Más recientes</Link> : <span />}
      <span className="text-[#BDBDC7]">Página {data.page}</span>
      {data.hasNext ? <Link href={href(data.page + 1)} prefetch={false} className="inline-flex min-h-11 items-center">Versiones anteriores</Link> : null}
    </nav> : null}
  </div>;
}
