'use server';
import { persistDeliveryExtra, reverseDeliveryExtra, persistDeliveryPayment, reverseDeliveryPayment, type DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
import type { DeliveryExtraInput } from '@/lib/admin-finance/delivery-extras';
import type { DeliveryDebtInput } from '@/lib/admin-finance/delivery-debts';
import { persistDeliveryDebt, reverseDeliveryDebt, previewDeliveryDebtOrder } from '@/lib/admin-finance/delivery-service-data';
import { revalidatePath } from 'next/cache';
export type { DeliveryPaymentInput } from '@/lib/admin-finance/delivery-service-data';
export async function lookupDeliveryDebtOrder(id: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function recordDeliveryDebt(id: string, input: DeliveryDebtInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function voidDeliveryDebt(id: string, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function recordDeliveryExtra(id: string, input: DeliveryExtraInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function voidDeliveryExtra(id: string, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function recordDeliveryPayment(requestId: string, input: DeliveryPaymentInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function voidDeliveryPayment(id: string, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
