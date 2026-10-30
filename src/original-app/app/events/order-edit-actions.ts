'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import { validateEventOrderEdit, type EventOrderEditData, type EventOrderEditInput } from '@/lib/events/event-order-edit';

export async function readEventOrderEditAction(orderId: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveEventOrderEditAction(orderId: number, version: string | null, input: EventOrderEditInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
