'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { resolveProductCommissionTerms } from '@/lib/commissions/product-commission-policy';
import { resolveDeliveredCommissionItem, validateDeliveredCommissionChanges, type DeliveredCommissionChange } from '@/lib/commissions/delivered-order-commission';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import { readAdvisorCommissionWorkflowSnapshot } from '@/lib/commissions/workflow-snapshot';
import { readAdvisorGoalPublicationSnapshot } from '@/lib/commissions/goal-snapshot';
import { generateAdvisorCommissionClosuresAction } from '@/app/app/master/dashboard/actions';
import { applyAdvisorCommissionGoalResults, recalculateAdvisorCommissionSettlementsForGoal } from './actions';

type ProductRow = { commission_mode: string; commission_value: number | null; extra_fields: unknown };
type ItemRow = { id: number; product_name_snapshot: string; product: ProductRow | ProductRow[] | null };
type ClosureRow = { id: number; period_id: number; advisor_user_id: string; status: string; base_commission_pct: number; snapshot: unknown; closed_at: string | null; paid_at: string | null };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'No se pudo actualizar la comisión.';
}

async function loadEditor(orderId: number) {
  const { supabase } = await requireAdminContext();
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Selecciona un pedido válido.');
  const [orderResult, itemsResult, adjustmentsResult, financialResult, membershipResult] = await Promise.all([
    supabase.from('orders').select('id, status, attributed_advisor_id, created_at, last_modified_at').eq('id', orderId).single(),
    supabase.from('order_items').select('id, product_name_snapshot, product:products!order_items_product_id_fkey(commission_mode, commission_value, extra_fields)').eq('order_id', orderId).order('id'),
    supabase.from('order_admin_adjustments').select('order_item_id, payload').eq('order_id', orderId).eq('adjustment_type', 'other').order('created_at', { ascending: false }).order('id', { ascending: false }),
    supabase.rpc('get_orders_financial_state', { p_order_ids: [orderId], p_operation_date: null, p_active_bs_rate: null }),
    supabase.from('advisor_commission_closures').select('id, period_id, advisor_user_id, status, base_commission_pct, snapshot, closed_at, paid_at').contains('snapshot', { orders: [{ orderId }] }),
  ]);
  for (const result of [orderResult, itemsResult, adjustmentsResult, financialResult, membershipResult]) {
    if (result.error) throw new Error(result.error.message);
  }
  const order = orderResult.data!;
  if (order.status !== 'delivered') throw new Error('Este ajuste solo está disponible para pedidos entregados.');
  const fallbackDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(order.created_at));
  const deliveryDate = String(financialResult.data?.[0]?.delivery_reference_date || fallbackDate);
  const periodResult = await supabase.from('advisor_commission_periods').select('id, status').lte('date_from', deliveryDate).gte('date_to', deliveryDate);
  if (periodResult.error) throw new Error(periodResult.error.message);
  const periods = periodResult.data ?? [];
  const closures = new Map((membershipResult.data ?? []).map((row) => [Number(row.id), row as ClosureRow]));
  if (periods.length && order.attributed_advisor_id) {
    const result = await supabase.from('advisor_commission_closures').select('id, period_id, advisor_user_id, status, base_commission_pct, snapshot, closed_at, paid_at')
      .in('period_id', periods.map((row) => row.id)).eq('advisor_user_id', order.attributed_advisor_id);
    if (result.error) throw new Error(result.error.message);
    for (const row of result.data ?? []) closures.set(Number(row.id), row as ClosureRow);
  }
  const allClosures = [...closures.values()];
  let protectedReason: string | null = periods.some((row) => row.status !== 'open')
    ? 'El período está cerrado. Primero debe rectificarse la liquidación.' : null;
  if (allClosures.some((row) => row.status !== 'preliminary' || row.closed_at || row.paid_at || readAdvisorCommissionWorkflowSnapshot(row.snapshot).conformity.status === 'confirmed')) {
    protectedReason = 'Esta comisión pertenece a una liquidación confirmada o pagada. Primero debe rectificarse la liquidación.';
  }
  const items = ((itemsResult.data ?? []) as unknown as ItemRow[]).map((item) => {
    const product = Array.isArray(item.product) ? item.product[0] : item.product;
    const catalog = resolveProductCommissionTerms({ currentMode: product?.commission_mode, currentValue: product?.commission_value, extraFields: product?.extra_fields, referenceDate: deliveryDate });
    const payloads = (adjustmentsResult.data ?? []).filter((row) => Number(row.order_item_id) === Number(item.id)).map((row) => row.payload);
    return { id: Number(item.id), name: item.product_name_snapshot || 'Producto', ...resolveDeliveredCommissionItem(catalog, payloads) };
  });
  return { orderId, lastModifiedAt: order.last_modified_at as string | null, items, protectedReason, closures: allClosures };
}

