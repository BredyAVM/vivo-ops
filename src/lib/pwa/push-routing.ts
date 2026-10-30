const adminRoutes = [
  ['/app/master/ops/finance', '/app/admin/finanzas/pagos'],
  ['/app/master/ops/inventory', '/app/admin/inventario'],
  ['/app/inventory', '/app/admin/inventario'],
  ['/app/commissions', '/app/admin/finanzas/comisiones/operar'],
  ['/app/master/plays', '/app/admin/jugadas'],
  ['/app/events', '/app/admin/eventos'],
] as const;

export function pushUrlForSubscription(destination: string, scope: unknown, tag: unknown): string {
  const workspace = String(scope ?? '').trim();
  if (workspace !== 'admin' && workspace !== 'master_ops') return destination;
  const fallback = workspace === 'admin' ? '/app/admin/operaciones' : '/app/master/ops';
  if (!destination.startsWith('/app/') || /[\\\u0000-\u0020]/.test(destination)) return fallback;
  let url: URL;
  try { url = new URL(destination, 'https://vivo.invalid'); } catch { return fallback; }
  if (url.origin !== 'https://vivo.invalid' || /%/.test(url.pathname)) return fallback;
  const orderId = String(tag ?? '').match(/^master-order-(\d+)(?:-|$)/)?.[1];

  if (workspace === 'master_ops') {
    if (url.pathname === '/app/master/dashboard') url.pathname = '/app/master/ops';
    if (url.pathname === '/app/master/ops' && orderId && !url.searchParams.has('openOrder'))
      url.searchParams.set('openOrder', orderId);
    return url.pathname + url.search + url.hash;
  }

  if (url.pathname === '/app/master/dashboard') {
    const section = url.searchParams.get('adminSection');
    if (section === 'accounts' || section === 'users') {
      url.pathname = '/app/admin/configuracion/' + (section === 'accounts' ? 'cuentas' : 'usuarios');
      url.searchParams.delete('adminSection');
    } else {
      url.pathname = orderId || url.searchParams.has('openOrder') ? '/app/admin/ordenes' : fallback;
    }
  } else if (url.pathname === '/app/master/ops') {
    url.pathname = '/app/admin/ordenes';
  } else {
    for (const [source, target] of adminRoutes) {
      if (url.pathname === source || url.pathname.startsWith(source + '/')) {
        url.pathname = target + url.pathname.slice(source.length);
        break;
      }
    }
  }
  if (url.pathname !== '/app/admin' && !url.pathname.startsWith('/app/admin/')) return fallback;
  if (url.pathname === '/app/admin/ordenes' && orderId && !url.searchParams.has('openOrder'))
    url.searchParams.set('openOrder', orderId);
  return url.pathname + url.search + url.hash;
}
