import 'server-only';
import { requireAdminContext } from '@/lib/auth';

/** A missing migration is unavailable, never an invitation to fall back to partial writes. */
export async function atomicConfigurationAvailable(): Promise<boolean> {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('admin_configuration_capabilities_v1');
  return !error && !!data && typeof data === 'object'
    && data.version === 'admin-configuration-v1' && data.atomic === true;
}
export async function requireAtomicConfiguration() {
  if (!await atomicConfigurationAvailable()) {
    throw new Error('La configuración segura está pendiente de activación. Esta operación sigue disponible en Administrador anterior.');
  }
}
