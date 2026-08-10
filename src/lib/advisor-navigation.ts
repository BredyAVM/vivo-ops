export function sanitizeAdvisorReturnTo(value: string | null | undefined) {
  const candidate = String(value || '').trim();
  if (!candidate.startsWith('/app/advisor')) return null;
  if (candidate.startsWith('//') || candidate.includes('://')) return null;
  return candidate;
}

export function withAdvisorReturnTo(href: string, returnTo: string) {
  const safeReturnTo = sanitizeAdvisorReturnTo(returnTo);
  if (!safeReturnTo) return href;

  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}returnTo=${encodeURIComponent(safeReturnTo)}`;
}
