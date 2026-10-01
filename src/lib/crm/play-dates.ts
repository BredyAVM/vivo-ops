const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Database instants are UTC; date inputs represent calendar days in Venezuela.
// Never truncate an instant: the end of Sep 30 in Caracas falls on Oct 1 UTC.
export function playDateInput(value: string | null | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // Reject timezone-less timestamps rather than depending on the host timezone.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const parts = Object.fromEntries(businessDateFormatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
