'use server';
import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import type { EventPaymentAllocation } from '@/lib/events/event-payments';

export async function eventWorkspaceCommand(rootId: number, action: string, input: Record<string, unknown>) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function eventPaymentCommand(rootId: number, action: string, input: Record<string, unknown>) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
