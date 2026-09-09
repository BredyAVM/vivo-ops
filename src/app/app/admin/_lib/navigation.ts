export type AdminNavigationItem = {
  key: string;
  label: string;
  shortLabel: string;
  description: string;
  href: string;
  prefetch: boolean;
  marker: string;
};

export const adminNavigation: AdminNavigationItem[] = [
  {
    key: 'home',
    label: 'Inicio',
    shortLabel: 'Inicio',
    description: 'Resumen y accesos principales',
    href: '/app/admin',
    prefetch: true,
    marker: 'IN',
  },
  {
    key: 'finance',
    label: 'Finanzas',
    shortLabel: 'Finanzas',
    description: 'Indicadores, posición y pendientes',
    href: '/app/admin/finanzas',
    prefetch: false,
    marker: 'FI',
  },
  {
    key: 'accounts',
    label: 'Cuentas',
    shortLabel: 'Cuentas',
    description: 'Saldos, movimientos y conciliación',
    href: '/app/admin/finanzas/cuentas',
    prefetch: false,
    marker: 'CU',
  },
  {
    key: 'orders',
    label: 'Órdenes',
    shortLabel: 'Órdenes',
    description: 'Operación, pagos y entregas',
    href: '/app/master/ops',
    prefetch: false,
    marker: 'OR',
  },
  {
    key: 'inventory',
    label: 'Inventario',
    shortLabel: 'Inventario',
    description: 'Existencias, conteos y catálogo',
    href: '/app/inventory',
    prefetch: false,
    marker: 'IV',
  },
  {
    key: 'commissions',
    label: 'Comisiones',
    shortLabel: 'Comisiones',
    description: 'Metas, cierres y liquidaciones',
    href: '/app/commissions',
    prefetch: false,
    marker: 'CO',
  },
  {
    key: 'events',
    label: 'Presupuestos de eventos',
    shortLabel: 'Eventos',
    description: 'Cotizaciones y seguimiento',
    href: '/app/events',
    prefetch: false,
    marker: 'EV',
  },
  {
    key: 'plays',
    label: 'Jugadas',
    shortLabel: 'Jugadas',
    description: 'Campañas y acciones comerciales',
    href: '/app/master/plays',
    prefetch: false,
    marker: 'JU',
  },
  {
    key: 'legacy',
    label: 'Panel anterior',
    shortLabel: 'Anterior',
    description: 'Respaldo con las herramientas vigentes',
    href: '/app/master/dashboard',
    prefetch: false,
    marker: 'PA',
  },
];

function navigationItem(key: string) {
  const item = adminNavigation.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Navegacion administrativa incompleta: ${key}`);
  return item;
}

export const mobileAdminNavigation: AdminNavigationItem[] = [
  navigationItem('home'),
  navigationItem('finance'),
  navigationItem('orders'),
  {
    key: 'more',
    label: 'Ver todos los centros',
    shortLabel: 'Más',
    description: 'Todos los accesos',
    href: '/app/admin#centros',
    prefetch: false,
    marker: '•••',
  },
];
