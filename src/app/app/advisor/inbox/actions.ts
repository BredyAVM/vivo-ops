'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

export type AdvisorInboxReadReference = {
  source: 'timeline' | 'notification';
  id: number;
};

type CommissionNotificationRow = {
  id: number | string;
  meta: Record<string, unknown> | null;
};

function isGoalNotification(meta: Record<string, unknown> | null) {
  return String(meta?.kind ?? '').startsWith('advisor_goal_');
}

function normalizedIds(values: number[]) {
  return Array.from(
    new Set(
      values
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).slice(0, 500);
}

export async function markAdvisorInboxItemsReadAction(items: AdvisorInboxReadReference[]) {
  const ctx = await requireAuthContext();
  const timelineIds = normalizedIds(
    items.filter((item) => item.source === 'timeline').map((item) => item.id),
  );
  const notificationIds = normalizedIds(
    items.filter((item) => item.source === 'notification').map((item) => item.id),
  );

  if (timelineIds.length === 0 && notificationIds.length === 0) {
    return { ok: true as const };
  }

  const now = new Date().toISOString();
  const notificationRowsResult = notificationIds.length > 0
    ? await ctx.supabase
        .from('notifications')
        .select('id, meta')
        .in('id', notificationIds)
        .eq('recipient_user_id', ctx.user.id)
        .contains('meta', { domain: 'advisor_commissions' })
    : { data: [], error: null };
  if (notificationRowsResult.error) throw new Error(notificationRowsResult.error.message);
  const notificationRows = (notificationRowsResult.data ?? []) as CommissionNotificationRow[];
  const goalNotificationIds = new Set(
    notificationRows.filter((row) => isGoalNotification(row.meta)).map((row) => Number(row.id))
  );
  const ordinaryNotificationIds = notificationIds.filter((id) => !goalNotificationIds.has(id));
  const results = await Promise.all([
    timelineIds.length > 0
      ? ctx.supabase
          .from('order_timeline_event_recipients')
          .update({ read_at: now })
          .in('id', timelineIds)
          .eq('target_user_id', ctx.user.id)
      : Promise.resolve({ error: null }),
    ordinaryNotificationIds.length > 0
      ? ctx.supabase
          .from('notifications')
          .update({ status: 'read', read_at: now })
          .in('id', ordinaryNotificationIds)
          .eq('recipient_user_id', ctx.user.id)
          .contains('meta', { domain: 'advisor_commissions' })
      : Promise.resolve({ error: null }),
    ...notificationRows
      .filter((row) => goalNotificationIds.has(Number(row.id)))
      .map((row) => ctx.supabase
        .from('notifications')
        .update({
          status: 'read',
          read_at: now,
          meta: {
            ...(row.meta ?? {}),
            requires_action: false,
            reviewed_at: now,
          },
        })
        .eq('id', Number(row.id))
        .eq('recipient_user_id', ctx.user.id)
        .contains('meta', { domain: 'advisor_commissions' })),
  ]);

  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);

  revalidatePath('/app/advisor', 'layout');
  revalidatePath('/app/advisor/inbox');
  return { ok: true as const };
}
