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

export async function markAdvisorInboxItemsReadAction(items: AdvisorInboxReadReference[]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
