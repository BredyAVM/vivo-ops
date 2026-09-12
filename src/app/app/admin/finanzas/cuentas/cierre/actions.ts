'use server';
import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { loadAccountClosurePreview } from '@/lib/finance/account-closure-preview';
import { executeAdminAccountClosure } from '@/lib/finance/account-closure-command';
import { validClosureCut, type AccountClosureInput } from '@/lib/finance/account-closure-model';
export async function previewAdminAccountClosure(input: Pick<AccountClosureInput, 'moneyAccountId' | 'closureDate' | 'closureTime'>) {
  const { supabase } = await requireAdminContext();
  if (!validClosureCut(input)) return { status: 'error' as const, message: 'Indica una cuenta, fecha y hora válidas.' };
  try {
    const preview = await loadAccountClosurePreview(supabase, input);
    if (!['USD', 'VES'].includes(preview.currencyCode) || !Number.isFinite(preview.expectedAmount) || !Number.isFinite(preview.expectedAmountUsd)) throw new Error('Saldo no disponible.');
    return { status: 'ready' as const, preview };
  } catch { return { status: 'error' as const, message: 'No se pudo verificar el saldo esperado. Actualiza antes de guardar.' }; }
}
export async function createAdminAccountClosure(input: AccountClosureInput) {
  const result = await executeAdminAccountClosure(input);
  if (result.status === 'confirmed') {
    try {
      revalidatePath('/app/admin', 'layout'); revalidatePath('/app/master/dashboard'); revalidatePath('/app/master/ops/finance');
    } catch { console.warn('Account closure saved; financial view refresh deferred.'); }
  }
  return result;
}
