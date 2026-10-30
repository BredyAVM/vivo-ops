'use server';
import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { voidClosure } from '@/lib/admin-finance/account-operation-reads';
import { loadAccountClosurePreview } from '@/lib/finance/account-closure-preview';
import { executeAdminAccountClosure } from '@/lib/finance/account-closure-command';
import { validClosureCut, type AccountClosureInput } from '@/lib/finance/account-closure-model';
export async function voidAdminClosure(closureId:number,reason:string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function previewAdminAccountClosure(input: Pick<AccountClosureInput, 'moneyAccountId' | 'closureDate' | 'closureTime'>) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function createAdminAccountClosure(input: AccountClosureInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
