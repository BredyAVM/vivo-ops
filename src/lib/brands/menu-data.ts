import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { decodeMenuEditor, isMenuId, isMenuKind, type MenuKind, type MenuListItem } from './menu-model';
import { decodeMenuHistory } from './menu-history';

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
  if (typeof data.salesEnabled !== 'boolean') throw new Error('No se pudo comprobar el estado del catálogo.');
  return { rows, page, hasNext: data.hasNext as boolean, salesEnabled: data.salesEnabled };
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

export async function loadMuerdemeMenuHistory(entryId: string, query: Record<string, string | undefined>) {
  const { supabase } = await requireAdminContext();
  if (!isMenuId(entryId)) throw new Error('Revisa el producto.');
  if (query.consultar !== '1') return null;
  const page = Number(query.page ?? '1');
  if (!/^\d+$/.test(query.page ?? '1') || !Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('Revisa la página del historial.');
  const { data, error } = await supabase.rpc('admin_muerdeme_menu_history_v1', { p_entry_id: entryId, p_page: page });
  if (error) throw new Error('No se pudo consultar el historial del producto.');
  const result = decodeMenuHistory(data);
  if (result.entryId !== entryId || result.page !== page) throw new Error('El historial no corresponde al producto solicitado.');
  return result;
}
