'use server';
import { revalidatePath } from 'next/cache';
import { approveAdminOrderReview } from '@/lib/admin-finance/order-review-data';
export async function approveAdminOrderAction(input: Parameters<typeof approveAdminOrderReview>[0]) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
