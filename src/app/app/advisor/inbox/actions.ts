'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

export async function markAdvisorTimelineRecipientsReadAction(recipientIds: number[]) {
  const ctx = await requireAuthContext();
  const normalizedIds = Array.from(
    new Set(
      recipientIds
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ).slice(0, 500);

  if (normalizedIds.length === 0) return { ok: true as const };

  const { error } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .update({ read_at: new Date().toISOString() })
    .in('id', normalizedIds)
    .eq('target_user_id', ctx.user.id);

  if (error) throw new Error(error.message);

  revalidatePath('/app/advisor', 'layout');
  revalidatePath('/app/advisor/inbox');
  return { ok: true as const };
}
