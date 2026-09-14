'use server';
import { persistDeliveryPayment, reverseDeliveryPayment, type DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
import { revalidatePath } from 'next/cache';
export type { DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
export async function recordDeliveryPayment(requestId: string, input: DeliveryPaymentInput) {
  const result = await persistDeliveryPayment(requestId, input);
  if (result.ok) {
    try {
      for (const path of ['/app/admin/finanzas/delivery', '/app/admin/finanzas/cuentas', '/app/admin', '/app/master/dashboard', '/app/master/ops/finance']) revalidatePath(path);
    } catch { console.warn('Delivery payment saved; view refresh deferred.'); }
  }
  return result;
}
export async function voidDeliveryPayment(id: string, reason: string) {
  const result = await reverseDeliveryPayment(id, reason);
  if (result.ok) {
    try { revalidatePath('/app/admin', 'layout'); revalidatePath('/app/master/dashboard'); revalidatePath('/app/master/ops/finance'); }
    catch { console.warn('Delivery payment reversed; view refresh deferred.'); }
  }
  return result;
}
