const COUNTER_TECHNICAL_ERROR_PATTERNS = [
  /an error occurred in the server components render/i,
  /digest property/i,
  /failed to fetch/i,
  /fetch failed/i,
  /networkerror/i,
  /load failed/i,
  /permission denied/i,
  /invalid input syntax/i,
  /duplicate key/i,
  /schema cache/i,
  /jwt/i,
  /^counter_[a-z0-9_]+$/i,
];

export function getCounterUiErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : '';
  if (!message) return fallback;
  return COUNTER_TECHNICAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ? fallback
    : message;
}
