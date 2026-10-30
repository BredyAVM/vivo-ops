'use server';

import { requireAuthContext } from '@/lib/auth';
import { buildOrderPaymentQuote, readOrderPaymentQuote, type PaymentQuoteState } from '@/lib/orders/payment-quote';

export async function loadOrderPaymentQuoteAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
