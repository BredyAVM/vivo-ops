'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { executeMoneyTransfer } from '@/lib/finance/money-transfer-command';
import type { MoneyTransferInput } from '@/lib/finance/money-transfer-model';

export async function createAdminTransferAction(input: MoneyTransferInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
