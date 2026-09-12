'use server';
import { revalidatePath, updateTag } from 'next/cache';
import { decideExpense } from '@/lib/admin-finance/authorizations-data';

export async function decideAdminExpenseAction(input: Parameters<typeof decideExpense>[0]) {
  const result = await decideExpense(input);
  if (result.status === 'decided') {
    try {
      updateTag('master-dashboard-financial-references');
      revalidatePath('/app/admin', 'layout');
      revalidatePath('/app/master/dashboard');
      revalidatePath('/app/master/ops/finance');
    } catch { console.warn('Expense decision saved; view refresh deferred.'); }
  }
  return result;
}
