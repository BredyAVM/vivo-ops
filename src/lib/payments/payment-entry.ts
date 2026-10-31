import { paymentCollectionValueRate } from '../orders/collection-policy.ts';
import { parsePaymentAmount } from './payment-amount.ts';

export type PaymentEntryValue = { operationDate: string; exchangeRate: string; amount: string };
export type PaymentEntryQuote = {
  operationDate: string; pendingUsd: number; pendingBs: number; exchangeRate: number;
  snapshotRate: number; collectionMode: 'native_usd' | 'snapshot_quote' | 'post_delivery_usd' | 'closed'; dayRates: number[];
};
/** Display-only estimate, using the server's pending quote and commercial mode.
 * Money and debt are certified again by the canonical DB transaction. */
export function paymentEntryPreview(
  quote: Pick<PaymentEntryQuote, 'pendingUsd' | 'pendingBs' | 'exchangeRate' | 'snapshotRate' | 'collectionMode'>,
  currency: 'USD' | 'VES', text: string,
) {
  const amount = parsePaymentAmount(text);
  if (amount == null) return null;
  const valueRate = paymentCollectionValueRate(quote);
  const exact = currency === 'VES' && amount === quote.pendingBs;
  const applied = currency === 'USD' ? amount : exact ? quote.pendingUsd : valueRate > 0 ? amount / valueRate : NaN;
  if (!Number.isFinite(applied)) return null;
  const difference = quote.pendingUsd - applied;
  return { amount, appliedUsd: applied, pendingUsd: difference > 0 && difference < 0.01 ? 0 : Math.max(0, difference),
    excessUsd: Math.max(0, -difference) };
}
