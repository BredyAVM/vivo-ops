import {
  APP_MODULES,
  type AppModuleDefinition,
  type AppModuleKey,
  type AppRole,
  getAvailableModulesForRoles,
  getEnabledModulesForRoles,
  resolveHomePathForRoles,
} from '@/lib/app-modules';

export type { AppModuleDefinition, AppModuleKey, AppRole };

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Administrador',
  master: 'Master',
  advisor: 'Asesor',
  kitchen: 'Cocina',
  counter: 'Counter',
  driver: 'Motorizado',
};

export const ROLE_MODULES = APP_MODULES;

export function getModulesForRoles(roles: readonly string[]): AppModuleDefinition[] {
  return getAvailableModulesForRoles(roles);
}

export function getAvailableEntryModules(roles: readonly string[]): AppModuleDefinition[] {
  return getEnabledModulesForRoles(roles);
}

export function resolveRoleHomePath(roles: readonly string[], preferredModuleKey?: string | null) {
  return resolveHomePathForRoles(roles, preferredModuleKey);
}
