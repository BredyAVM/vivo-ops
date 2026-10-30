import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { COLLECTIONS_PATH, collectionQueryRequested, normalizeCollectionFilters, validateCollectionScope } from '@/lib/admin-finance/collections-model';
import { loadCollections, type CollectionsRpcClient } from '@/lib/admin-finance/collections-data';
import { loadCollectionPeople } from '@/lib/admin-finance/collections-people';
import CollectionsOverview from './_components/CollectionsOverview';
import CollectionFiltersForm from './_components/CollectionFiltersForm';

export const dynamic = 'force-dynamic';
export default async function CollectionsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  const params = (await searchParams) ?? {};
  let filters;
  try { filters = normalizeCollectionFilters(params); }
  catch {
    return <section className="space-y-3 rounded-xl border border-amber-300/30 p-4"><h1 className="font-semibold">Revisa las fechas</h1><p className="text-sm">El período debe tener fechas válidas, de menor a mayor.</p><Link href={COLLECTIONS_PATH} className="underline">Volver a Cobranzas</Link></section>;
  }
  const requested = collectionQueryRequested(params);
  let message = '';
  if (requested) {
    try { validateCollectionScope(filters); }
    catch { message = 'Selecciona desde y hasta, o marca expresamente Todo el historial.'; }
  }
  const result = await loadCollections(ctx.supabase as unknown as CollectionsRpcClient, filters, new Date(), requested && !message);
  if (result.status === 'ready') return <CollectionsOverview data={result.data} filters={filters} />;
  if (result.status === 'error') message = result.message;
  let people: { id: string; name: string }[] = [];
  if (params.action === 'people') {
    try { people = await loadCollectionPeople(); }
    catch { message = 'No pudimos cargar los vendedores. Puedes volver a intentarlo sin consultar saldos.'; }
  }
  return <div className="space-y-3">
    <header><h1 className="text-xl font-semibold">Cobranzas</h1><p className="mt-1 text-xs text-zinc-400">Selecciona un período y pulsa Consultar. No se cargan saldos al entrar.</p></header>
    {message && <p role="alert" className="rounded-xl border border-amber-300/30 p-3 text-sm text-amber-100">{message}</p>}
    <CollectionFiltersForm key={JSON.stringify(filters)} filters={filters} people={people} todayIso={new Date().toISOString()} />
  </div>;
}
