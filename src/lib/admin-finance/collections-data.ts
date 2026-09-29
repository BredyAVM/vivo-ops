import 'server-only';
import { parseCollectionsOverview, validateCollectionScope, type CollectionFilters, type CollectionsOverview } from './collections-model';

export type CollectionsRpcClient = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> };
export async function loadCollections(supabase: CollectionsRpcClient, filters: CollectionFilters, now = new Date(), requested = false): Promise<
  { status: 'idle' } | { status: 'ready'; data: CollectionsOverview } | { status: 'error'; message: string }
> {
  if (!requested) return { status: 'idle' };
  try {
    validateCollectionScope(filters);
    const result = await supabase.rpc('admin_collections_read_v1', { p_filters: filters });
    if (result.error) throw new Error(result.error.message || 'Error de consulta.');
    return { status: 'ready', data: parseCollectionsOverview(result.data, now) };
  } catch (error) {
    console.warn('admin collections unavailable', error instanceof Error ? error.message : 'unknown');
    return { status: 'error', message: 'No pudimos verificar los saldos actuales. Intenta actualizar; no se modificó ningún pago.' };
  }
}