export async function loadDeliveredOrderCommissionEditor(orderId: number) {
  try {
    const loaded = await loadEditor(orderId);
    const editor = { orderId: loaded.orderId, lastModifiedAt: loaded.lastModifiedAt, items: loaded.items, protectedReason: loaded.protectedReason };
    return { ok: true as const, editor };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error) };
  }
}

async function refreshPreliminaryClosures(editor: Awaited<ReturnType<typeof loadEditor>>, affected: Array<{ id: number; periodId: number }>) {
  for (const row of affected) {
    const closure = editor.closures.find((item) => Number(item.id) === Number(row.id));
    if (!closure) throw new Error('Recarga las comisiones para actualizar el cierre preliminar.');
    if (readAdvisorGoalPublicationSnapshot(closure.snapshot)) {
      await applyAdvisorCommissionGoalResults({ periodId: Number(row.periodId), advisorUserId: closure.advisor_user_id, intent: 'automatic' });
    } else {
      await generateAdvisorCommissionClosuresAction({ periodId: Number(row.periodId), advisorUserId: closure.advisor_user_id, baseCommissionPctByAdvisor: { [closure.advisor_user_id]: Number(closure.base_commission_pct) } });
      await recalculateAdvisorCommissionSettlementsForGoal({ periodId: Number(row.periodId), closureId: Number(row.id), scheduledLiquidationDate: readAdvisorCommissionSettlementSnapshot(closure.snapshot).scheduledLiquidationDate,
        previousSnapshotsByAdvisor: { [closure.advisor_user_id]: closure.snapshot } });
    }
  }
}

export async function refreshDeliveredOrderPriceCommissions(orderId: number) {
  await requireAdminContext();
  const editor = await loadEditor(orderId);
  if (editor.protectedReason) throw new Error(editor.protectedReason);
  await refreshPreliminaryClosures(editor, editor.closures.map((row) => ({ id: Number(row.id), periodId: Number(row.period_id) })));
}

export async function saveDeliveredOrderCommissionEditor(input: {
  orderId: number;
  lastModifiedAt: string | null;
  reason: string;
  changes: DeliveredCommissionChange[];
}) {
  let saved = false;
  try {
    const { supabase } = await requireAdminContext();
    const changes = validateDeliveredCommissionChanges(input.changes, input.reason);
    const editor = await loadEditor(input.orderId);
    if (editor.protectedReason) throw new Error(editor.protectedReason);
    const result = await supabase.rpc('save_delivered_order_commissions_v1', {
      p_order_id: input.orderId, p_expected_last_modified_at: input.lastModifiedAt,
      p_changes: changes, p_reason: input.reason.trim(),
    });
    if (result.error) throw new Error(result.error.message);
    saved = true;
    // Only refresh existing preliminary closures. Their earned general rate,
    // carry overrides and scheduled payment date remain owned by that closure.
    const affected = (result.data?.closures ?? []) as Array<{ id: number; periodId: number }>;
    await refreshPreliminaryClosures(editor, affected);
    return { ok: true as const, message: affected.length ? 'Comisiones guardadas y cierre preliminar actualizado.' : 'Comisiones guardadas. Se aplicarán al calcular el cierre del período.' };
  } catch (error) {
    if (saved) return { ok: true as const, message: `El ajuste quedó guardado, pero falta recalcular el cierre preliminar: ${errorMessage(error)}` };
    return { ok: false as const, error: errorMessage(error) };
  } finally {
    if (saved) {
      for (const path of ['/app/master/dashboard', '/app/master/ops', '/app/admin', '/app/commissions', '/app/advisor']) revalidatePath(path, 'layout');
    }
  }
}
