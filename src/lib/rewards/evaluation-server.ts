import 'server-only';
import { createClient } from '@supabase/supabase-js';
// Only used AFTER requireAdminContext. Calculation storage is not an authenticated-browser API.
export function awardCalculationServer() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Falta la configuración segura del servidor para guardar el cálculo. El corte puede reintentarse sin duplicarlo.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
