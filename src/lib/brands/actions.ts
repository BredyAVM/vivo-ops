'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { parseIncentiveUsd } from './model';

export type BrandIncentiveState = { ok: boolean; message: string };

export async function saveBrandIncentiveDraft(
  _previous: BrandIncentiveState, form: FormData,
): Promise<BrandIncentiveState> {
  try {
    const { supabase } = await requireAdminContext();
    const first = parseIncentiveUsd(form.get('firstOrderUsd'));
    const recurrent = parseIncentiveUsd(form.get('recurrentOrderUsd'));
    const revisionText = String(form.get('revision') ?? '');
    const revision = Number(revisionText);
    const operationId = String(form.get('operationId') ?? '');
    if (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(revision) || revision < 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new Error('Vuelve a consultar la configuración antes de guardar.');
    }
    const { data, error } = await supabase.rpc('admin_commercial_incentive_draft_save_v1', {
      p_first_order_usd: first, p_recurrent_order_usd: recurrent,
      p_expected_revision: revision, p_operation_id: operationId,
    });
    if (error) {
      if (error.code === '40001') throw new Error('La configuración cambió. Vuelve a consultar antes de guardar.');
      if (error.code === '42501') throw new Error('Esta operación requiere un administrador activo.');
      throw new Error('No se pudo guardar. Vuelve a consultar para comprobar el estado antes de reintentar.');
    }
    if (!data || data.status !== 'draft' || data.revision !== revision + 1) {
      throw new Error('El guardado no devolvió una confirmación válida. Vuelve a consultar antes de reintentar.');
    }
    revalidatePath('/app/admin/negocio/marcas');
    return { ok: true, message: 'Importes guardados para pedidos nuevos. Los pedidos anteriores conservan su versión.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No se pudo guardar la configuración.' };
  }
}
