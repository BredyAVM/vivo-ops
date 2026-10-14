'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import { redirectInWorkspace } from '@/lib/navigation/workspace-server';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import { recalculateAdvisorCommissionSettlementsForGoal } from './actions';

export async function transferCommissionCollectionAction(formData: FormData) {
  const periodId = Number(formData.get('periodId'));
  try {
    const { supabase, roles } = await requireAuthContext();
    if (!roles.includes('admin')) throw new Error('Esta acción requiere administración.');
    const sourceId = Number(formData.get('sourceClosureId'));
    const destinationId = Number(formData.get('destinationClosureId'));
    const reason = String(formData.get('reason') ?? '').trim();
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(destinationId) || destinationId <= 0 || reason.length < 3 || reason.length > 500) {
      throw new Error('Selecciona un destino válido e indica el motivo del traslado.');
    }
    const { error } = await supabase.rpc('transfer_commission_collection_v1', {
      p_source: sourceId, p_destination: destinationId, p_reason: reason,
    });
    if (error) throw new Error(error.message);
    const target = await supabase.from('advisor_commission_closures').select('period_id,snapshot').eq('id', destinationId).single();
    if (target.error) throw new Error('El traslado quedó registrado; vuelve a actualizar el período de destino.');
    try {
      await recalculateAdvisorCommissionSettlementsForGoal({ periodId: Number(target.data.period_id), closureId: destinationId,
        scheduledLiquidationDate: readAdvisorCommissionSettlementSnapshot(target.data.snapshot).scheduledLiquidationDate });
    } catch {
      throw new Error('El traslado quedó registrado sin duplicarse; falta actualizar el preliminar de destino.');
    }
  } catch (error) {
    return await redirectInWorkspace(`/app/commissions?period=${periodId}&error=${encodeURIComponent(error instanceof Error ? error.message : 'No se pudo completar el traslado.')}`);
  }
  revalidatePath('/app/commissions', 'layout');
  revalidatePath('/app/advisor/commissions');
  return await redirectInWorkspace(`/app/commissions?period=${periodId}&notice=${encodeURIComponent('Saldo trasladado una sola vez. La cobranza continúa en el destino; el acuerdo y los pagos de origen se conservan.')}`);
}
