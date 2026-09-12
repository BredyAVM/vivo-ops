'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { createMasterOpsMoneyMovementAction } from '@/app/app/master/ops/finance/actions';

export async function createAdminMoneyMovementAction(
  input: Parameters<typeof createMasterOpsMoneyMovementAction>[0],
) {
  await requireAdminContext();
  const result = await createMasterOpsMoneyMovementAction(input);
  revalidatePath('/app/admin', 'layout');
  return result;
}
