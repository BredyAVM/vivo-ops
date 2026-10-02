import { safeAppReturnHref } from './return-navigation';

const sharedRoutes = [
  ['/app/master/ops/finance', '/app/admin/finanzas/pagos'],
  ['/app/inventory', '/app/admin/inventario'],
  ['/app/commissions', '/app/admin/finanzas/comisiones/operar'],
  ['/app/master/plays', '/app/admin/jugadas'],
  ['/app/events', '/app/admin/eventos'],
] as const;

// Presentation only: never use this mapping as an authorization decision.
export function adminWorkspaceHref(destination: string, current: string): string {
  const source = safeAppReturnHref(current);
  const target = safeAppReturnHref(destination);
  if (!source || !target) return destination;
  const from = new URL(source, 'https://vivo.invalid');
  if (from.pathname !== '/app/admin' && !from.pathname.startsWith('/app/admin/')) return destination;
  const url = new URL(target, 'https://vivo.invalid');
  for (const [shared, administrative] of sharedRoutes) {
    if (url.pathname === shared || url.pathname.startsWith(shared + '/')) {
      url.pathname = administrative + url.pathname.slice(shared.length);
      return url.pathname + url.search + url.hash;
    }
  }
  if (url.pathname === '/app/master/ops') url.pathname = '/app/admin/ordenes';
  else if (url.pathname === '/app/master/dashboard' && !url.searchParams.has('adminSection')) url.pathname = '/app/admin/operaciones';
  return url.pathname + url.search + url.hash;
}

export function sharedWorkspacePath(pathname: string): string {
  for (const [shared, administrative] of sharedRoutes) {
    if (pathname === administrative || pathname.startsWith(administrative + '/'))
      return shared + pathname.slice(administrative.length);
  }
  return pathname;
}
