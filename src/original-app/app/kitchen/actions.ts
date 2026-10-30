'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';

type KitchenChangeRecipientRow = {
  id: number | string;
  event_id: number | string;
};

type KitchenChangeEventRow = {
  id: number | string;
  order_id: number | string;
  event_type: string | null;
};

export async function acknowledgeKitchenOrderChangesAction(input: {
  orderId: number;
  recipientIds: number[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
