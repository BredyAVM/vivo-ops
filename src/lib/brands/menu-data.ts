import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { decodeMenuEditor, isMenuId, isMenuKind, type MenuKind, type MenuListItem } from './menu-model';

export async function loadMuerdemeMenuList(query: Record<string, string | undefined>) {
  const { supabase } = await requireAdminContext();
  if (query.consultar !== '1') return null;
  const page = Number(query.page ?? '1');
  if (!/^\d+$/.test(query.page ?? '1') || !Number.isSafeInteger(page) || page < 1 || page > 10000
    || (query.tipo && !isMenuKind(query.tipo)) || (query.q ?? '').length > 100) {
    throw new Error('Revisa los filtros del catálogo.');
  }
  const { data, error } = await supabase.rpc('admin_muerdeme_menu_list_v1', {
    p_query: query.q?.trim() ?? '', p_kind: query.tipo || null, p_page: page, p_archived: query.archivados === '1',
  });
  if (error || !data || data.version !== 'muerdeme-menu-v1' || !Array.isArray(data.rows)
    || data.rows.length > 25 || typeof data.hasNext !== 'boolean' || data.page !== page) {
    throw new Error('No se pudo consultar el catálogo de Muérdeme.');
  }
  const rows = data.rows as MenuListItem[];
  if (rows.some(row => !isMenuId(row.entryId) || !isMenuKind(row.kind) || typeof row.name !== 'string'
    || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.archived !== 'boolean'
    || !Number.isSafeInteger(row.variantCount) || row.variantCount < 1 || row.variantCount > 20
    || !Number.isSafeInteger(row.missingPrices) || row.missingPrices < 0 || row.missingPrices > row.variantCount
    || !Number.isFinite(Date.parse(row.updatedAt)))) throw new Error('La consulta del catálogo está incompleta.');
  return { rows, page, hasNext: data.hasNext as boolean };
}

export async function loadMuerdemeMenuEditor(entryId: string | null, kind: MenuKind, referenceQuery = '') {
  const { supabase } = await requireAdminContext();
  if ((entryId !== null && !isMenuId(entryId)) || !isMenuKind(kind) || referenceQuery.length > 100) {
    throw new Error('Revisa el producto y la búsqueda de opciones.');
  }
  const { data, error } = await supabase.rpc('admin_muerdeme_menu_editor_v1', {
    p_entry_id: entryId, p_kind: kind, p_reference_query: referenceQuery.trim(),
  });
  if (error?.code === 'P0002') return null;
  if (error) throw new Error('No se pudo abrir la configuración del producto.');
  return decodeMenuEditor(data);
}
