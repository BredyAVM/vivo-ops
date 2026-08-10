'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

export async function archiveAdvisorOrderDraftAction(draftIdInput: number) {
  const ctx = await requireAuthContext();
  const draftId = Number(draftIdInput);

  if (!Number.isFinite(draftId) || draftId <= 0) {
    throw new Error('El borrador no es válido.');
  }

  const { data, error } = await ctx.supabase
    .from('advisor_order_drafts')
    .update({
      status: 'archived',
      archived_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .eq('advisor_user_id', ctx.user.id)
    .in('status', ['draft', 'quoted'])
    .select('id')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Este borrador ya no está disponible para eliminar.');

  revalidatePath('/app/advisor/drafts');
  revalidatePath('/app/advisor/new');
  return { ok: true as const };
}
