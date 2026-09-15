'use server';
import { persistDeliveryExtra, reverseDeliveryExtra, persistDeliveryPayment, reverseDeliveryPayment, type DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
import type { DeliveryExtraInput } from '@/lib/admin-finance/delivery-extras';
import type { DeliveryDebtInput } from '@/lib/admin-finance/delivery-debts';
import { persistDeliveryDebt, reverseDeliveryDebt, previewDeliveryDebtOrder } from '@/lib/admin-finance/delivery-service-data';
import { revalidatePath } from 'next/cache';
export type { DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
export async function lookupDeliveryDebtOrder(id: number) { return previewDeliveryDebtOrder(id); }
export async function recordDeliveryDebt(id: string, input: DeliveryDebtInput) {
  const result = await persistDeliveryDebt(id, input);
  if (result.ok) { try { revalidatePath('/app/admin/finanzas/delivery'); } catch { console.warn('Delivery debt refresh deferred.'); } }
  return result;
}
export async function voidDeliveryDebt(id: string, reason: string) {
  const result = await reverseDeliveryDebt(id, reason);
  if (result.ok) { try { revalidatePath('/app/admin/finanzas/delivery'); } catch { console.warn('Delivery debt refresh deferred.'); } }
  return result;
}
export async function recordDeliveryExtra(id: string, input: DeliveryExtraInput) {
  const result = await persistDeliveryExtra(id, input);
  if (result.ok) {
    try { revalidatePath('/app/admin/finanzas/delivery'); }
    catch { console.warn('Delivery extra saved; view refresh deferred.'); }
  }
  return result;
}
export async function voidDeliveryExtra(id: string, reason: string) {
  const result = await reverseDeliveryExtra(id, reason);
  if (result.ok) {
    try { revalidatePath('/app/admin/finanzas/delivery'); }
    catch { console.warn('Delivery extra voided; view refresh deferred.'); }
  }
  return result;
}
export async function recordDeliveryPayment(requestId: string, input: DeliveryPaymentInput) {
  const result = await persistDeliveryPayment(requestId, input);
  if (result.ok) {
    try {
      revalidatePath('/app', 'layout');
    } catch { console.warn('Delivery payment saved; view refresh deferred.'); }
  }
  return result;
}
export async function voidDeliveryPayment(id: string, reason: string) {
  const result = await reverseDeliveryPayment(id, reason);
  if (result.ok) {
    try { revalidatePath('/app', 'layout'); }
    catch { console.warn('Delivery payment reversed; view refresh deferred.'); }
  }
  return result;
}
