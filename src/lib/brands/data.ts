import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { decodeCommercialFoundation, parseBrandFoundationFilters } from './model';

export async function loadCommercialFoundation(params: Record<string, string | undefined>) {
  const { supabase } = await requireAdminContext();
  if (params.consultar !== '1') return null;
  const filters = parseBrandFoundationFilters(params);
  const { data, error } = await supabase.rpc('admin_commercial_foundation_read_v1', {
    p_include_catalog: filters.includeCatalog,
    p_brand_code: filters.brandCode,
    p_query: filters.query,
    p_page: filters.page,
  });
  if (error) throw new Error('No se pudo consultar la configuración de marcas.');
  return decodeCommercialFoundation(data);
}
