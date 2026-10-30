'use server';

import { requireAuthContext } from '@/lib/auth';
import { isMenuId, isMenuReferenceId } from './menu-model';
import { decodeOrderMenuGraph, parseMenuOrderSelection, readMenuOrderQuote, MUERDEME_DETAIL_PREFIX } from './order-menu';

async function seller() {
  const ctx = await requireAuthContext();
  if (!ctx.roles.some(role => ['admin', 'master', 'advisor'].includes(role))) throw new Error('Requiere permisos de ventas.');
  return ctx;
}
export async function searchMuerdemeOrderMenu(query = '', kind: string | null = null, page = 1) {
  const { supabase } = await seller();
  if (typeof query !== 'string' || query.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 10000
    || (kind !== null && !['burger', 'fries', 'drink', 'combo'].includes(kind))) throw new Error('Revisa los filtros del menú.');
  const { data, error } = await supabase.rpc('muerdeme_order_menu_search_v1', { p_query: query.trim(), p_kind: kind, p_page: page });
  if (error || !data || !Array.isArray(data.rows) || data.rows.length > 25 || typeof data.salesEnabled !== 'boolean'
    || typeof data.hasNext !== 'boolean' || data.page !== page) throw new Error('No se pudo consultar el menú de Muérdeme.');
  const rows = data.rows as { entryId: string; name: string; kind: 'burger' | 'fries' | 'drink' | 'combo'; productId: number | null; fromUsd: number | null }[];
  if (rows.some(row => !isMenuId(row.entryId) || typeof row.name !== 'string' || !['burger', 'fries', 'drink', 'combo'].includes(row.kind)
    || (row.productId !== null && (!Number.isSafeInteger(row.productId) || row.productId <= 0))
    || (row.fromUsd !== null && (typeof row.fromUsd !== 'number' || row.fromUsd < 0)))) throw new Error('El menú recibido está incompleto.');
  return { rows, salesEnabled: data.salesEnabled as boolean, hasNext: data.hasNext as boolean, page };
}
export async function loadMuerdemeOrderMenu(entryId: string) {
  const { supabase } = await seller();
  if (!isMenuId(entryId)) throw new Error('Selecciona un producto válido.');
  const { data, error } = await supabase.rpc('muerdeme_order_menu_graph_v1', { p_entry_id: entryId });
  if (error) throw new Error(error.code === '42501' ? 'Muérdeme está en preparación; administración puede probar su configuración.' : error.code === '22023' ? error.message : 'No se pudo abrir el producto.');
  return decodeOrderMenuGraph(data);
}
export async function quoteMuerdemeOrderProduct(raw: unknown, revisions: Record<string, number>) {
  const { supabase } = await seller();
  const selection = parseMenuOrderSelection(raw);
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions) || Object.keys(revisions).length > 201
    || Object.entries(revisions).some(([id, rev]) => !isMenuReferenceId(id) || !Number.isSafeInteger(rev) || rev < 1)) throw new Error('Vuelve a consultar el producto.');
  const { data, error } = await supabase.rpc('muerdeme_order_quote_v1', { p_selection: selection, p_expected_revisions: revisions });
  if (error) throw new Error(error.code === '40001' || error.code === '22023' ? error.message : 'No se pudo comprobar la configuración de Muérdeme.');
  const quote = readMenuOrderQuote([MUERDEME_DETAIL_PREFIX + JSON.stringify(data)]);
  if (!quote) throw new Error('No se pudo comprobar el precio del producto.');
  return quote;
}
