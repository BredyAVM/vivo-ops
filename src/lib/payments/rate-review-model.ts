export type PaymentRateReview = {
  available: boolean;
  canApprove?: boolean;
  reportId?: number;
  orderId?: number;
  amountBs?: number;
  recordedRate?: number;
  quoteRate?: number | null;
  quoteUsd?: number | null;
  quoteBs?: number | null;
  source?: string;
  quoteCandidates?: Array<{ id: number; rate: number; pendingUsd: number; pendingBs: number; createdAt: string }>;
  decision?: 'quoted' | 'reported' | null;
  applied?: boolean;
};

/** Display-only preview. The atomic database command rechecks the actual coverage. */
export function paymentRateCoveragePreview(review: PaymentRateReview | null | undefined,
  amount: number, rate: number, currency: string, fallbackUsd: number) {
  if (currency !== 'VES' || !review?.available || review.decision !== 'quoted' || review.applied ||
    Number(review.amountBs) !== amount || Number(review.recordedRate) !== rate ||
    !Number.isFinite(Number(review.quoteRate)) || Number(review.quoteRate) <= 0 ||
    !Number.isFinite(Number(review.quoteUsd)) || Number(review.quoteUsd) <= 0) return fallbackUsd;
  return amount === Number(review.quoteBs) ? Number(review.quoteUsd) : amount / Number(review.quoteRate);
}
