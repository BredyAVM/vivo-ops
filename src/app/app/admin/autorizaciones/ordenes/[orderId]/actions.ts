'use server';
import { revalidatePath } from 'next/cache';
import { approveAdminOrderReview } from '@/lib/admin-finance/order-review-data';
export async function approveAdminOrderAction(input: Parameters<typeof approveAdminOrderReview>[0]) {
  const result = await approveAdminOrderReview(input);
  if (result.status === 'approved') {
    try {
      revalidatePath('/app/admin', 'layout'); revalidatePath('/app/master/ops');
      revalidatePath('/app/master/dashboard'); revalidatePath('/app/advisor/orders');
    } catch { console.warn('Order review saved; view refresh deferred.'); }
  }
  return result;
}
