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
  { key: 'tasks', label: 'Pendientes', shortLabel: 'Pendientes', description: 'Revisiones por cuenta, pedido y comisión', href: '/app/admin/tareas', prefetch: false, marker: 'PD' },
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
    key: 'receivables',
    label: 'Cartera',
    shortLabel: 'Cartera',
    description: 'Cobros, vencimientos y puntualidad',
    href: '/app/admin/finanzas/cartera',
    prefetch: false,
    marker: 'CA',
  },
  {
    key: 'active-orders',
    label: 'Por entregar',
    shortLabel: 'Pedidos',
    description: 'Pedidos activos y saldo por cobrar',
    href: '/app/admin/finanzas/pedidos',
    prefetch: false,
    marker: 'PE',
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
    href: '/app/admin/finanzas/comisiones',
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
  { key: 'delivery-finance', label: 'Delivery', shortLabel: 'Delivery', description: 'Costos guardados y retornos pendientes', href: '/app/admin/finanzas/delivery', prefetch: false, marker: 'DE' },
  { key: 'reports', label: 'Reportes', shortLabel: 'Reportes', description: 'Descargas y evidencia por dominio', href: '/app/admin/reportes', prefetch: false, marker: 'RE' },
  { key: 'tools', label: 'Herramientas', shortLabel: 'Herramientas', description: 'Clientes, equipo, configuración e inventario', href: '/app/admin/herramientas', prefetch: false, marker: 'HE' },
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
    href: '/app/admin/herramientas',
    prefetch: false,
    marker: '•••',
  },
];
