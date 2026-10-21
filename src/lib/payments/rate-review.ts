export const RATE_REVIEW_MARKER = '[Revisar tasa acordada]';

export function withRateReviewRequest(notes: string, requested: boolean) {
  const clean = notes.replaceAll(RATE_REVIEW_MARKER, '').trim();
  return requested ? [RATE_REVIEW_MARKER, clean].filter(Boolean).join('\n') : clean;
}
