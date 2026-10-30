'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { createCashOperation } from '@/lib/admin-finance/account-operation-reads';
import {isDefinitiveTransferRejection} from '@/lib/finance/money-transfer-model';
import {parseCashReceipt,validCashOperation,type CashOperationInput,type CashOperationResult} from '@/lib/admin-finance/cash-operation';

export async function createAdminMoneyMovementAction(input:CashOperationInput):Promise<CashOperationResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
