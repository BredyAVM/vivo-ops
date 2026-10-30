// Only application pages may be return destinations; never external sites or commands.
export function safeAppReturnHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 6000 || !value.startsWith('/app')
    || /[\\\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://vivo.invalid');
    const rawPath = value.split(/[?#]/, 1)[0];
    if (url.origin !== 'https://vivo.invalid' || rawPath !== url.pathname
      || (url.pathname !== '/app' && !url.pathname.startsWith('/app/'))
      || /%/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function appContextHref(destination: string, current: string): string {
  const source = safeAppReturnHref(current);
  const target = safeAppReturnHref(destination);
  if (!source || !target) return destination;
  const url = new URL(target, 'https://vivo.invalid');
  const from = new URL(source, 'https://vivo.invalid');
  // A filter/pagination change stays on the same screen; keep its original parent.
  const parent = url.pathname === from.pathname
    ? safeAppReturnHref(from.searchParams.get('returnTo'))
    : source;
  if (parent) url.searchParams.set('returnTo', parent);
  else url.searchParams.delete('returnTo');
  const result = `${url.pathname}${url.search}${url.hash}`;
  return result.length <= 6000 ? result : destination;
}
