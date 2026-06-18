export type AppRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';

export type AppModuleKey = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';

export type AppModuleDefinition = {
  key: AppModuleKey;
  label: string;
  shortLabel: string;
  description: string;
  href: string;
  status: 'available' | 'planned';
  roles: AppRole[];
  recommendedDevice: string;
};

export const APP_MODULES: AppModuleDefinition[] = [
  {
    key: 'advisor',
    label: 'Asesor',
    shortLabel: 'Asesor',
    description: 'Ventas, presupuestos, pedidos propios y reportes de pago.',
    href: '/app/advisor/orders',
    status: 'available',
    roles: ['advisor'],
    recommendedDevice: 'Telefono',
  },
  {
    key: 'master',
    label: 'Master',
    shortLabel: 'Master',
    description: 'Operacion general, revision de pedidos, pagos, entregas y seguimiento.',
    href: '/app/master/dashboard',
    status: 'available',
    roles: ['master'],
    recommendedDevice: 'Computadora o tablet',
  },
  {
    key: 'admin',
    label: 'Administrador',
    shortLabel: 'Admin',
    description: 'Cuentas, cierres, usuarios, reglas y control administrativo.',
    href: '/app/master/dashboard',
    status: 'available',
    roles: ['admin'],
    recommendedDevice: 'Computadora',
  },
  {
    key: 'kitchen',
    label: 'Cocina',
    shortLabel: 'Cocina',
    description: 'Cola de preparacion, tiempos y pedidos listos.',
    href: '/app/kitchen',
    status: 'planned',
    roles: ['kitchen'],
    recommendedDevice: 'Tablet o telefono',
  },
  {
    key: 'counter',
    label: 'Counter',
    shortLabel: 'Counter',
    description: 'Mostrador, ventas presenciales, cobros y entregas en local.',
    href: '/app/counter',
    status: 'planned',
    roles: ['counter'],
    recommendedDevice: 'Computadora o tablet',
  },
  {
    key: 'driver',
    label: 'Motorizado',
    shortLabel: 'Driver',
    description: 'Pedidos asignados, rutas, entrega e incidencias.',
    href: '/app/driver',
    status: 'planned',
    roles: ['driver'],
    recommendedDevice: 'Telefono',
  },
];

export function normalizeAppRoles(value: unknown): AppRole[] {
  if (!Array.isArray(value)) return [];

  const allowed = new Set<AppRole>(['admin', 'master', 'advisor', 'kitchen', 'counter', 'driver']);
  return value.filter((role): role is AppRole => typeof role === 'string' && allowed.has(role as AppRole));
}

export function getAvailableModulesForRoles(roles: readonly string[]) {
  const roleSet = new Set(roles);
  return APP_MODULES.filter((module) => module.roles.some((role) => roleSet.has(role)));
}

export function getEnabledModulesForRoles(roles: readonly string[]) {
  return getAvailableModulesForRoles(roles).filter((module) => module.status === 'available');
}

export function getModuleByKey(key: string | null | undefined) {
  if (!key) return null;
  return APP_MODULES.find((module) => module.key === key) ?? null;
}

export function isModuleAvailableForRoles(moduleKey: string | null | undefined, roles: readonly string[]) {
  const module = getModuleByKey(moduleKey);
  if (!module || module.status !== 'available') return false;

  const roleSet = new Set(roles);
  return module.roles.some((role) => roleSet.has(role));
}

export function resolveHomePathForRoles(roles: readonly string[], preferredModuleKey?: string | null) {
  if (preferredModuleKey && isModuleAvailableForRoles(preferredModuleKey, roles)) {
    return getModuleByKey(preferredModuleKey)?.href ?? '/app';
  }

  const enabledModules = getEnabledModulesForRoles(roles);

  if (enabledModules.length === 1) {
    return enabledModules[0]?.href ?? '/app';
  }

  if (enabledModules.length > 1) {
    return '/app';
  }

  return '/app';
}
