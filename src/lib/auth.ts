import { createSupabaseServer } from '@/lib/supabase/server';

export type AppRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>;
  user: NonNullable<
    Awaited<ReturnType<Awaited<ReturnType<typeof createSupabaseServer>>['auth']['getUser']>>['data']['user']
  >;
  roles: AppRole[];
};

function normalizeRoles(value: unknown): AppRole[] {
  if (!Array.isArray(value)) return [];

  const allowed = new Set<AppRole>(['admin', 'master', 'advisor', 'kitchen', 'driver']);
  return value.filter((role): role is AppRole => typeof role === 'string' && allowed.has(role as AppRole));
}

export function isMasterOrAdminRole(roles: readonly string[]) {
  return roles.includes('admin') || roles.includes('master');
}

export function isAdvisorRole(roles: readonly string[]) {
  return roles.includes('advisor');
}

export function resolveHomePath(roles: readonly string[]) {
  if (isMasterOrAdminRole(roles)) return '/app/master/dashboard';
  if (isAdvisorRole(roles)) return '/app/advisor';
  return '/orders';
}

export async function getAuthContext(): Promise<AuthContext | null> {
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
    roles: normalizeRoles(rolesData),
  };
}

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
