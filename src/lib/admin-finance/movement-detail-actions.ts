'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { voidFinancialMovementAction } from '@/app/app/master/dashboard/actions';
import { readAccountMovementDetail } from './movement-detail-data';
import { movementVoidBlock, positiveMovementId } from './movement-detail-model';

export async function voidAccountMovementAction(input: {
  accountId: number; movementId: number; fingerprint: string; reason: string;
}) {
  const { supabase } = await requireAdminContext();
  if (!positiveMovementId(input.accountId) || !positiveMovementId(input.movementId)) {
    return { ok: false as const, message: 'Cuenta o movimiento inválido.' };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < 6 || reason.length > 500) return { ok: false as const, message: 'Describe el motivo (6 a 500 caracteres).' };
  try {
    const detail = await readAccountMovementDetail(supabase, input.accountId, input.movementId);
    if (!detail) return { ok: false as const, message: 'El movimiento no pertenece a esta cuenta.' };
    if (input.fingerprint !== detail.fingerprint) return { ok: false as const, message: 'La operación cambió. Actualiza y revisa el detalle antes de anular.' };
    const blocked = movementVoidBlock(detail.movements);
    if (blocked) return { ok: false as const, message: blocked };
    // Reuse the canonical transactional command: linked payments, fees, funds and transfers stay together.
    const result = await voidFinancialMovementAction({
      movementId: detail.movement.id, movementGroupId: detail.movement.groupId, reason,
    });
    if (result.ok) {
      try { revalidatePath('/app/admin/finanzas/cuentas', 'layout'); } catch { /* The canonical receipt is authoritative. */ }
    }
    return result;
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo verificar la operación. Actualiza y revisa su estado.' };
  }
}
