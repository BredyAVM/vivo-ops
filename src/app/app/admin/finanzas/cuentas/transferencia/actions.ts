'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { executeMoneyTransfer } from '@/lib/finance/money-transfer-command';
import type { MoneyTransferInput } from '@/lib/finance/money-transfer-model';

export async function createAdminTransferAction(input: MoneyTransferInput) {
  const result = await executeMoneyTransfer(input);
  if (result.status === 'confirmed') {
    // Cache refresh must not turn a committed transfer into a failed transaction.
    try {
      updateTag('master-dashboard-financial-references');
      revalidatePath('/app/admin', 'layout');
      revalidatePath('/app/master/dashboard');
      revalidatePath('/app/master/ops/finance');
    } catch {
      console.warn('Transfer confirmed; financial view refresh deferred.');
    }
  }
  return result;
}
