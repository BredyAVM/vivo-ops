'use server';

// Shared financial command boundary; Admin pages contain no business queries.

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { getOrderLineTotalBs, getOrderLineTotalUsd, getOrderMoneySnapshot, roundOrderMoney } from '@/lib/orders/order-money';
import { validateDeliveredPriceChanges, type DeliveredPriceChange } from '@/lib/orders/delivered-order-prices';
import { loadDeliveredOrderCommissionEditor, refreshDeliveredOrderPriceCommissions } from '@/app/app/commissions/order-actions';

function message(error: unknown) { return error instanceof Error ? error.message : 'No se pudo ajustar el precio.'; }

export async function loadDeliveredOrderPriceEditor(orderId: number) {
  try {
    const { supabase } = await requireAdminContext();
    if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Selecciona un pedido válido.');
    const [orderResult, itemsResult, commissionResult] = await Promise.all([
      supabase.from('orders').select('id,status,last_modified_at,total_usd,total_bs_snapshot,extra_fields').eq('id', orderId).single(),
      supabase.from('order_items').select('id,qty,product_name_snapshot,unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,override_unit_price_usd,admin_price_override_usd,crm_play_member_id,crm_play_benefit_id,crm_play_benefit_upgrade_id,product:products!order_items_product_id_fkey(extra_fields,source_price_amount,base_price_usd)').eq('order_id', orderId).order('id'),
      loadDeliveredOrderCommissionEditor(orderId),
    ]);
    if (orderResult.error) throw new Error(orderResult.error.message);
    if (itemsResult.error) throw new Error(itemsResult.error.message);
    if (!commissionResult.ok) throw new Error(commissionResult.error);
    const order = orderResult.data!;
    if (order.status !== 'delivered') throw new Error('Este ajuste solo está disponible para pedidos entregados.');
    const money = getOrderMoneySnapshot(order);
    let protectedReason = commissionResult.editor.protectedReason;
    if (!(money.fxRate > 0)) protectedReason = 'El pedido no tiene una tasa guardada válida. Debe revisarse antes de ajustar precios.';
    if (order.extra_fields?.event_extension) protectedReason = 'Esta ampliación tiene un presupuesto autorizado. Su precio requiere rectificar ese presupuesto.';
    const items = (itemsResult.data ?? []).map((item) => {
      const product = Array.isArray(item.product) ? item.product[0] : item.product;
      const gift = ['advisor_gift', 'advisor_gift_only'].includes(product?.extra_fields?.catalog_access_scope ?? '') && Number(product?.source_price_amount ?? product?.base_price_usd ?? 0) === 0;
      const qty = Number(item.qty);
      return { id: Number(item.id), name: item.product_name_snapshot || 'Producto', qty,
        unitPriceUsd: roundOrderMoney(item.admin_price_override_usd ?? item.override_unit_price_usd ?? item.unit_price_usd_snapshot ?? 0),
        lineUsd: getOrderLineTotalUsd(item), lineBs: getOrderLineTotalBs(item, money.fxRate),
        locked: Boolean(item.crm_play_member_id || item.crm_play_benefit_id || item.crm_play_benefit_upgrade_id || gift || !(qty > 0)) };
    });
    return { ok: true as const, editor: { orderId, lastModifiedAt: order.last_modified_at as string | null, fxRate: money.fxRate, money, items, protectedReason } };
  } catch (error) { return { ok: false as const, error: message(error) }; }
}

export async function saveDeliveredOrderPriceEditor(input: { orderId: number; lastModifiedAt: string | null; operationId: string; reason: string; changes: DeliveredPriceChange[] }) {
  let saved = false;
  try {
    const { supabase } = await requireAdminContext();
    if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId)) throw new Error('El ajuste no es válido. Recarga el pedido.');
    const changes = validateDeliveredPriceChanges(input.changes, input.reason);
    const result = await supabase.rpc('save_delivered_order_prices_v1', { p_order_id: input.orderId, p_expected_last_modified_at: input.lastModifiedAt, p_operation_id: input.operationId, p_changes: changes, p_reason: input.reason.trim() });
    if (result.error) throw new Error(result.error.message);
    saved = true;
    if (result.data?.closures?.length) await refreshDeliveredOrderPriceCommissions(input.orderId);
    return { ok: true as const, message: 'Precios guardados. Pagos e inventario sin cambios; saldo actualizado.' };
  } catch (error) {
    if (saved) return { ok: true as const, message: `El precio quedó guardado. Falta actualizar el cierre preliminar de comisiones: ${message(error)}` };
    return { ok: false as const, error: message(error) };
  } finally {
    if (saved) for (const path of ['/app/admin', '/app/master/dashboard', '/app/master/ops', '/app/commissions', '/app/advisor']) revalidatePath(path, 'layout');
  }
}
