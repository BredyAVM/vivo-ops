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
  {key:'payment-reports',label:'Pagos de clientes',shortLabel:'Pagos',description:'Revisar reportes por período y abrir la orden',href:'/app/admin/finanzas/pagos',prefetch:false,marker:'PA'},
  {key:'analysis',label:'Análisis comercial',shortLabel:'Análisis',description:'Ventas netas, cierres y pagos por período',href:'/app/admin/analisis',prefetch:false,marker:'AN'},
  {key:'clients',label:'Clientes',shortLabel:'Clientes',description:'Consultar, crear y editar clientes',href:'/app/admin/configuracion/clientes',prefetch:false,marker:'CL'},
  {key:'users',label:'Usuarios',shortLabel:'Usuarios',description:'Equipo, estados y permisos',href:'/app/admin/configuracion/usuarios',prefetch:false,marker:'US'},
  {key:'configuration',label:'Configuración',shortLabel:'Configurar',description:'Tasa, cuentas y tarifas',href:'/app/admin/configuracion',prefetch:false,marker:'CF'},
  {key:'notifications',label:'App y notificaciones',shortLabel:'Avisos',description:'Instalar Administración y activar avisos',href:'/app/admin/notificaciones',prefetch:false,marker:'AV'},
  {
    key: 'home',
    label: 'Inicio',
    shortLabel: 'Inicio',
    description: 'Resumen y accesos principales',
    href: '/app/admin',
    prefetch: false,
    marker: 'IN',
  },
  { key: 'operations', label: 'Operaciones', shortLabel: 'Operación', description: 'Órdenes, aprobaciones y seguimiento', href: '/app/admin/operaciones', prefetch: false, marker: 'OP' },
  { key: 'business', label: 'Negocio', shortLabel: 'Negocio', description: 'Productos, clientes y equipo', href: '/app/admin/negocio', prefetch: false, marker: 'NE' },
  { key: 'authorizations', label: 'Aprobaciones', shortLabel: 'Aprobaciones', description: 'Autorizar operaciones y consultar incidencias', href: '/app/admin/autorizaciones', prefetch: false, marker: 'AP' },
  { key: 'projections', label: 'Proyecciones', shortLabel: 'Proyecciones', description: 'Promedios semanales y escenarios de crecimiento', href: '/app/admin/proyecciones', prefetch: false, marker: 'PY' },
  {
    key: 'finance',
    label: 'Finanzas',
    shortLabel: 'Finanzas',
    description: 'Cuentas, cobros y liquidaciones',
    href: '/app/admin/finanzas',
    prefetch: false,
    marker: 'FI',
  },
  { key: 'finance-summary', label: 'Resumen financiero', shortLabel: 'Resumen', description: 'Indicadores y posición por período', href: '/app/admin/finanzas/resumen', prefetch: false, marker: 'RF' },
  {
    key: 'accounts',
    label: 'Cuentas y caja',
    shortLabel: 'Cuentas',
    description: 'Saldos, movimientos y conciliación',
    href: '/app/admin/finanzas/cuentas',
    prefetch: false,
    marker: 'CU',
  },
  {
    key: 'receivables',
    label: 'Cobranzas',
    shortLabel: 'Cobranzas',
    description: 'Órdenes, vendedores y saldos actuales',
    href: '/app/admin/finanzas/cobranzas',
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
    href: '/app/admin/ordenes',
    prefetch: false,
    marker: 'OR',
  },
  {
    key: 'inventory',
    label: 'Inventario',
    shortLabel: 'Inventario',
    description: 'Existencias, conteos y catálogo',
    href: '/app/admin/inventario',
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
    label: 'Eventos',
    shortLabel: 'Eventos',
    description: 'Cotizaciones y seguimiento',
    href: '/app/admin/eventos',
    prefetch: false,
    marker: 'EV',
  },
  {
    key: 'plays',
    label: 'Jugadas',
    shortLabel: 'Jugadas',
    description: 'Campañas y acciones comerciales',
    href: '/app/admin/jugadas',
    prefetch: false,
    marker: 'JU',
  },
  { key: 'delivery-finance', label: 'Delivery', shortLabel: 'Delivery', description: 'Costos guardados y retornos pendientes', href: '/app/admin/finanzas/delivery', prefetch: false, marker: 'DE' },
  { key: 'reports', label: 'Reportes', shortLabel: 'Reportes', description: 'Descargas y evidencia por dominio', href: '/app/admin/reportes', prefetch: false, marker: 'RE' },
  { key: 'tools', label: 'Herramientas', shortLabel: 'Herramientas', description: 'Clientes, equipo, configuración e inventario', href: '/app/admin/herramientas', prefetch: false, marker: 'HE' },
];

export function navigationItem(key: string) {
  const item = adminNavigation.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Navegacion administrativa incompleta: ${key}`);
  return item;
}

export const desktopAdminNavigationGroups = [
  { key: 'operations', label: 'Operaciones', keys: ['operations', 'orders', 'authorizations', 'active-orders'] },
  { key: 'finance', label: 'Finanzas', keys: ['finance', 'finance-summary', 'accounts', 'payment-reports', 'receivables', 'commissions', 'delivery-finance', 'analysis', 'projections', 'reports'] },
  { key: 'business', label: 'Negocio', keys: ['business', 'inventory', 'events', 'plays', 'clients', 'users', 'configuration', 'notifications', 'tools'] },
].map((group) => ({ key: group.key, label: group.label, items: group.keys.map(navigationItem) }));

export function activeAdminNavigationKey(pathname: string) {
  return adminNavigation
    .filter((item) => item.href.startsWith('/app/admin'))
    .filter((item) => pathname === item.href || (item.href !== '/app/admin' && pathname.startsWith(`${item.href}/`)))
    .sort((left, right) => right.href.length - left.href.length)[0]?.key;
}

export function activeAdminNavigationGroup(pathname: string) {
  const key = activeAdminNavigationKey(pathname);
  return desktopAdminNavigationGroups.find((group) => group.items.some((item) => item.key === key))?.key;
}

export const mobileAdminNavigation: AdminNavigationItem[] = [
  navigationItem('home'),
  navigationItem('operations'),
  navigationItem('finance'),
  navigationItem('business'),
];
