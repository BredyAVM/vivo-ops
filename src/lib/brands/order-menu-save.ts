import 'server-only';
import type { AuthContext } from '@/lib/auth';
import { hasMenuOrderDetails, menuQuoteDetailLines, readMenuOrderQuote, type MenuOrderQuote } from './order-menu';
import { readMenuStockSnapshot, MUERDEME_STOCK_PREFIX } from './inventory-menu';

type Item = {
  productId: number; qty: number; sourcePriceCurrency?: string; sourcePriceAmount?: number;
  editableDetailLines: string[]; adminPriceOverrideUsd?: number | null;
  crmPlayMemberId?: number | null; rewardGrantId?: number | null;
};
/** No query at all for VIVO-only orders. Runs before any client or order write. */
export async function verifyMuerdemeOrderItems(supabase: AuthContext['supabase'], items: Item[], orderId?: number | null) {
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object')) throw new Error('Revisa los productos del pedido.');
  const configured = items.filter(item => hasMenuOrderDetails(item.editableDetailLines));
  const quotes = new Map<number, MenuOrderQuote>();
  if (!configured.length) return quotes;
  if (orderId != null && (!Number.isSafeInteger(orderId) || orderId <= 0)) throw new Error('Revisa la orden que estás modificando.');
  if (configured.length > 60) throw new Error('Se admiten hasta 60 productos configurados de Muérdeme por pedido.');
  const { data: status, error: statusError } = await supabase.rpc('muerdeme_order_menu_search_v1', { p_query: '', p_kind: null, p_page: 1 });
  if (statusError || !status) throw new Error('No se pudo verificar la disponibilidad de Muérdeme.');
  if (status.salesEnabled !== true) throw new Error('Muérdeme está en preparación. Retira sus productos para guardar solo VIVO; la apertura comercial sigue pendiente.');
  const unique = new Map(configured.map(item => [JSON.stringify(readMenuOrderQuote(item.editableDetailLines)), item]));
  const canonical = new Map<string, MenuOrderQuote>();
  const jobs = [...unique.entries()];
  for (let start = 0; start < jobs.length; start += 4) await Promise.all(jobs.slice(start, start + 4).map(async ([key, item]) => {
    const quote = readMenuOrderQuote(item.editableDetailLines)!;
    const { data, error } = await supabase.rpc('muerdeme_order_quote_v1', { p_selection: quote.selection, p_expected_revisions: quote.revisions });
    if (error || !data) throw new Error(error?.code === '40001' ? 'El menú cambió. Vuelve a configurar los productos de Muérdeme.' : 'No se pudo verificar la configuración de Muérdeme.');
    const saved = readMenuOrderQuote(['@muerdeme|' + JSON.stringify(data)])!;
    if (saved.productId !== quote.productId || saved.title !== quote.title || saved.unitUsd !== quote.unitUsd
      || JSON.stringify(saved.detailLines) !== JSON.stringify(quote.detailLines)) throw new Error('La configuración o el precio de Muérdeme cambió. Vuelve a consultarlo.');
    canonical.set(key, saved);
  }));
  for (const item of configured) {
    const quote = canonical.get(JSON.stringify(readMenuOrderQuote(item.editableDetailLines)))!;
    if (item.productId !== quote.productId || item.qty !== 1 || item.sourcePriceCurrency !== 'USD'
      || item.sourcePriceAmount !== quote.unitUsd || item.adminPriceOverrideUsd != null || item.crmPlayMemberId != null || item.rewardGrantId != null) {
      throw new Error('Cada producto Muérdeme conserva su configuración y precio en USD, sin beneficios VIVO.');
    }
    const stock = readMenuStockSnapshot(item.editableDetailLines.join('\n'));
    const { data, error } = await supabase.rpc('muerdeme_inventory_preview_v1', {
      p_selection: quote.selection, p_revisions: quote.revisions, p_order_id: orderId ?? null, p_certificate_id: stock?.certificateId ?? null,
    });
    if (error || data?.snapshot?.status !== 'ready') throw new Error('Falta completar la preparación e inventario de Muérdeme. Revisa el consumo de cada presentación antes de guardar.');
    item.editableDetailLines = [...menuQuoteDetailLines(quote), ...(stock?.certificateId ? [MUERDEME_STOCK_PREFIX+JSON.stringify(stock)] : [])];
    quotes.set(item.productId, quote);
  }
  return quotes;
}
