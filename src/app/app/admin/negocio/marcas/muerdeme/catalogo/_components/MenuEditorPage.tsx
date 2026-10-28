import { notFound } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import WorkspaceForm from '@/components/navigation/WorkspaceForm';
import MuerdemeMenuEditor from '@/components/admin/MuerdemeMenuEditor';
import { loadMuerdemeMenuEditor } from '@/lib/brands/menu-data';
import { menuKindLabels, menuRoot, type MenuKind } from '@/lib/brands/menu-model';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';

export default async function MenuEditorPage({ entryId, kind, query }: { entryId: string | null; kind: MenuKind; query: Record<string, string | undefined> }) {
  let data;
  try { data = await loadMuerdemeMenuEditor(entryId, kind, query.referencias ?? ''); } catch {
    return <div className="space-y-3 text-xs"><p role="alert" className="text-orange-200">No se pudo abrir la configuración. Intenta consultar de nuevo.</p><Link href={menuRoot} prefetch={false} className="text-[#FFFF00]">Volver al catálogo</Link></div>;
  }
  if (!data) notFound();
  const documentKind = data.entry?.document.kind ?? kind;
  const requestedReturn = safeAppReturnHref(query.returnTo);
  const returnTo = requestedReturn && requestedReturn.split('?')[0] === menuRoot ? requestedReturn : menuRoot;
  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold text-[#DEDEE6]">{data.entry ? data.entry.document.name : `Nueva configuración · ${menuKindLabels[documentKind]}`}</h1>
      <Link href={returnTo} prefetch={false} className="inline-flex min-h-11 items-center text-xs text-[#FFFF00]">Volver al catálogo</Link></header>
    {query.guardado === '1' ? <p role="status" className="text-xs text-emerald-200">Preparación guardada. Las ventas siguen deshabilitadas.</p> : null}
    {data.entry ? <p className="text-[11px] text-[#BDBDC7]">Versión {data.entry.revision} · {new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' }).format(new Date(data.entry.updatedAt))}</p> : null}
    {data.lookupHasMore ? <WorkspaceForm method="get" action={entryId ? `${menuRoot}/${entryId}` : `${menuRoot}/nuevo`} className="flex flex-wrap items-end gap-2 text-xs">
      <input type="hidden" name="tipo" value={documentKind} /><input type="hidden" name="returnTo" value={returnTo} />
      <label className="grid min-w-0 flex-1 gap-1 text-[#BDBDC7]">Filtrar opciones para vincular<input name="referencias" defaultValue={query.referencias ?? ''} maxLength={100} className="min-h-11 min-w-0 rounded-lg border border-[#343442] bg-[#14141C] px-2 text-xs md:min-h-8" /></label>
      <button className="min-h-11 rounded-lg border border-[#FFFF00]/40 px-3 text-[#FFFF00] md:min-h-8">Consultar opciones</button>
      <p className="w-full text-[11px] text-amber-200">Se muestran hasta 200 productos. Guarda los cambios antes de filtrar opciones.</p>
    </WorkspaceForm> : null}
    <MuerdemeMenuEditor key={`${entryId ?? documentKind}:${data.entry?.revision ?? 0}`} data={data} kind={documentKind} returnTo={returnTo} />
  </div>;
}
