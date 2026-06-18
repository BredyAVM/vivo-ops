import { cache } from 'react';
import { createSupabaseServer } from '@/lib/supabase/server';
import { normalizeAppRoles, resolveHomePathForRoles, type AppRole } from '@/lib/app-modules';

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>;
  user: NonNullable<
    Awaited<ReturnType<Awaited<ReturnType<typeof createSupabaseServer>>['auth']['getUser']>>['data']['user']
  >;
  roles: AppRole[];
};

export function isMasterOrAdminRole(roles: readonly string[]) {
  return roles.includes('admin') || roles.includes('master');
}

export function isAdvisorRole(roles: readonly string[]) {
  return roles.includes('advisor');
}

export function resolveHomePath(roles: readonly string[]) {
  return resolveHomePathForRoles(roles);
}

export const getAuthContext = cache(async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createSupabaseServer();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: rolesData, error: rolesError } = await supabase.rpc('get_my_roles');
  if (rolesError) {
    throw new Error(rolesError.message);
  }

  return {
    supabase,
    user,
    roles: normalizeAppRoles(rolesData),
  };
});

export async function requireAuthContext() {
  const ctx = await getAuthContext();
  if (!ctx) {
    throw new Error('No autenticado.');
  }

  return ctx;
}

export async function requireMasterOrAdminContext() {
  const ctx = await requireAuthContext();
  if (!isMasterOrAdminRole(ctx.roles)) {
    throw new Error('No autorizado.');
  }

  return ctx;
}
