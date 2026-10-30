'use server';
import { revalidatePath, updateTag } from 'next/cache';
import { decideExpense } from '@/lib/admin-finance/authorizations-data';

export async function decideAdminExpenseAction(input: Parameters<typeof decideExpense>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
